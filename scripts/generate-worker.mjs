#!/usr/bin/env node
/**
 * generate-worker.mjs — headless Stage-2 generation worker (cron/worker-ready).
 *
 * Loops `cloned` rows oldest-first. For each: authors a brand-recolorable carousel
 * template with AZURE_TEXT_MODEL (vision — sees the page thumbnails), fills photos
 * (fill-image-slots), runs the contract + verify gates with a bounded repair loop,
 * ships to output/, maps the archetype, scores, rebuilds the comparison, and
 * refreshes the dashboard so status flips cloned -> success. Unfixable designs are
 * marked `failed` so the queue never gets stuck. Stops when no `cloned` rows remain.
 *
 *   node scripts/generate-worker.mjs [--once] [--max N] [--design-id ID] [--repairs N]
 *
 * Env (workspace .env): AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
 *   AZURE_OPENAI_API_VERSION, AZURE_TEXT_MODEL  (+ AZURE_IMAGE_* used by fill-image-slots).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const SCRIPTS = path.join(WORKSPACE, 'scripts');
const OUTPUT = path.join(WORKSPACE, 'output');
const REPLICAS = path.join(WORKSPACE, 'replicas');
const DESIGNS = path.join(WORKSPACE, 'designs');
const STORE = path.join(WORKSPACE, 'dashboard-store.json');
const MAP = path.join(WORKSPACE, 'archetype-map.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONCE = flag('once');
const MAX = Number(opt('max', 0)) || Infinity;
const ONE_ID = opt('design-id', null);
const MAX_REPAIRS = Number(opt('repairs', 3));
const MIN_SCORE = Number(opt('min-score', 8));   // regenerate until COMBINED score >= this (out of 10)
const GEN_ATTEMPTS = Number(opt('gens', 3));      // max full regenerations before shipping best
const PREMIUM_MIN = Number(opt('premium-min', 8)); // below this, run a judge-guided aesthetic repair
// Combined quality = deterministic gates (contract/legibility/recolor — the floor) blended with
// the vision art-director's premium score (depth/variety/hierarchy/polish — what the user judges).
const combine = (det, prem) => Math.round((det * 0.4 + prem * 0.6) * 10) / 10;

const log = (m) => console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ── env ───────────────────────────────────────────────────────────────────────
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(WORKSPACE, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return { ...out, ...process.env };
}
const env = loadEnv();

// ── provider switch: GEN_PROVIDER = codex | claude (override with --provider) ────
const PROVIDER = String(opt('provider', env.GEN_PROVIDER || 'codex')).toLowerCase();

// codex → Azure OpenAI Responses API
const AZ_ENDPOINT = (env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
const AZ_KEY = env.AZURE_OPENAI_API_KEY;
const AZ_MODEL = env.AZURE_TEXT_MODEL;

// claude → Azure AI Foundry Anthropic Messages API
const CL_ENDPOINT = (env.AZURE_ANTHROPIC_ENDPOINT || '').replace(/\/$/, '');
const CL_KEY = env.AZURE_ANTHROPIC_API_KEY;
const CL_MODEL = env.AZURE_ANTHROPIC_MODEL || 'claude-opus-4-8';

if (PROVIDER === 'claude') {
  if (!CL_ENDPOINT || !CL_KEY) { console.error('claude provider needs AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY (+ AZURE_ANTHROPIC_MODEL) in .env'); process.exit(1); }
} else if (!AZ_ENDPOINT || !AZ_KEY || !AZ_MODEL) {
  console.error('codex provider needs AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_TEXT_MODEL in .env');
  process.exit(1);
}
log(`provider: ${PROVIDER} (${PROVIDER === 'claude' ? CL_MODEL : AZ_MODEL})`);

// One entry point; both accept Responses-style input ({role, content:[{type:'input_text'|'input_image'}]}).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── proactive rate-limit pacing ────────────────────────────────────────────────
// Azure cap is 40k UNCACHED input tokens / 60s. Instead of only reacting to 429s, we track a
// rolling 60s window of input tokens and wait before a call that would breach a safe budget.
// This prevents most 429s outright (the retry below is the backstop for the rest).
const RL_WINDOW_MS = 60000;
const RL_MAX_TOKENS = 34000; // safety margin under the 40k cap
let rlHistory = []; // [{ t, tokens }]
function estimateTokens(args) {
  let chars = String(args.instructions || '').length;
  let imgTokens = 0;
  const input = Array.isArray(args.input) ? args.input : [];
  for (const m of input) {
    for (const c of m.content || []) {
      if (c.type === 'input_text' || c.type === 'text') chars += String(c.text || '').length;
      else if (c.type === 'input_image' || c.type === 'image') imgTokens += 500; // ~a slide thumb
    }
  }
  return Math.ceil(chars / 3.5) + imgTokens;
}
async function paceForRateLimit(tokens) {
  for (let guard = 0; guard < 20; guard++) {
    const now = Date.now();
    rlHistory = rlHistory.filter((e) => now - e.t < RL_WINDOW_MS);
    const used = rlHistory.reduce((s, e) => s + e.tokens, 0);
    if (!rlHistory.length || used + tokens <= RL_MAX_TOKENS) break;
    const waitMs = RL_WINDOW_MS - (now - rlHistory[0].t) + 500;
    log(`  rate-limit pacing: ${used}+${tokens} tok/60s > ${RL_MAX_TOKENS} — waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  rlHistory.push({ t: Date.now(), tokens });
}

// Retry transient API failures (429 rate limits, fetch/network blips, 5xx) with backoff so a
// recoverable error never permanently fails a design. The Azure cap is 40k input tokens / 60s,
// so a 429 waits ~65s; network errors back off exponentially.
async function respond(args) {
  await paceForRateLimit(estimateTokens(args));
  const call = () => (PROVIDER === 'claude' ? respondClaude(args) : respondCodex(args));
  let lastErr;
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      return await call();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      const is429 = /\b429\b|ratelimit/i.test(msg);
      const transient = is429 || /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|\b5\d\d\b/i.test(msg);
      if (!transient || attempt === 5) throw e;
      const waitMs = is429 ? 65000 : Math.min(30000, 2000 * 2 ** attempt);
      log(`  API ${is429 ? 'rate-limited' : 'error'}: ${msg.slice(0, 70)} — retry ${attempt + 1}/5 in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// codex: Responses API — system prompt -> `instructions`, vision via input_image.
async function respondCodex({ instructions, input, maxTokens = 16000 }) {
  const body = { model: AZ_MODEL, input, max_output_tokens: maxTokens };
  if (instructions) body.instructions = instructions;
  const r = await fetch(`${AZ_ENDPOINT}/openai/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': AZ_KEY }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`azure ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.output_text || (j.output || []).map((o) => (o.content || []).map((c) => c.text || '').join('')).join('') || '';
}

// Convert Responses-style input into Anthropic Messages content blocks.
function toAnthropic(input) {
  const arr = Array.isArray(input) ? input : [{ role: 'user', content: input }];
  return arr.map((m) => {
    const raw = Array.isArray(m.content) ? m.content : [{ type: 'input_text', text: String(m.content) }];
    const content = [];
    for (const c of raw) {
      if (c.type === 'input_text' || c.type === 'text') content.push({ type: 'text', text: c.text });
      else if (c.type === 'input_image' || c.type === 'image') {
        const u = typeof c.image_url === 'string' ? c.image_url : (c.image_url && c.image_url.url) || '';
        const mm = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(u);
        if (mm) content.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
      }
    }
    return { role: m.role || 'user', content };
  });
}

// claude: Anthropic Messages API on Azure AI Foundry — system prompt -> `system`.
async function respondClaude({ instructions, input, maxTokens = 16000 }) {
  const body = { model: CL_MODEL, max_tokens: maxTokens, messages: toAnthropic(input) };
  if (instructions) body.system = instructions;
  const r = await fetch(`${CL_ENDPOINT}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CL_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).map((b) => b.text || '').join('') || '';
}

// ── store / queue ───────────────────────────────────────────────────────────────
const readStore = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
function clonedQueue() {
  return readStore().entries
    .filter((e) => e.status === 'cloned')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
function setStatus(designId, status, lastError) {
  const s = readStore();
  const e = s.entries.find((x) => x.designId === designId);
  if (!e) return;
  e.status = status;
  if (lastError) e.lastError = String(lastError).slice(0, 300);
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
}
function setGenMetrics(designId, patch) {
  const s = readStore();
  const e = s.entries.find((x) => x.designId === designId);
  if (!e) return;
  Object.assign(e, patch);
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
}
// Update the live generation stage on the entry and rebuild the dashboard so the user sees
// progress at every step (planning → authoring → repair k → scoring → finalizing).
function setStage(designId, stage) {
  const s = readStore();
  const e = s.entries.find((x) => x.designId === designId);
  if (!e) return;
  e.genStage = stage;
  e.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
  try { execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
}
function addMap(designId, slug) {
  const m = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  m[designId] = slug;
  fs.writeFileSync(MAP, JSON.stringify(m, null, 2) + '\n');
}

// ── intake / slug ────────────────────────────────────────────────────────────────
function loadIntake(designId) {
  const ex = path.join(DESIGNS, designId, 'extract');
  const td = JSON.parse(fs.readFileSync(path.join(ex, 'template-data.json'), 'utf8'));
  const pagesDir = path.join(ex, 'assets', 'pages');
  const thumbs = fs.readdirSync(pagesDir).filter((f) => /thumbnail\.png$/.test(f)).sort()
    .map((f) => path.join(pagesDir, f));
  return { td, thumbs };
}
function slugify(title, designId) {
  let base = String(title || designId).toLowerCase()
    .replace(/instagram|carousel|post|template|design/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 3).join('-');
  if (!base) base = 'template-' + designId.slice(0, 6).toLowerCase();
  let slug = base, i = 2;
  while (fs.existsSync(path.join(OUTPUT, `${slug}.html`))) slug = `${base}-${i++}`;
  return slug;
}
const stripFences = (s) => s.replace(/^[\s\S]*?```(?:html)?\s*/i, (m) => (/```/.test(m) ? '' : m))
  .replace(/```[\s\S]*$/i, '').trim().startsWith('<') ? s.replace(/```html?\s*|\s*```/gi, '').trim()
  : s.replace(/```html?\s*|\s*```/gi, '').trim();

// The model (especially on repair) sometimes prepends its reasoning prose or appends a trailing
// note around the document. Slice to the real HTML: first <!doctype/<html> .. last </html>. This
// prevents chain-of-thought from leaking into the rendered slide (a visible correctness bug).
const extractDoc = (s) => {
  const html = stripFences(s);
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return html.trim();
  const sliced = html.slice(start);
  const end = sliced.toLowerCase().lastIndexOf('</html>');
  return (end >= 0 ? sliced.slice(0, end + '</html>'.length) : sliced).trim();
};

// ── creative planning (system prompt) ────────────────────────────────────────────
// Stage 1: study the reference purely for its STRUCTURE and THEME, then invent an
// original, premium concept with entirely new copy. Decoupled from HTML so the model
// designs the idea first instead of transcribing whatever text it can read off the
// reference images (the failure mode that produced a near-verbatim clone).
const PLANNER = `You are a senior brand designer and art director. You are shown the page images of a reference Instagram carousel, in order. Do TWO things, in order.

STEP 1 — ANALYZE THE REFERENCE'S DESIGN SYSTEM (from what you SEE, never its words):
- palette: the actual colours and their roles — background, primary, accent, text — as approximate hexes or precise names.
- type: the display-headline character (serif / grotesque / geometric / condensed / handwritten) and the body face; the type SCALE (how dominant the headline is relative to body).
- grid: margins, alignment (centered vs left), and overall DENSITY (airy vs dense/layered).
- devices: the concrete furniture it composes slides with — brush strokes, arrows, outline shapes, tabs, chips, pills, dividers, oversized numerals, bordered cards/panels, photo frames, checklists.
- per slide, its LAYOUT ARCHETYPE (e.g. cover-oversized-headline, numbered-list-card, big-stat, quote-panel, two-column, checklist, photo-with-caption, index/agenda).

STEP 2 — INVENT AN ORIGINAL, PREMIUM carousel on a topic in the same space — your own angle, your own words. Inspiration, not reproduction. Then, for EACH slide, DESIGN AN ELEVATED COMPOSITION and describe it concretely:
- Keep the reference slide's structural INTENT (its archetype and the surfaces/devices that fill it) but make it FULLER and more premium than the reference.
- VARY the layouts across slides — do NOT repeat the identical skeleton (number+headline+one line) on every content slide. Alternate: a numbered card stack, a two-column split, a big-stat block, a quote panel, a checklist, an index.
- Every CONTENT slide must anchor its body inside a real SURFACE (bordered card / filled panel / list block / stat block) that reaches into the lower third — NO dead band between the body and the footer.
- Cover and closer may be more type-forward, but still layered (a colour surface, an accent shape, a CTA pill), never a lone title on blank paper.

HARD RULES:
- NEVER reuse the reference's words, headlines, sentences, brand names, @handles, phone numbers, or placeholder text. If you can read a phrase in the reference, you may not use it.
- This includes CHROME the reference paints on every slide: a top-bar brand name (e.g. a made-up label like "BORCELLE"), social UI ("LIKE", "SAVE", "COMMENT"), page counters, @handles, and the words inside pills/buttons. None of those words may appear in your plan. Any button/pill you want is expressed as a slide's cta with YOUR OWN label.
- Write real, sharp, premium editorial copy — specific and confident, never lorem, never generic filler.
- Keep it tight so it will fit: cover headline <= ~32 chars, section headline <= ~40 chars, body <= ~140 chars, kicker/cta/label <= ~24 chars. Achieve fullness with LAYOUT and SCALE, not more words.
- Pick a fresh angle: a distinct point of view, a memorable through-line across slides, a strong closing CTA.

Return ONLY minified JSON, no prose, matching:
{"concept":"one-line premium angle","audience":"who","tone":"e.g. bold editorial","designSystem":{"palette":"colours + roles","displayType":"headline face character","bodyType":"body face","grid":"margins + alignment","density":"airy|balanced|dense and how it layers","devices":"the composing furniture, comma-separated"},"slides":[{"role":"cover|point|list|closer","archetype":"this slide's layout archetype","layout":"concrete elevated composition for THIS slide — where the headline/number/surface sit and how they fill the frame","visual":"the surface/card/graphic/numeral/decoration that anchors and fills this slide","kicker":"","title":"","body":"","cta":""}]}
Produce exactly one slides[] entry per reference page. Omit a copy field with "" when the slide's role doesn't use it, but always fill archetype/layout/visual.

OUTPUT MUST BE STRICTLY VALID JSON: minified, double-quoted keys and values, and NO raw double-quote, newline, or backslash INSIDE any string value — describe layouts in plain prose without quoting words (write it commands the frame, not it "commands" the frame). If unsure, keep the value short. A single invalid character makes the whole plan unusable.`;

// ── authoring contract (system prompt) ───────────────────────────────────────────
const SYSTEM = `You author ONE self-contained, brand-recolorable Instagram carousel HTML template. You are given an ORIGINAL creative plan (copy already written) and reference page images for LAYOUT/COMPOSITION inspiration ONLY. Realize the plan's copy in a premium design; never copy the reference's words. Output ONLY the complete HTML document (no prose, no markdown fences).

STRUCTURE CONTRACT (a template that violates this cannot generate posts):
- Root: a single <div class="ig-carousel"> containing one <section class="slide" data-cg-slide-type="..."> per page. Fixed canvas 1080x1350 per slide.
- Brand tokens: in :root declare exactly these nine, each var(--brand-*, <literal fallback>), and NEVER define a --brand-* variable yourself:
  --primary,--secondary,--accent,--bg,--surface,--text-high,--text-low,--border,--highlight. Reference the role tokens everywhere (colors), keep fixed-canvas literals (paper, ink) as fallbacks.
- Brand lockup: include <span class="brand-word">YOURBRAND</span> and <img class="brand-mark" data-brand-logo="" alt="" src="<grey svg placeholder data-uri>"/> so the brand name/logo inject.
- Semantic slots: each text element carries data-title / data-message / data-cta (and data-tagline where it fits). Exactly ONE body <p> per slide (extra prose becomes kicker/step/cta).
- Photos: a content photo is <img data-image="true" ...> with a grey svg data-uri placeholder src; the pipeline fills it. AT MOST ONE content photo per slide — bake any extra frames as CSS decoration, not <img>. If the reference is purely typographic, ship ZERO <img data-image="true"> (valid).
- Every text node lives in its OWN absolutely-positioned wrapper, with the text node itself in normal flow inside it. NEVER put !important on a text node's position/width/font-size (the editor writes those inline).
- Clamp every text run with -webkit-line-clamp, line-height >= 1.14, and a few px padding-bottom so descenders are not sheared.
- EDITOR SAFETY: every text element's content is on ONE line in the source (indent the tag, never the text) — a newline inside a text element explodes it under white-space:pre-wrap.
- Fonts: substitute the reference's faces with the closest Google Fonts (@import), import ONLY the weights you use.
- Layer order: declare stacking once; decorations below text always.

Draw COMPOSITION and object roles from the reference (where the headline sits, how a list is arranged, the visual rhythm), but the WORDS come only from the plan. Never reproduce the reference's text, brand names, @handles, or numbers. Elevate it: premium typography, confident spacing, intentional hierarchy.

BRAND & CHROME — do NOT transcribe any text you can read in the reference images:
- The brand name in a top bar is ALWAYS the lockup <span class="brand-word">YOURBRAND</span> — never a reference label like "BORCELLE".
- Do NOT paint the reference's social UI ("LIKE"/"SAVE"/"COMMENT"), its @handle, or its page counter as literal reference words. A page counter, if you want one, uses neutral digits only.
- Pill/button/CTA text comes ONLY from the plan's cta fields — never a phrase read off the reference (no "Content Creator", "Turn ideas into impact", etc.).`;

// Best-effort recovery for a plan JSON the model slightly malformed (an unescaped quote
// inside a descriptive string is the common case now that layout/visual carry prose).
function tryParsePlan(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  // Escape stray control chars and retry; if still bad, give up (caller re-requests).
  try { return JSON.parse(m[0].replace(/[\u0000-\u001f]+/g, ' ')); } catch {}
  return null;
}

// Stage 1 — study the reference images and return an original creative plan (JSON).
// The richer plan (design system + per-slide layout prose) occasionally comes back as
// invalid JSON; re-request a few times before failing the design.
async function plan({ td, thumbs, useVision = true, attempt = 1 }) {
  const brief =
    `Reference title (for topic space only, do NOT reuse its words): ${td.title || '(untitled)'}\n` +
    `Slide count: ${thumbs.length} — return exactly this many slides[].\n` +
    (attempt > 1 ? `Your previous reply was not valid JSON. Return STRICTLY valid minified JSON this time — no raw quotes/newlines inside string values.\n` : '') +
    `Study the attached reference page images for structure and mood, then invent an original premium carousel. Return ONLY the JSON.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  let raw;
  try {
    raw = await respond({ instructions: PLANNER, input: [{ role: 'user', content }] });
  } catch (err) {
    if (useVision && /unsupported|image|invalid|400/i.test(err.message)) {
      log('  plan: vision rejected — retrying text-only');
      return plan({ td, thumbs, useVision: false, attempt });
    }
    throw err;
  }
  const p = tryParsePlan(raw);
  if (!p || !Array.isArray(p.slides) || !p.slides.length) {
    if (attempt < 3) { log(`  plan: invalid JSON — re-requesting (attempt ${attempt + 1}/3)`); return plan({ td, thumbs, useVision, attempt: attempt + 1 }); }
    throw new Error('planner returned no usable JSON after 3 attempts');
  }
  if (process.env.DUMP_PLAN) { try { fs.writeFileSync(process.env.DUMP_PLAN, JSON.stringify(p, null, 2)); } catch {} }
  return p;
}

// Serialize the plan into a deck the author realizes: the analyzed design system, then
// per-slide the ORIGINAL copy PLUS the concrete elevated composition (archetype / layout /
// visual) so the author builds a varied, full, premium slide instead of a generic skeleton.
function planDeck(p) {
  const ds = p.designSystem || {};
  const dsBlock = [
    ds.palette && `  palette: ${ds.palette}`,
    ds.displayType && `  display type: ${ds.displayType}`,
    ds.bodyType && `  body type: ${ds.bodyType}`,
    ds.grid && `  grid: ${ds.grid}`,
    ds.density && `  density: ${ds.density}`,
    ds.devices && `  composing devices: ${ds.devices}`,
  ].filter(Boolean).join('\n');
  const line = (s, i) => {
    const copy = [
      s.kicker && `kicker: "${s.kicker}"`,
      s.title && `title: "${s.title}"`,
      s.body && `body: "${s.body}"`,
      s.cta && `cta: "${s.cta}"`,
    ].filter(Boolean).join(' · ');
    const design = [
      s.archetype && `archetype: ${s.archetype}`,
      s.layout && `layout: ${s.layout}`,
      s.visual && `anchor/fill: ${s.visual}`,
    ].filter(Boolean).join('\n     ');
    return `Slide ${i + 1} [${s.role || 'point'}]\n   copy: ${copy || '(decorative)'}` +
      (design ? `\n   design: ${design}` : '');
  };
  return `CONCEPT: ${p.concept || ''}\nAUDIENCE: ${p.audience || ''}\nTONE: ${p.tone || ''}\n` +
    (dsBlock ? `\nREFERENCE DESIGN SYSTEM (analyzed — match its spirit, elevated):\n${dsBlock}\n` : '') +
    `\nSLIDE PLAN — the copy is FINAL and original (use these EXACT words, never reference text); ` +
    `the design line is your composition brief for that slide — realize it, vary the layouts, fill every frame:\n${p.slides.map(line).join('\n\n')}`;
}

async function author({ td, thumbs, deck, useVision = true }) {
  const brief =
    `Author a premium, self-contained carousel HTML template that REALIZES the creative plan below in an elevated design.\n` +
    `Use the attached reference page images ONLY for LAYOUT/COMPOSITION inspiration (element placement, rhythm) — never for words.\n` +
    `Reference fonts: ${(td.fonts || []).join(', ') || 'unknown'} (substitute closest premium Google Fonts; you may choose better ones).\n` +
    `Slide count: ${thumbs.length} (produce exactly this many <section class="slide">)\n\n` +
    `=== ORIGINAL CREATIVE PLAN — copy + per-slide composition brief ===\n${deck}\n=== END PLAN ===\n` +
    `The copy is final and original — use it verbatim. Each slide's "design" line (archetype/layout/anchor) is its composition brief: build THAT layout, honor the analyzed design system, vary the slides, and fill every frame per the rules below.\n\n` +
    `MIRROR THE STRUCTURE of the gold-standard exemplar below EXACTLY: the nine :root brand tokens, the brand lockup, one <section class="slide" data-cg-slide-type> per page, EVERY text node in its own absolutely-positioned wrapper with the text in normal flow, -webkit-line-clamp on every run, single-line source text, semantic data-* slots. Your VISUAL layout takes composition cues from the reference images; the structural scaffolding is identical to the exemplar.\n\n` +
    `CRITICAL — FILL THE FRAME. Each 1080x1350 slide must feel FULL and composed edge-to-edge, like the reference: NO large empty regions, no tiny content floating in a sea of whitespace. Big, confident display type; content occupies the whole canvas with intentional margins (~64-80px), not a small cluster in one corner.\n` +
    `- Make the primary headline LARGE and dominant — a cover headline should fill most of the slide width and a big share of its height (think 120-220px display type), exactly like the reference's oversized headline. Section headlines are big too. Timid type is a failure.\n` +
    `- Distribute elements across the full height: anchor a kicker/brand near the top, the headline in the upper-middle, body/cards in the lower-middle, a footer/counter at the bottom — so the eye travels the whole slide. Balance the composition; fill negative space with scale, a card/surface panel, or a decorative accent rather than leaving it blank.\n` +
    `- BALANCE BOTH HALVES. Do NOT cluster every element on the left with a blank right side (the most common emptiness bug). The right half must carry real weight: either let the headline run nearly full-width (1080 minus margins), or place a card/surface/photo/large accent on the right. No quadrant of the slide may read as empty paper.\n` +
    `- COVER & CLOSER slides (mostly type): the headline ALONE should fill ~55-65% of the slide — huge, multi-line, spanning most of the width — plus a supporting block (kicker, a short deck line, a CTA pill, a surface panel) so it never looks like a small title floating on blank paper.\n` +
    `- KEEP THE REFERENCE'S SUPPORTING ELEMENTS as composition: if the reference balances a headline with floating pills, tags, badges, chips, numbers, or decorative shapes (often on the opposite side/corner), REPRODUCE those elements in roughly their positions — but RELABEL them with your own words from the plan (or leave decorative shapes text-free). Do NOT drop them and leave the headline alone on one side; those elements are what fill the frame. Every slide's supporting elements must span into the side the headline does not occupy.\n` +
    `- Aim for the content bounding box to cover ROUGHLY 80%+ of the slide area AND for elements to be spread across it (top / middle / bottom AND left / right), not concentrated in one corner. If a slide looks sparse, scale the type up and spread the blocks out — do not shrink to be safe.\n` +
    `- STILL ZERO overflow: fill the frame but nothing may spill or clip. Put -webkit-line-clamp on EVERY text run (headline 2-3 lines, body 3-4 lines), line-height >= 1.14, a few px padding-bottom.\n` +
    `- Copy lengths from the plan: cover headline <= ~32 chars, section headline <= ~40 chars, body <= ~140 chars — achieve fullness with SCALE and LAYOUT, not more words.\n\n` +
    `CRITICAL — ANALYZE THE REFERENCE, THEN ELEVATE IT (a flat, safe, under-designed template is a FAILURE just as much as a gate failure). First READ the attached reference images and name, to yourself, its design language: the headline type character (serif/grotesque/geometric — match its spirit), its color story, its decorative devices (brush strokes, arrows, outline shapes, tabs, chips, dots, rules), its density and alignment. Then produce a version that keeps THAT language but is MORE designed, fuller and more premium than the reference — never a plain copy, never flatter than the reference:\n` +
    `- If the reference is minimal/airy (a common Canva style), do NOT mirror its emptiness. ELEVATE it: scale the headline up, add depth (a colored surface behind the headline, a layered card/tab, a bordered panel), and turn its light decorative devices into confident composition. A minimal reference is an invitation to design, not a licence to leave blank paper.\n` +
    `- Give EVERY slide real depth and a focal anchor — layered surfaces (a labelled tab peeking from behind a card, a chip floating over a panel edge), a brand-colored surface, an accent pill/CTA, or a headline so large it commands the slide. No slide may read as plain dark text on blank paper.\n` +
    `- INTERIOR CONTENT SLIDES are where plainness creeps in: a number + headline + one body line stacked in the top two-thirds with a lone footer at the bottom leaves a dead lower band. Do NOT do this. Anchor the body inside a real surface — a bordered card, a filled panel, a numbered list block, a stat/quote block — that reaches into the lower third, so there is NO empty gap between the body and the footer. Vary the content-slide layouts (alternate the card side, mix a list slide with a two-column slide with a big-stat slide); do not repeat the identical skeleton on every slide.\n` +
    `- The headline is the hero: size it boldly and NEVER shrink the type to play safe — if it risks overflow, grow the BOX and/or shorten the copy. Match the reference's type personality but push the scale further.\n` +
    `- Reproduce the reference's decorative furniture (its brush strokes, arrows, outline shapes, dots, tabs, brackets, counters) as intentional composition, RELABELED with your own words — and if the reference puts text inside a shape (e.g. a labelled circle), your version keeps that text, never an empty shape. This designed density separates premium from a plain document.\n` +
    `- The legibility and no-clipping gates below are CONSTRAINTS you satisfy WHILE staying bold, layered and full — they are NOT licence to flatten, shrink, or over-pad. Achieve BOTH: premium + legible.\n\n` +
    `CRITICAL — RECOLORABILITY (scored by a brand-audit that swaps the palette and measures how many pixels change):\n` +
    `- EVERY themeable color — page background, surfaces/cards, accent, the highlight, headline color on a dark bg, borders, the numeral/kicker color — MUST be var(--brand-<role>, <fallback-hex>). NEVER a bare hex for these.\n` +
    `- Only pure body-copy black or white may be a literal color. Everything that gives the design its LOOK must flow from the brand tokens, exactly like the exemplar — otherwise the template fails to re-skin and scores badly.\n` +
    `- Make the accent + backgrounds visibly brand-driven so a palette swap changes a large area of every slide.\n\n` +
    `CRITICAL — LEGIBILITY (a contrast gate measures every text run against the ACTUAL pixels behind it at WCAG AA; this is the #1 first-attempt failure):\n` +
    `- EVERY text run must clear >= 4.5:1 contrast against the exact background behind it. Dark text on a light bg, or a light token on a dark/accent panel — NEVER a mid-tone on a mid-tone, never text a hair off its background, never --text-low on a colored surface.\n` +
    `- If ANY text overlaps a photo, place a solid or gradient scrim (a --surface / ink panel or a rgba overlay) behind JUST that text so it clears AA — never lay raw text straight on an unpredictable photo.\n` +
    `- For each block pick the text token whose contrast with THAT block's own background is highest: --text-high on light surfaces; a light/paper token on dark or --accent panels. Kickers, counters and CTAs count too — a low-contrast kicker fails the gate.\n\n` +
    `CRITICAL — NO CLIPPING (an overflow gate fails any run whose glyphs exceed its box OR whose real rendered line count exceeds its -webkit-line-clamp; this is the #2 first-attempt failure):\n` +
    `- Size every run so its text genuinely FITS its box: box height >= (clamp-lines x font-size x line-height) + padding. Do NOT use -webkit-line-clamp to hide overflow — the clamp count must equal what actually fits, and clamped-but-still-overflowing is a FAIL.\n` +
    `- Fit bold type by sizing the BOX to it, NOT by shrinking the type: a 40-char section headline wraps to 2-3 lines, so give it a box tall enough for 3 lines at the large size; body 3-4 lines. Leave a few px padding-bottom for descenders. Keep headlines big — grow the box, never drop the size to feel safe.\n` +
    `- Never give a text box a fixed height smaller than its clamped content — use min-height sized to the content (not empty padding — extra blank space inside a box reads as the emptiness bug). Keep every element inside the 1080x1350 canvas with ~64-80px margins; nothing may spill a slide edge.\n\n` +
    `=== GOLD-STANDARD EXEMPLAR — mirror this structure ===\n${EXEMPLAR}\n=== END EXEMPLAR ===\n\n` +
    `Return ONLY the complete HTML document.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  try {
    return extractDoc(await respond({ instructions: SYSTEM, input: [{ role: 'user', content }] }));
  } catch (err) {
    if (useVision && /unsupported|image|invalid|400/i.test(err.message)) {
      log('  vision rejected by model — retrying text-only');
      return author({ td, thumbs, deck, useVision: false });
    }
    throw err;
  }
}

// ── copy-originality guard ───────────────────────────────────────────────────
// The four gates score structure/render/recolor, none checks that the copy is
// original. Extract meaningful phrases from the reference and from the authored
// HTML; return the fraction of authored phrases that appear verbatim in the
// reference. High overlap == a clone, which we reject and re-author.
function meaningfulPhrases(text) {
  return (String(text).match(/[A-Za-z][A-Za-z'’&]+(?:\s+[A-Za-z][A-Za-z'’&]+){1,6}/g) || [])
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((s) => s.length >= 8 && !/^(the|and|for|your|you|with|this|that)\b/.test(s));
}
function referencePhrases(td) {
  // reference visible strings live in the extracted page tree; pull quoted strings.
  const raw = JSON.stringify(td.pages || td);
  const strings = (raw.match(/"[^"]{6,}"/g) || []).map((s) => s.slice(1, -1))
    .filter((s) => /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(s) && !/^[A-Za-z0-9+/=_-]{16,}$/.test(s));
  return new Set(strings.flatMap(meaningfulPhrases));
}
function copyOverlap(html, td) {
  const ref = referencePhrases(td);
  if (!ref.size) return 0;
  const body = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  const auth = [...new Set(meaningfulPhrases(body))];
  if (!auth.length) return 0;
  const hit = auth.filter((p) => ref.has(p)).length;
  return hit / auth.length;
}
// Distinctive reference tokens the phrase gate misses — invented brand names, @handles,
// SKU-like words (BORCELLE, REALLYGREATSITE). Any of these verbatim in the output is a
// dead giveaway of copying, so treat their presence as a hard originality failure.
const COMMON = new Set((
  // topical words that legitimately recur in this niche
  'start small stay consistent grow content creator become social media minimalist instagram carousel post design template black white this that your with follow next save like comment share ' +
  // CSS / style-attribute vocabulary that lives in the reference JSON but is NOT visible copy —
  // blocking these would false-reject ordinary headlines/body, so they are never "brand tokens"
  'family weight tracking kerning leading justify center normal italic bold medium regular light heavy thin ' +
  'transform uppercase lowercase capitalize paragraph pretitle title subtitle heading spacing padding margin ' +
  'absolute relative static fixed hidden block inline flex grid color background border radius opacity shadow ' +
  'width height align middle right left top bottom stretch wrap nowrap ellipsis overflow position display ' +
  // generic design/structure nouns that live in the reference JSON as element/type names, NOT
  // as brand copy — flagging these falsely rejected clean templates (e.g. "decoration")
  'decoration decorations gradient texture pattern patterns overlay overlays container wrapper element elements ' +
  'foreground rectangle ellipse circle square shape shapes vector graphic graphics image images photo photos ' +
  'frame frames layer layers group groups sticker stickers icon icons doodle doodles collage aesthetic ' +
  'minimalist modern vintage retro simple clean bold elegant playful editorial gallery layout component ' +
  'highlight highlighter marker underline divider accent surface primary secondary neutral texture ' +
  // JSON structural / layout attribute words (keys + enum values) that repeat once per element in
  // the reference tree — high freq, invisible to the reader. Flagging these false-rejected clean
  // copy (e.g. "direction", "indent" repeat 90x in a 10-slide deck). Also ordinary marketing
  // nouns the model legitimately writes (brand/brands/studio) that are NOT distinctive handles.
  'direction indent rotation baseline anchor offset opacity spacing letterspacing linespacing ' +
  'horizontal vertical brand brands brandname studio studios website websites profile profiles'
).split(/\s+/));
function referenceBrandTokens(td) {
  const raw = JSON.stringify(td.pages || td);
  const words = (raw.match(/[A-Za-z][A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase());
  // keep long tokens painted on (nearly) every slide — the reference's brand chrome / placeholder
  // handles (reallygreatsite, shodwe, maerlux...) repeat once per page. Sub-per-slide tokens are
  // NOT flagged: a broad /site|brand|studio|great/ substring test used to live here and false-failed
  // ordinary English (brands, greatest, website) — the per-slide-frequency signal is enough.
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const threshold = Math.max(3, Math.ceil((td.pageCount || 1) * 0.8));
  return new Set(
    Object.keys(freq).filter((w) => w.length >= 6 && !COMMON.has(w) && freq[w] >= threshold)
  );
}
function leakedBrandTokens(html, td) {
  const tokens = referenceBrandTokens(td);
  if (!tokens.size) return [];
  const body = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').toLowerCase();
  return [...tokens].filter((t) => new RegExp(`\\b${t}\\b`).test(body));
}

// Surgical repair: shows the model its OWN rendered slides + the exact gate failures,
// asks for a minimal targeted fix (not a rewrite — that caused the contract/verify oscillation).
async function repair({ currentHtml, failures, renders, slideCount }) {
  const parts = [{ type: 'input_text', text:
    `This carousel template FAILED gate checks. Return the COMPLETE corrected HTML.\n` +
    `Make MINIMAL, TARGETED edits to fix ONLY the listed problems — keep everything that already works; do NOT restructure passing slides (that just breaks other things).\n` +
    (slideCount ? `STRUCTURE LOCK: the template has EXACTLY ${slideCount} <section class="slide"> and MUST keep exactly ${slideCount} — never add, remove, split, or merge slides. Fill/fix WITHIN the existing slides only.\n` : '') +
    `The rendered slides are attached so you can SEE the overflow / collision / contrast.\n\n` +
    `FAILURES:\n${failures}\n\n` +
    `CURRENT HTML (photos shown as placeholders — keep the data-image slots as-is):\n${stripBase64(currentHtml).slice(0, 90000)}` }];
  for (const r of renders.slice(0, 8)) parts.push(imgPart(r));
  return extractDoc(await respond({ instructions: SYSTEM, input: [{ role: 'user', content: parts }] }));
}
const slideCount = (html) => (html.match(/class="slide"/g) || []).length;

// ── gates ─────────────────────────────────────────────────────────────────────
function runGate(script, file) {
  try {
    return { out: execSync(`node "${path.join(SCRIPTS, script)}" "${file}"`, { cwd: WORKSPACE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 }; }
}
function fillImages(file) {
  try { execSync(`node "${path.join(SCRIPTS, 'fill-image-slots.mjs')}" "${file}"`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
}
function contractViolations(out) { const m = out.match(/(\d+)\s+violation/i); return m ? Number(m[1]) : 99; }
function scoreReplica(file) { const m = runGate('score-template.mjs', file).out.match(/([\d.]+)\s*\/\s*10/); return m ? Number(m[1]) : 0; }

// ── art-director judge (vision) ──────────────────────────────────────────────────
// The deterministic gates catch broken/illegible/flat-by-metric templates but cannot
// see "premium": layered depth, layout variety, hierarchy, polish. This vision pass
// looks at the rendered slides like a harsh art director, returns a premium score that
// steers best-of-N selection, and per-slide fixes that feed an aesthetic repair pass.
const JUDGE = `You are a meticulous art director reviewing a finished Instagram carousel template against a PREMIUM, magazine-grade bar. You are shown its rendered slides in order. Judge the DESIGN, not the copy.

Score on:
- FULLNESS: each slide fills its frame — no dead space, no empty band between the content and the footer.
- DEPTH & LAYERING: real surfaces (bordered cards, filled panels, tabs, layered shapes) vs flat text on a background.
- VARIETY: content slides use DIFFERENT layouts, not the same number+headline+line skeleton repeated.
- HIERARCHY & TYPE: a dominant confident headline, clear levels, premium type pairing.
- COHESION & COLOR: one consistent system, confident use of the accent/brand colour across slides.
- POLISH: alignment, spacing, no awkward gaps, nothing unfinished (e.g. an empty outlined shape, a clipped word, a lonely title on blank paper).

Be harsh but fair: 8-10 only for genuinely premium work a brand would ship; 5-6 for flat / repetitive / airy; below 5 for broken or amateur. Most first drafts are 5-7.

Return ONLY minified JSON: {"premium":<0-10>,"strengths":["..."],"issues":[{"slide":<n>,"problem":"...","fix":"specific actionable change"}],"verdict":"one line"}`;

async function judge(renders) {
  if (!renders || !renders.length) return null;
  const content = [{ type: 'input_text', text: 'Review these rendered carousel slides, in order, against the premium bar. Return ONLY the JSON.' }];
  for (const p of renders.slice(0, 10)) content.push(imgPart(p));
  try {
    const raw = await respond({ instructions: JUDGE, input: [{ role: 'user', content }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (typeof j.premium !== 'number') return null;
    j.premium = Math.max(0, Math.min(10, j.premium));
    return j;
  } catch { return null; }
}
// Turn the judge's per-slide issues into a repair instruction block.
function judgeFailures(j) {
  if (!j || !Array.isArray(j.issues) || !j.issues.length) return '';
  return `art-director review (premium ${j.premium}/10 — raise it):\n` +
    j.issues.map((x) => `  slide ${x.slide}: ${x.problem} -> ${x.fix}`).join('\n');
}

// Gold-standard structural exemplar (a real 10/10 template, base64 stripped).
const EXEMPLAR = (() => { try { return fs.readFileSync(path.join(SCRIPTS, 'exemplar-template.html'), 'utf8'); } catch { return ''; } })();
const PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='5'><rect width='100%25' height='100%25' fill='%23c9c4bb'/></svg>";
const stripBase64 = (html) => html.replace(/data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=]+/g, PLACEHOLDER);
const imgPart = (p) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') });
// Fresh per-slide renders written by the last verify-slides run on the replica. verify
// writes to <dirname(html)>/.verify, i.e. REPLICAS/.verify during the gen loop — NOT
// OUTPUT/.verify (which only exists post-ship and was stale here, starving repair of the
// renders it is supposed to SEE).
function renderImages() {
  const dir = path.join(REPLICAS, '.verify');
  try { return fs.readdirSync(dir).filter((f) => /^slide-\d+\.png$/.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; }
}

// ── process one design ───────────────────────────────────────────────────────────
async function processOne(entry) {
  const { designId } = entry;
  const t0 = Date.now();
  let genRetries = 0; // repair passes + re-plans + discarded generations
  const { td, thumbs } = loadIntake(designId);
  const slug = slugify(td.title, designId);
  const replica = path.join(REPLICAS, `${slug}.html`);
  fs.mkdirSync(REPLICAS, { recursive: true });

  // best-of-N: each generation authors fresh, repairs to a contract-clean template,
  // scores it, and keeps the highest. Stops early once score >= MIN_SCORE; otherwise
  // ships the best candidate after GEN_ATTEMPTS and flags it as below threshold.
  const bestFile = path.join(REPLICAS, `${slug}.best.html`);
  let best = null; // { score }

  // Stage 1: invent an original creative plan from the reference (copy is written here,
  // decoupled from HTML, so the author realizes an original design instead of transcribing).
  setStage(designId, 'planning');
  let deck = planDeck(await plan({ td, thumbs }));
  log(`  plan ready — authoring original copy (deck ${deck.length} chars)`);
  const MAX_OVERLAP = 0.15; // reject a candidate that reuses >15% of the reference's phrasing
  const EXPECT = td.pageCount || thumbs.length; // slide count is locked to the reference

  for (let gen = 1; gen <= GEN_ATTEMPTS; gen++) {
    setStage(designId, `authoring (gen ${gen}/${GEN_ATTEMPTS})`);
    fs.writeFileSync(replica, await author({ td, thumbs, deck }));
    setStage(designId, `filling images (gen ${gen}/${GEN_ATTEMPTS})`);
    fillImages(replica);

    let cv = 99;
    let cand = null; // best candidate THIS gen: {cv, vFail, html} — repair can regress, so keep the best
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const contract = runGate('check-template-contract.mjs', replica);
      const verify = runGate('verify-slides.mjs', replica);
      cv = contractViolations(contract.out);
      const vFail = Number((verify.out.match(/(\d+)\s+fail/i) || [])[1] || 0);
      const cur = fs.readFileSync(replica, 'utf8');
      const sc = slideCount(cur);
      const countMiss = sc !== EXPECT ? `STRUCTURE: this template has ${sc} slides but MUST have exactly ${EXPECT} — ${sc > EXPECT ? 'merge/remove' : 'add'} slides to reach ${EXPECT}, matching the reference.\n` : '';
      const failures = `${countMiss}check-template-contract:\n${contract.out.slice(-800)}\nverify-slides:\n${verify.out.slice(-700)}`;
      // A wrong slide count is a structural defect — treat it like a contract violation for candidate ranking.
      const badCount = sc !== EXPECT ? 1 : 0;
      const cvEff = cv + badCount;
      if (!cand || cvEff < cand.cv || (cvEff === cand.cv && vFail < cand.vFail)) cand = { cv: cvEff, vFail, html: cur, failures };
      if (cv === 0 && vFail === 0 && badCount === 0) break;
      if (attempt === MAX_REPAIRS) break;
      log(`  gen ${gen} repair ${attempt + 1}/${MAX_REPAIRS} (contract ${cv}, verify fail ${vFail})`);
      genRetries++;
      setStage(designId, `repair ${attempt + 1}/${MAX_REPAIRS} (gen ${gen}, contract ${cv}, verify ${vFail})`);
      // Repair from the BEST candidate so far + ITS failures — never the latest, which a prior
      // repair may have regressed. Feeding a regressed HTML back into repair is what caused the
      // 18 -> 279 -> 297 verify-fail cascade (each repair compounded the last one's damage).
      if (cur !== cand.html) {
        // A prior repair regressed: restore the best candidate and re-render it so the images
        // repair sees match the HTML we actually hand it.
        fs.writeFileSync(replica, cand.html);
        runGate('verify-slides.mjs', replica);
      }
      fs.writeFileSync(replica, await repair({ currentHtml: cand.html, failures: cand.failures, renders: renderImages(), slideCount: EXPECT }));
      fillImages(replica);
    }
    // restore this gen's best candidate (repair may have regressed on the last attempt)
    if (cand) { fs.writeFileSync(replica, cand.html); cv = cand.cv; }

    if (cv > 0) { log(`  gen ${gen}/${GEN_ATTEMPTS}: contract still ${cv} — discarding`); genRetries++; continue; }

    // Originality gate: a structurally-perfect template that parrots the reference
    // copy is still a clone. Reject it and re-plan with a fresh angle for the next gen.
    const curHtml = fs.readFileSync(replica, 'utf8');
    const overlap = copyOverlap(curHtml, td);
    const leaks = leakedBrandTokens(curHtml, td);
    if (overlap > MAX_OVERLAP || leaks.length) {
      const why = leaks.length ? `leaked reference tokens [${leaks.join(', ')}]` : `copy ${Math.round(overlap * 100)}% reference-derived (> ${Math.round(MAX_OVERLAP * 100)}%)`;
      log(`  gen ${gen}/${GEN_ATTEMPTS}: ${why} — re-planning`);
      genRetries++;
      deck = planDeck(await plan({ td, thumbs }));
      continue;
    }

    setStage(designId, `scoring (gen ${gen}/${GEN_ATTEMPTS})`);
    let score = scoreReplica(replica);
    // Vision art-director pass — the premium signal (depth/variety/hierarchy/polish) the
    // deterministic gates are blind to. Steers selection and drives an aesthetic repair.
    setStage(designId, `art-director review (gen ${gen}/${GEN_ATTEMPTS})`);
    let j = await judge(renderImages());
    if (j && j.premium < PREMIUM_MIN) {
      log(`  gen ${gen}: premium ${j.premium}/10 — judge-guided repair`);
      genRetries++;
      const cur = fs.readFileSync(replica, 'utf8');
      fs.writeFileSync(replica, await repair({ currentHtml: cur, failures: judgeFailures(j), renders: renderImages(), slideCount: EXPECT }));
      fillImages(replica);
      const c2 = contractViolations(runGate('check-template-contract.mjs', replica).out);
      runGate('verify-slides.mjs', replica); // refresh renders for re-judge
      const rep = fs.readFileSync(replica, 'utf8');
      if (c2 === 0 && slideCount(rep) === EXPECT && !leakedBrandTokens(rep, td).length) {
        const j2 = await judge(renderImages());
        const s2 = scoreReplica(replica);
        if (j2 && combine(s2, j2.premium) > combine(score, j.premium)) { j = j2; score = s2; }
        else { fs.writeFileSync(replica, cur); fillImages(replica); }        // no gain — revert
      } else { fs.writeFileSync(replica, cur); fillImages(replica); }         // repair broke contract/count/leaked — revert
    }
    const premium = j ? j.premium : 0;
    const combined = combine(score, premium);
    log(`  gen ${gen}/${GEN_ATTEMPTS}: score ${score}/10 · premium ${premium}/10 · combined ${combined}/10 · copy ${Math.round(overlap * 100)}% ref${combined >= MIN_SCORE ? ' ✓' : ` (< ${MIN_SCORE})`}`);
    if (!best || combined > best.combined) { best = { score, premium, combined }; fs.copyFileSync(replica, bestFile); }
    if (combined >= MIN_SCORE) break;
  }

  if (!best) throw new Error(`no contract-clean candidate after ${GEN_ATTEMPTS} generations`);
  const belowThreshold = best.combined < MIN_SCORE;
  if (belowThreshold) log(`  best combined ${best.combined}/10 (score ${best.score}, premium ${best.premium}) < ${MIN_SCORE} — shipping best`);

  // ship best + register + rescore into store + comparison + refresh
  setStage(designId, 'finalizing');
  fs.copyFileSync(bestFile, path.join(OUTPUT, `${slug}.html`));
  fs.copyFileSync(bestFile, replica);
  try { fs.unlinkSync(bestFile); } catch {}
  addMap(designId, slug);
  runGate('score-template.mjs', slug);
  try { execSync(`node "${path.join(SCRIPTS, 'build-comparison.mjs')}" --design-id ${designId}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  // Record generation metrics (shown in the dashboard) before the refresh regenerates the HTML.
  // Mark success explicitly on the entry BEFORE the refresh — the ship already happened, so
  // status must not depend on the refresh succeeding.
  setGenMetrics(designId, {
    genDurationMs: Date.now() - t0, genRetries, genProvider: PROVIDER, genStage: '',
    status: 'success', lastError: '', belowThreshold,
    score: best.combined, detScore: best.score, premiumScore: best.premium,
  });
  // NON-FATAL: a refresh hiccup must never flip an already-shipped success to failed.
  try {
    execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' });
  } catch (e) {
    log(`refresh after ship failed (non-fatal): ${String(e.message).slice(0, 120)}`);
  }
  return { slug, score: best.combined, premium: best.premium, belowThreshold };
}

// ── loop ─────────────────────────────────────────────────────────────────────
// Self-heal: a prior worker killed mid-generation leaves rows stuck in 'generating', which the
// cloned queue then skips forever. On startup, return any such orphans to 'cloned' so they retry.
function healOrphans() {
  const s = readStore();
  let n = 0;
  for (const e of s.entries) if (e.status === 'generating') { e.status = 'cloned'; e.genStage = ''; n++; }
  if (n) { fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n'); log(`recovered ${n} stuck 'generating' row(s) -> cloned`); }
}

(async () => {
  healOrphans();
  let done = 0;
  while (done < MAX) {
    const q = clonedQueue();
    const next = ONE_ID ? q.find((e) => e.designId === ONE_ID) : q[0];
    if (!next) { log(q.length ? 'requested design not in cloned queue' : 'queue empty — no cloned rows left. done.'); break; }
    log(`generating ${next.designId} — "${(next.meta && next.meta.title || '').slice(0, 40)}" (${q.length} in queue)`);
    // Claim the row: flip cloned -> generating so the dashboard shows it in-flight (and, with
    // a pool of workers, so two workers never grab the same design).
    setStatus(next.designId, 'generating');
    try {
      execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' });
    } catch {}
    try {
      const r = await processOne(next);
      log(`${r.belowThreshold ? '⚠' : '✓'} ${next.designId} -> ${r.slug} (${r.score}/10)`);
    } catch (e) {
      log(`✗ ${next.designId} failed: ${e.message}`);
      setStatus(next.designId, 'failed', e.message);
    }
    done++;
    if (ONCE || ONE_ID) break;
  }
  log('worker exit.');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
