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
import { decodeGeometry, formatGeometry } from './decode-geometry.mjs';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const SCRIPTS = path.join(WORKSPACE, 'scripts');
const OUTPUT = path.join(WORKSPACE, 'output');
const REPLICAS = path.join(WORKSPACE, 'replicas');
const DESIGNS = path.join(WORKSPACE, 'designs');
const STORE = path.join(WORKSPACE, 'dashboard-store.json');
const MAP = path.join(WORKSPACE, 'archetype-map.json');
const REMIX_MAP = path.join(WORKSPACE, 'remix-map.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONCE = flag('once');
const MAX = Number(opt('max', 0)) || Infinity;
const ONE_ID = opt('design-id', null);
const SLIDE_NUM = Number(opt('slide', 0)); // >0 = author ONLY this reference page, render a preview, and stop (fast per-slide quality iteration)
// Remix needs a bigger budget than faithful: its slides start from invented copy, so they spend
// the first passes on structural fails (COVERAGE especially) and used to run out BEFORE reaching
// a clean render — which is where the recolor/stress phase kicks in. It never got there, so brand
// was never repaired and decks shipped at 1% recolor.
const MAX_REPAIRS = Number(opt('repairs', argv.includes('--remix') ? 6 : 3));
const MIN_SCORE = Number(opt('min-score', 8));   // regenerate until COMBINED score >= this (out of 10)
const GEN_ATTEMPTS = Number(opt('gens', 2));      // fresh-author fallbacks; premium now climbs via feedback, not blind re-authoring
const PREMIUM_MIN = Number(opt('premium-min', 8)); // below this, run judge-guided aesthetic repairs
const PREMIUM_ITERS = Number(opt('premium-iters', 3)); // max iterative judge-guided premium repairs per gen (feedback-driven climb)
const FAITH_ITERS = Number(opt('faith-iters', 3)); // max faithfulness vision-review + repair rounds on the best deck before ship
// --remix: study the reference, keep its design language, INVENT the content (new topic, fresh
// copy, own composition) — the same deliverable as template-remix-agent, and the default meaning
// of "generate" since 2026-07-16. WITHOUT the flag this file behaves exactly as before: faithful
// reproduction, archetype-map ship, cloned -> success. The faithful path must not regress, so the
// flag only ever SELECTS a prompt or a ship branch — it never edits the shared machinery.
const REMIX = flag('remix');
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
// Cross-process mutex, same pattern (and same lock FILE) as agent-canva-clone.mjs's
// saveDashboard — dashboard-store.json is written by clone agents, remix/author subagents,
// and this worker, often concurrently. Every one of the functions below used to read-modify-
// write with NO lock at all: a status/stage update here could silently clobber whatever another
// process wrote to a DIFFERENT entry in the tiny window between this read and this write (or
// vice versa). Locking + re-reading fresh inside the lock closes that for good.
function withStoreLock(fn) {
  const lockPath = path.join(WORKSPACE, '.dashboard.lock');
  const STALE_MS = 20000;
  const WAIT_MS = 15000;
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (Date.now() - started > WAIT_MS) throw new Error(`timed out waiting for lock: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
const readStore = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
function clonedQueue() {
  return readStore().entries
    .filter((e) => e.status === 'cloned')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
function setStatus(designId, status, lastError) {
  withStoreLock(() => {
    const s = readStore();
    const e = s.entries.find((x) => x.designId === designId);
    if (!e) return;
    e.status = status;
    if (lastError) e.lastError = String(lastError).slice(0, 300);
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
  });
}
function setGenMetrics(designId, patch) {
  withStoreLock(() => {
    const s = readStore();
    const e = s.entries.find((x) => x.designId === designId);
    if (!e) return;
    Object.assign(e, patch);
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
  });
}
// Update the live generation stage on the entry and rebuild the dashboard so the user sees
// progress at every step (planning → authoring → repair k → scoring → finalizing).
function setStage(designId, stage) {
  withStoreLock(() => {
    const s = readStore();
    const e = s.entries.find((x) => x.designId === designId);
    if (!e) return;
    e.genStage = stage;
    e.updatedAt = new Date().toISOString();
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n');
  });
  try { execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
}
function addMap(designId, slug) {
  const m = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  m[designId] = slug;
  fs.writeFileSync(MAP, JSON.stringify(m, null, 2) + '\n');
}
// A remix ships standalone: it never claims the design's archetype-map entry (that belongs to a
// faithful version, if one is ever authored), so the map is keyed slug -> designId and a design
// can carry several. reconcile in agent-canva-clone.mjs derives the dashboard row from this and
// flips the design to success once at least one remix exists.
function addRemixMap(designId, slug) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(REMIX_MAP, 'utf8')); } catch {}
  m[slug] = designId;
  const sorted = Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(REMIX_MAP, JSON.stringify(sorted, null, 2) + '\n');
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
// Visible reference copy per slide, pulled from the extracted page tree — the exact words to
// reproduce faithfully. Strips nav/social chrome and long token blobs; keeps headlines/body/labels.
function slideTexts(td) {
  const CHROME = /^(next slide|swipe|tap|like|save|comment|share|follow)\b|^@|^\d{1,2}\s*\/\s*\d{1,2}$/i;
  return (td.pages || []).map((p) => {
    const strings = (JSON.stringify(p).match(/"[^"]{2,}"/g) || [])
      .map((s) => s.slice(1, -1).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((s) => /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s) && !/^[A-Za-z0-9+/=_-]{20,}$/.test(s) && !CHROME.test(s));
    return [...new Set(strings)].join(' | ');
  });
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

// Occlusion guard (DETERMINISTIC). The author gives filled surfaces (cards/panels/shapes) a
// z-index but leaves text wrappers at the default 0, so a card paints OVER its own body text and
// the block renders empty — a faithful-repro failure the gates don't catch (contrast is measured
// against the text's assigned bg, not the surface covering it). This forces every semantic text
// slot above any surface, regardless of the classes the author chose. .tn text wrappers carry
// z-index:auto so they do NOT form a stacking context — a z-index on the text node competes
// globally and wins over the surfaces (which top out around z-index 6).
const ensureTextAboveSurfaces = (html) => {
  if (!html || html.includes('occlusion-guard')) return html;
  const rule = `\n/* occlusion-guard: semantic text slots always render above filled surfaces */\n` +
    `[data-title],[data-message],[data-cta],[data-tagline],[data-step],[data-kicker]{position:relative;z-index:30;}\n`;
  const i = html.lastIndexOf('</style>');
  return i < 0 ? html : html.slice(0, i) + rule + html.slice(i);
};

// ── faithful transcription (system prompt) ───────────────────────────────────────
// Stage 1: study the reference and TRANSCRIBE it faithfully — its exact copy (split into
// roles) and its per-slide layout — so the author can rebuild the SAME template as clean,
// recolorable HTML. We reproduce the reference, we do not reinvent it (inventing an original
// premium design scored badly and inconsistently; faithful reproduction of a proven design
// is what works). Copy is placeholder scaffolding swapped per brand at use time.
const PLANNER = `You are a meticulous production designer. You are shown the page images of a reference Instagram carousel, in order, plus the exact text extracted from each page. TRANSCRIBE the reference faithfully so it can be rebuilt as a clean, recolorable template — do NOT redesign it.

STEP 1 — ANALYZE THE DESIGN SYSTEM (from what you SEE):
- palette: the actual colours and their roles — background, primary, accent, text — as approximate hexes or precise names.
- type: the display-headline character (serif / grotesque / geometric / condensed / handwritten) and the body face; the type SCALE (how dominant the headline is).
- grid: margins, alignment (centered vs left), and overall DENSITY (airy vs dense/layered).
- devices: the concrete furniture each slide composes with — brush strokes, arrows, outline shapes, tabs, chips, pills, dividers, oversized numerals, bordered cards/panels, photo frames, checklists.

STEP 2 — TRANSCRIBE EACH SLIDE FAITHFULLY. For every reference page, capture:
- its EXACT copy, split into roles (kicker / title / body / cta): use the reference's real words verbatim (the provided extracted text is authoritative; fix obvious OCR gaps from the image). Reproduce — do NOT invent, rephrase, or "improve" the copy.
- its LAYOUT ARCHETYPE (e.g. cover-oversized-headline, numbered-list-card, big-stat, quote-panel, two-column, checklist, photo-with-caption, index) and a concrete description of how the slide is composed: where the headline / number / surface / photo sit, the alignment, and how the elements fill the frame — matching the reference as closely as you can.

RULES:
- Reproduce the reference's copy and composition. This is a faithful rebuild, not a reinterpretation. Match the reference's density: if a slide is minimal, keep it minimal; if dense, keep it dense.
- EXCLUDE only non-content chrome: the source's brand name/logo (becomes a neutral lockup), social UI ("LIKE"/"SAVE"/"COMMENT"), @handles, swipe/next prompts, and page counters. Everything else — headlines, body, labels, CTAs — is reproduced verbatim.
- Keep each field to what actually fits the slide; do not pad.

Return ONLY minified JSON, no prose, matching:
{"designSystem":{"palette":"colours + roles","displayType":"headline face character","bodyType":"body face","grid":"margins + alignment","density":"airy|balanced|dense","devices":"the composing furniture, comma-separated"},"slides":[{"role":"cover|point|list|closer","archetype":"this slide's layout archetype","layout":"how this slide is composed, matching the reference — where the headline/number/surface sit","kicker":"","title":"","body":"","cta":""}]}
Produce exactly one slides[] entry per reference page. Omit a copy field with "" when the slide doesn't use it, but always fill archetype/layout.

OUTPUT MUST BE STRICTLY VALID JSON: minified, double-quoted keys and values, and NO raw double-quote, newline, or backslash INSIDE any string value. If unsure, keep the value short. A single invalid character makes the whole plan unusable.`;

// ── remix planner (--remix) ──────────────────────────────────────────────────────
// Same JSON shape as PLANNER (planDeck consumes it unchanged) plus topic/slug, since a remix
// names itself off the topic it invents rather than the reference's title. STEP 1 is identical
// in spirit — read the design system — but STEP 2 inverts: invent the content instead of
// transcribing it. Copying the reference's words is the failure mode this whole mode exists to
// avoid (a run that shipped "BORCELLE"/"@REALLYGREATSITE" scored 8.2 and was still a clone).
const PLANNER_REMIX = `You are an art director. You are shown the page images of a reference Instagram carousel, in order, plus the text extracted from each page. Work out WHY the reference works, then design a NEW carousel in the same design family — your own topic, your own words.

STEP 1 — ANALYZE THE DESIGN SYSTEM (from what you SEE):
- palette: the actual colours and their roles — background, primary, accent, text — as approximate hexes.
- displayType / bodyType: the character of the type (e.g. tall condensed serif, geometric sans), and the scale contrast between headline and body.
- grid: margins, alignment, where things sit.
- density: airy | balanced | dense — match the reference's.
- devices: the composing furniture that gives it its look — highlight bars, tinted cards, hard offset shadows, rules, chips, tabs, oversized numerals, line-art marks. THESE are the design language: keep them.

STEP 2 — INVENT THE CONTENT. Choose ONE topic that suits this design's audience and tone but is NOT the reference's topic. Then write every slide yourself:
- Real copy with a point of view — specific, concrete, worth reading. Not lorem, not generic filler ("Lorem ipsum", "Tips for success", "Boost your productivity").
- Give each slide its own composition, following the reference's archetype for that position (cover / point / list / closer) and its density.
- topic: one line naming what this deck is about. slug: a 3-word kebab-case name derived from the topic (e.g. write-better-emails, the-drawn-line).

RULES:
- NEVER reuse the reference's words, headlines, brand names, @handles, phone numbers or placeholder text. If a sentence could be lifted from the reference, rewrite it.
- Recognisably the same design family, but its own piece — keep the craft and devices, replace the content.
- Match the reference's slide count and per-slide density. If a slide is minimal, keep it minimal; if dense, keep it dense.
- No social UI ("LIKE"/"SAVE"/"COMMENT"), no @handles, no swipe prompts, no page counters in the copy.
- Keep each field to what actually fits the slide; do not pad.

Return ONLY minified JSON, no prose, matching:
{"topic":"what this deck is about","slug":"three-word-kebab","designSystem":{"palette":"colours + roles","displayType":"headline face character","bodyType":"body face","grid":"margins + alignment","density":"airy|balanced|dense","devices":"the composing furniture, comma-separated"},"slides":[{"role":"cover|point|list|closer","archetype":"this slide's layout archetype","layout":"how this slide is composed — where the headline/number/surface sit","kicker":"","title":"","body":"","cta":""}]}
Produce exactly one slides[] entry per reference page. Omit a copy field with "" when the slide doesn't use it, but always fill archetype/layout.

OUTPUT MUST BE STRICTLY VALID JSON: minified, double-quoted keys and values, and NO raw double-quote, newline, or backslash INSIDE any string value. If unsure, keep the value short.`;

// ── authoring contract (system prompt) ───────────────────────────────────────────
const SYSTEM = `You rebuild ONE self-contained, brand-recolorable Instagram carousel HTML template that FAITHFULLY REPRODUCES a reference carousel. You are given the reference's transcribed copy + per-slide layout and its page images. Reproduce the reference's layout, composition, and copy as closely as you can, as clean recolorable HTML. Do NOT redesign, elevate, or invent — match the reference. Output ONLY the complete HTML document (no prose, no markdown fences).

STRUCTURE CONTRACT (a template that violates this cannot generate posts):
- Root: a single <div class="ig-carousel"> containing one <section class="slide" data-cg-slide-type="..."> per page. Fixed canvas 1080x1350 per slide. A carousel needs AT LEAST TWO .slide sections — the backend parser throws ("Template has too few slides") on a 1-slide deck, so it would seed and then fail at generation. A genuinely single-page design belongs in the single-image kind, not here.
- PAGE COUNTERS must agree with the real slide count. A baked "01 / 05" whose denominator does not equal the number of .slide sections is HARD-REJECTED by the backend ("baked slide-count denominator(s) ... disagree with the actual slide count"). If the deck has 7 slides the counter reads "of 07". Either keep every counter's total in sync, or omit counters entirely — never leave a stale one from an earlier draft. (A semantic counter that is NOT a page counter, e.g. "Tip 1 of 5" across a 7-slide deck, is fine and is deliberately not matched: the backend only flags a ZERO-PADDED numerator like "01 / 05".)
- Brand tokens: in :root declare exactly these nine, each var(--brand-*, <literal fallback>), and NEVER define a --brand-* variable yourself:
  --primary:var(--brand-primary,<hex>); --secondary:var(--brand-secondary,<hex>); --accent:var(--brand-accent,<hex>);
  --bg:var(--brand-bg,<hex>); --surface:var(--brand-surface,<hex>); --text-high:var(--brand-ink,<hex>); --text-low:var(--brand-text-muted,<rgba>);
  --border:var(--brand-border,<rgba>); --highlight:var(--brand-accent,<hex>) — NEVER --brand-highlight, that variable does not exist and the token would never re-brand.
  These are the ONLY nine brand-derivation pairs — do not invent a different intermediate --brand-* name for any of them. Reference the role tokens everywhere (colors), keep fixed-canvas literals (paper, ink) as fallbacks.
- Brand lockup: include <span class="brand-word">YOURBRAND</span> and <img class="brand-mark" data-brand-logo="" alt="" src="<grey svg placeholder data-uri>"/> so the brand name/logo inject.
- Semantic slots: each text element carries data-title / data-message / data-cta (and data-tagline where it fits). Exactly ONE body <p> per slide (extra prose becomes kicker/step/cta).
- Photos: a content photo is <img data-image="true" ...> with a grey svg data-uri placeholder src; the pipeline fills it. AT MOST ONE content photo per slide — bake any extra frames as CSS decoration, not <img>. If the reference is purely typographic, ship ZERO <img data-image="true"> (valid).
- Every text node lives in its OWN absolutely-positioned wrapper, with the text node itself in normal flow inside it. NEVER put !important on a text node's position/width/font-size (the editor writes those inline).
- Clamp every text run with -webkit-line-clamp, line-height >= 1.14, and a few px padding-bottom so descenders are not sheared.
- EDITOR SAFETY: every text element's content is on ONE line in the source (indent the tag, never the text) — a newline inside a text element explodes it under white-space:pre-wrap.
- Fonts: substitute the reference's faces with the closest Google Fonts (@import), import ONLY the weights you use.
- Layer order: declare stacking once; decorations below text always.
- INLINE SVG is for VECTOR GRAPHICS ONLY (icons, blobs, dividers, marks). (a) NEVER put readable copy — numerals, headlines, labels — inside <svg><text>: SVG text does not reliably repaint when a webfont loads late (very likely when the editor opens many iframes at once) and STICKS in the fallback font permanently. Put every readable glyph in an HTML element (div/span/h1) and do any decorative treatment with CSS on it — background-clip:text, -webkit-text-stroke (for hollow/outline numerals), mask-image — never by moving the text into SVG. (b) EVERY <svg> root carries data-cg-svg, data-cg-preserve, aria-hidden="true", AND focusable="false" (e.g. <svg data-cg-svg data-cg-preserve aria-hidden="true" focusable="false" viewBox="...">): data-cg-svg makes it editable in the playground, data-cg-preserve keeps it byte-identical through the backend (cheerio HTML-mode otherwise lowercases viewBox→viewbox and corrupts the vector), aria-hidden+focusable are required a11y attrs the backend's own SVG lint checks for.
- SVG PAINT — the #1 SVG rejection cause, read carefully: inner geometry (path/circle/rect/etc.) paints ONLY via presentation attributes referencing TWO custom properties declared on the OUTER <svg>: fill="var(--cg-fill)" and/or stroke="var(--cg-stroke)". On the outer <svg> tag itself (inline style="--cg-fill:var(--primary);--cg-stroke:var(--primary)" or a CSS class rule declaring them — either is valid), set --cg-fill/--cg-stroke to ONE of the existing role tokens (var(--primary), var(--secondary), var(--accent), var(--text-high), etc — never --brand-* directly, never a literal hex/rgb/hsl). NEVER: fill="currentColor" or stroke="currentColor" on inner geometry (the backend's lint hard-rejects this at seed time), a literal hex/rgb/hsla fill or stroke on inner geometry, --cg-fill/--cg-stroke itself set to a literal color or a --brand-* variable, or ANY inline style= attribute on an inner node (style is allowed ONLY on the outer <svg> tag — the backend's sanitizer silently strips style from every other node, so styling that way just loses the paint). NEVER an SVG <filter>/<feGaussianBlur>/<feTurbulence> element — the backend hard-strips <filter> with its contents. For a soft-blur look, use CSS filter:blur(Npx) in the outer <svg>'s own style/class (never inside the SVG markup itself, never via url()). For grain/texture, skip it — there is no compliant SVG equivalent; use a plain color-mix() tint instead.

Reproduce the reference's composition per slide: the same layout, the same copy in the same roles, the same decorative devices in roughly their positions and sizes. Map the reference's actual colours onto the brand tokens so a palette swap re-skins it. The result should read as the SAME template, cleanly rebuilt and recolorable — not a new design, not "elevated", not flatter or busier than the reference.

CHROME — reproduce the content, neutralize only the source's identity:
- The reference's brand name in a top bar becomes the lockup <span class="brand-word">YOURBRAND</span> — never the source label (e.g. "BORCELLE").
- Drop the reference's social UI ("LIKE"/"SAVE"/"COMMENT"), its @handle, and its swipe/next prompt. A page counter, if the reference has one, uses neutral digits.
- Reproduce every OTHER text run — headlines, body, kickers, CTAs, labels — verbatim from the transcription.`;

// ── remix authoring contract (--remix) ───────────────────────────────────────────
// DERIVED from SYSTEM, not copied: only the four faithful instructions are swapped, so the
// structure contract (brand tokens, lockup, data-* slots, fixed canvas) stays shared and cannot
// drift between the two modes. A missed replacement throws at startup rather than silently
// shipping a faithful prompt under --remix.
const SYSTEM_REMIX = (() => {
  const swaps = [
    [
      'You rebuild ONE self-contained, brand-recolorable Instagram carousel HTML template that FAITHFULLY REPRODUCES a reference carousel. You are given the reference\'s transcribed copy + per-slide layout and its page images. Reproduce the reference\'s layout, composition, and copy as closely as you can, as clean recolorable HTML. Do NOT redesign, elevate, or invent — match the reference. Output ONLY the complete HTML document (no prose, no markdown fences).',
      'You author ONE self-contained, brand-recolorable Instagram carousel HTML template INSPIRED BY a reference carousel. You are given a plan (its invented topic + per-slide copy and composition) and the reference\'s page images. Build the plan as premium, recolorable HTML in the reference\'s design family: keep its craft — type character, scale contrast, grid, density and composing devices — while realizing the plan\'s own content. Recognisably the same family, but its own piece. Output ONLY the complete HTML document (no prose, no markdown fences).',
    ],
    [
      'Reproduce the reference\'s composition per slide: the same layout, the same copy in the same roles, the same decorative devices in roughly their positions and sizes. Map the reference\'s actual colours onto the brand tokens so a palette swap re-skins it. The result should read as the SAME template, cleanly rebuilt and recolorable — not a new design, not "elevated", not flatter or busier than the reference.',
      'Compose each slide per the plan, in the reference\'s design language: its type character and scale contrast, its grid and margins, its density, and its composing devices (highlight bars, tinted cards, offset shadows, rules, chips, oversized numerals).\n' +
        'FILL THE FRAME. A content slide is NEVER just a headline and a paragraph floating on a plain background — that is the single most common failure and it fails the coverage gate. Every content slide carries the reference\'s furniture: a card or panel behind the body, a highlight bar or rule on the headline, a numeral/chip/kicker anchoring the corner. No band of roughly a third of the slide\'s height may sit empty; enlarge the headline, add the surface, or spread the composition until the frame is used.\n' +
        'RECOLOR IS NOT OPTIONAL. Every colour that carries the design — headline ink, accent bars/chips/cards, rules, CTA fills, numerals — is a brand token (var(--primary), var(--accent), var(--surface), var(--highlight), var(--text-high) ...), NEVER a literal hex. Only the fixed canvas (paper/background) may stay literal. A deck whose accent is a hardcoded colour fails the recolor audit even when it looks right.\n' +
        'GIVE --primary/--accent REAL AREA AS FILLS, on every slide. The audit re-skins the deck by changing ONLY those two and scores the share of pixels that move: >=3% deck average, >=1.5% per slide. A thin rule and a small chip do not reach it. So each slide needs a substantial FILLED element carrying the token: a headline highlight bar, a filled card/panel behind the body, a solid CTA button, a coloured band or block. Area = a painted SURFACE, never coloured glyphs.\n' +
        'TOKEN DISCIPLINE (this is where legibility fails — a real intake held 18 slides for exactly this): --accent is for DECORATIVE FILLS ONLY, never for text. Coloured TEXT on the pale canvas must route through --primary, which stays DARK across every brand palette; accent-orange text on a cream bg is ~2.3:1 and fails AA before any swap. Text that sits ON an accent/primary fill uses the on-fill light token (--on-accent / --on-primary, white), never the canvas ink. Numerals, kickers and CTAs are TEXT — colour them --primary or put them on a filled surface with the on-fill token; never paint them --accent on bare canvas. Declare --on-fill:var(--brand-on-accent,#fff) and --on-primary:var(--brand-on-primary,#fff) in :root alongside the nine (the passing templates all do), so text on a filled surface stays legible after a brand swap turns the accent light.\n' +
        'SAME-SOURCE COLLISION — the trap that hides until a brand is applied: --accent and --highlight BOTH derive from --brand-accent. Giving them different FALLBACK hexes makes them look different in your own render, then collapse to the SAME colour the instant a real brand supplies --brand-accent — 1.00:1, invisible text. So NEVER colour text --highlight on a surface filled with --accent (or vice versa). Text on an accent/highlight fill uses --on-fill, always. The same applies to any two tokens sharing a --brand-* source. Your own preview passing proves nothing here; assume every token pair that shares a source WILL be identical.\n' +
        'SCRIMS MUST WORK ON ANY PHOTO, not the one you author with. The pipeline fills <img data-image="true"> slots, and downstream the platform REPLACES that photo per post — a scrim tuned to your dark authored image leaves text at ~2:1 over a lighter replacement. So any text over a photo needs a scrim that still clears AA if the photo were near-white: keep the gradient at roughly >=0.45 opacity everywhere text actually sits, not just at the edges. A gradient that fades to transparent mid-slide is exactly where headlines land and exactly where it fails.\n' +
        'MEASURE, DO NOT ASSERT. Every text run must clear AA against the ACTUAL surface behind it (>=4.5:1 body, >=3:1 large): never fix ink to white unless the surface under it is guaranteed dark (a white or light gradient stop makes white ink invisible), and on a dark photo scrim use a light on-scrim token, not the canvas dark ink.\n' +
        'Map the reference\'s actual colours onto those tokens so a palette swap re-skins it. The result should read as a sibling of the reference — same craft, its own content and composition. Never flatter or plainer than the reference.',
    ],
    [
      'CHROME — reproduce the content, neutralize only the source\'s identity:',
      'CHROME — the copy is the plan\'s, and the source\'s identity never appears:',
    ],
    [
      '- Reproduce every OTHER text run — headlines, body, kickers, CTAs, labels — verbatim from the transcription.',
      '- Use the plan\'s copy for every text run — headlines, body, kickers, CTAs, labels. NEVER the reference\'s words, brand names, @handles or placeholder text ("BORCELLE", "@REALLYGREATSITE", "reallygreatsite.com"): a deck that reuses them is a clone and fails, however good it scores.',
    ],
  ];
  let s = SYSTEM;
  for (const [from, to] of swaps) {
    if (!s.includes(from)) throw new Error(`--remix: SYSTEM changed, cannot derive SYSTEM_REMIX (missing: ${from.slice(0, 60)}…)`);
    s = s.replace(from, to);
  }
  // Appended, not swapped: SYSTEM says nothing about copy growth beyond clamping, so decks lay
  // out against their own exact wording and every slot collides once the stress gate refills them
  // (9 TEXT-COLLISIONs on the first passing remix — a decorative "?" landing on the headline,
  // body text reaching the numeral). Remix-only, so the faithful path stays byte-identical.
  s += `

COPY GROWTH — this is a TEMPLATE, not a poster: every text slot gets REPLACED by generated copy that may run ~1.5x longer than yours, and a layout that only works at your exact wording fails.
- Lay blocks out in normal flow with real spacing, so a longer headline PUSHES what follows instead of overlapping it. Absolute positioning is for the canvas furniture (bars, cards, marks), not for stacking text blocks on top of each other.
- Never place a decorative numeral, mark, badge or glyph where a growing headline or body can reach it. Give it its own column, corner or margin — text over text is an automatic failure.
- That includes a GHOST/WATERMARK NUMERAL behind the headline. It looks deliberate at your wording and still fails: the gate counts any glyph overlapping a text box as a collision, and a longer headline buries it. Want the oversized numeral? Put it BESIDE the headline in its own column, or in a margin/corner the text never reaches — clear of every text box, not behind one.
- Reserve room for the longest plausible line: size each slot for its clamp, not for the string you happened to write.`;
  return s;
})();

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
  const texts = slideTexts(td);
  const brief =
    `Reference title: ${td.title || '(untitled)'}\n` +
    `Slide count: ${thumbs.length} — return exactly this many slides[].\n` +
    (attempt > 1 ? `Your previous reply was not valid JSON. Return STRICTLY valid minified JSON this time — no raw quotes/newlines inside string values.\n` : '') +
    `Extracted text per page (authoritative copy to reproduce verbatim; fix only obvious gaps from the image):\n` +
    texts.map((t, i) => `  page ${i + 1}: ${t || '(no text — decorative slide)'}`).join('\n') + `\n` +
    `Study the attached reference page images and TRANSCRIBE each slide faithfully (exact copy in roles + its layout). Return ONLY the JSON.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  let raw;
  try {
    raw = await respond({ instructions: REMIX ? PLANNER_REMIX : PLANNER, input: [{ role: 'user', content }] });
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
  return (dsBlock ? `REFERENCE DESIGN SYSTEM (analyzed — reproduce it):\n${dsBlock}\n` : '') +
    `\nSLIDE PLAN — the copy is transcribed from the reference; reproduce these EXACT words in the given roles, ` +
    `and build each slide's described layout to MATCH the reference (do not vary, elevate, or pad):\n${p.slides.map(line).join('\n\n')}`;
}

async function author({ td, thumbs, deck, useVision = true, sight = null }) {
  // sight = { renders:[per-slide PNGs of the model's OWN previous attempt], defects:"<review text>" }.
  // When present, this is a RE-AUTHOR FROM SIGHT: the model sees its last render beside the reference
  // and redoes the whole deck coherently — a holistic redo, not a local patch. This is what closes
  // most of the gap to hand-authoring (a human re-composes from what they see; it doesn't dab).
  // Exact per-element type sizes decoded from the source (font-size + box w/h + verbatim text).
  // These are authoritative and stop the author oversizing type it would otherwise eyeball off a
  // flat screenshot — the #1 faithful-repro defect (clipping + overlapping headlines).
  let geom = '';
  try { geom = formatGeometry(decodeGeometry(td)); } catch { geom = ''; }
  const brief =
    `Rebuild the reference carousel below as a faithful, recolorable HTML template. Reproduce its layout, composition, and copy — MATCH the reference; do NOT redesign, elevate, or invent.\n` +
    `The attached reference page images are the LAYOUT ground truth (element placement, sizes, alignment, rhythm); the transcription below is the exact COPY.\n` +
    `Reference fonts: ${(td.fonts || []).join(', ') || 'unknown'} (substitute the closest Google Fonts).\n` +
    `Slide count: ${thumbs.length} (produce exactly this many <section class="slide">)\n\n` +
    `=== REFERENCE TRANSCRIPTION — copy + per-slide layout ===\n${deck}\n=== END ===\n` +
    `Reproduce each slide's copy VERBATIM in the roles given, positioned and sized to match the reference image. Keep the reference's decorative devices (numerals, cards, pills, shapes, rules, dividers) in their positions.\n\n` +
    (geom ? `=== EXACT TYPE SIZES (authoritative — decoded from the source document; USE THESE, do not guess sizes) ===\n${geom}\n=== END ===\n` +
      `Set each text run's font-size and box width/height to these decoded values — they are the REAL source sizes, and using them is how you avoid oversizing type that clips the canvas edge or overlaps another element. Each listed element is ONE box (e.g. a two-word headline is a single box, not two overlapping ones). The absolute x/y POSITION of each element comes from the reference IMAGE (the decoded positions are approximate); the font-size and box width/height here are EXACT.\n\n` : '') +
    `MIRROR THE STRUCTURE of the gold-standard exemplar below EXACTLY: the nine :root brand tokens, the brand lockup, one <section class="slide" data-cg-slide-type> per page, EVERY text node in its own absolutely-positioned wrapper with the text in normal flow, -webkit-line-clamp on every run, single-line source text, semantic data-* slots. The exemplar governs the STRUCTURAL scaffolding; the reference images govern the VISUAL layout.\n\n` +
    `CRITICAL — FIDELITY (match the reference, do not deviate):\n` +
    `- Reproduce each slide's composition as the reference has it: the same headline size and placement, the same body position, the same devices in the same spots. Do NOT enlarge, shrink, add, remove, or rearrange elements relative to the reference.\n` +
    `- Match the reference's DENSITY exactly: if a slide is minimal/airy, KEEP that whitespace — do NOT fill it with invented surfaces, panels, or decoration; if it is dense/layered, reproduce that density. The reference is the target, not a floor to beat.\n` +
    `- Keep the reference's alignment and margins (roughly 64-80px unless the reference is tighter/looser). Use the reference's real colours, mapped onto the brand tokens.\n` +
    `- Follow the transcription's copy exactly — do not pad, trim, or rephrase the reference's words.\n\n` +
    `CRITICAL — RECOLORABILITY (scored by a brand-audit that swaps the palette and measures how many pixels change):\n` +
    `- EVERY themeable color — page background, surfaces/cards, accent, the highlight, headline color on a dark bg, borders, the numeral/kicker color — MUST be var(--brand-<role>, <fallback-hex>). NEVER a bare hex for these.\n` +
    `- Only pure body-copy black or white may be a literal color. Everything that gives the design its LOOK must flow from the brand tokens, exactly like the exemplar — otherwise the template fails to re-skin and scores badly.\n` +
    `- Make the accent + backgrounds visibly brand-driven so a palette swap changes a large area of every slide.\n\n` +
    `CRITICAL — LEGIBILITY (a contrast gate measures every text run against the ACTUAL pixels behind it at WCAG AA; this is the #1 first-attempt failure):\n` +
    `- EVERY text run must clear >= 4.5:1 contrast against the exact background behind it. Dark text on a light bg, or a light token on a dark/accent panel — NEVER a mid-tone on a mid-tone, never text a hair off its background, never --text-low on a colored surface.\n` +
    `- If ANY text overlaps a photo, place a solid or gradient scrim (a --surface / ink panel or a rgba overlay) behind JUST that text so it clears AA — never lay raw text straight on an unpredictable photo.\n` +
    `- For each block pick the text token whose contrast with THAT block's own background is highest: --text-high on light surfaces; a light/paper token on dark or --accent panels. Kickers, counters and CTAs count too — a low-contrast kicker fails the gate.\n\n` +
    `CRITICAL — NO CLIPPING / NO COLLISION (an overflow gate fails any run whose glyphs exceed its box, spill the 1080x1350 canvas, OR whose real rendered line count exceeds its -webkit-line-clamp; a collision gate fails overlapping blocks — these were the top failures):\n` +
    `- Text must FIT. Match the reference's type size, but if a run would clip its box, run past the canvas edge, or overlap another block, SHRINK the font-size until it fits — FITTING BEATS BIG. A clipped, off-canvas, or colliding headline is a hard FAIL. Never oversize type to "fill" the slide.\n` +
    `- Horizontal fit especially: the LONGEST word must fit within the slide width at its font-size — a long headline like "Storytelling" must not run off the right edge. Reduce the size or let it wrap; never let glyphs spill the 1080px width.\n` +
    `- Size each box to its text: box height >= (clamp-lines x font-size x line-height) + padding; a few px padding-bottom for descenders. Keep every element inside the 1080x1350 canvas with ~64-80px margins; nothing may spill a slide edge or overlap the footer, a card, a pill, or another headline.\n\n` +
    `=== GOLD-STANDARD EXEMPLAR — mirror this structure ===\n${EXEMPLAR}\n=== END EXEMPLAR ===\n\n` +
    (sight && sight.defects
      ? `\n=== RE-AUTHOR FROM SIGHT ===\nBelow, after each REFERENCE image, is YOUR OWN previous attempt's RENDER of that slide. It has these defects:\n${sight.defects}\nAuthor a COMPLETE NEW document that reproduces the reference faithfully and fixes every defect. RE-COMPOSE freely — do not merely nudge the old version; author each slide cleanly as a whole so nothing collides, nothing is hidden behind a surface, no text clips or runs off-canvas, and no fake social chrome (LIKE/SAVE/SHARE/HASHTAGS) appears. Keep what already matched the reference.\n`
      : '') +
    `Return ONLY the complete HTML document.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) {
    if (sight && Array.isArray(sight.renders) && sight.renders.length) {
      const n = Math.min(thumbs.length, 10);
      for (let i = 0; i < n; i++) {
        content.push({ type: 'input_text', text: `Slide ${i + 1} — REFERENCE:` });
        content.push(imgPart(thumbs[i]));
        if (sight.renders[i]) {
          content.push({ type: 'input_text', text: `Slide ${i + 1} — YOUR PREVIOUS RENDER:` });
          content.push(imgPart(sight.renders[i]));
        }
      }
    } else {
      for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
    }
  }
  try {
    return ensureTextAboveSurfaces(extractDoc(await respond({ instructions: REMIX ? SYSTEM_REMIX : SYSTEM, input: [{ role: 'user', content }] })));
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

// Recolor + stress failures. These two gates only ran inside score-template AFTER ship, so a
// deck that hardcoded its colours (brand-audit 1% instead of 17-21%) or blew up on worst-case
// copy was measured and shipped anyway — 3 of the 4 points a bad deck loses were never repaired.
// They cost a browser launch each, so the caller runs them only once the structural gates are
// clean, not on every repair attempt.
function qualityFailures(file) {
  const st = runGate('stress-slots.mjs', file);
  const stFail = Number((st.out.match(/(\d+)\s+failure/i) || [])[1] || 0);
  const br = runGate('brand-audit.mjs', file);
  const brandPass = /RESULT:\s*PASS/i.test(br.out);
  const deckAvg = Number((br.out.match(/deck\s*avg\s+([\d.]+)%/i) || [])[1] || 0);
  let text = '';
  if (!brandPass) {
    text += `brand-audit — RECOLOR IS BROKEN (${deckAvg}% of pixels move when the brand palette changes; needs >=3% deck average, 1.5% per slide).\n` +
      `The audit changes ONLY --brand-primary and --brand-accent and measures the share of pixels that move, so TWO things are required:\n` +
      `1. Every colour that carries the design — headline ink, accent chips/bars/cards, rules, CTA fills, numerals — comes from the brand tokens ` +
      `(var(--primary), var(--accent), var(--highlight) ...), NOT a literal hex. Only the fixed canvas (paper/bg) may stay literal.\n` +
      `2. --primary/--accent must cover real AREA on EVERY slide AS FILLS (a painted surface, never coloured glyphs): a headline highlight bar, a filled card/panel behind the body, a solid CTA, a coloured band or block. ` +
      `A deck at ~1% has the tokens wired but nothing filled — enlarge or add the accent-FILLED surface, keeping the composition.\n` +
      `Do NOT fix this by colouring text --accent: accent text on the pale canvas fails the CONTRAST gate (~2.3:1). Branded text stays --primary (dark); text on an accent fill uses --on-accent (light).\n` +
      `${br.out.slice(-500)}\n`;
  }
  if (stFail) {
    text += `stress-slots — ${stFail} failure(s) when the slots are refilled with generated copy (this is a TEMPLATE: the words WILL change).\n` +
      `TEXT-COLLISION means two blocks overlap once the copy runs long. Fix the LAYOUT, not the wording — shortening your own text hides the bug and it fails again on real copy:\n` +
      `put the text blocks in normal flow with real spacing so a longer headline pushes what follows down instead of landing on it, and move any decorative numeral/mark/badge out of the path of a growing headline or body (its own column, corner or margin).\n` +
      `A GHOST/WATERMARK NUMERAL BEHIND THE HEADLINE is the usual culprit and reads as intentional — it is still a failure: move it beside the headline or into a margin the text never reaches, do not just recolour or shrink it.\n` +
      `${st.out.slice(-500)}\n`;
  }
  // Severity, not a boolean: as a 0/1/2 count a deck with 3 stress failures TIED one with 10, so
  // the loop could not tell a near-fix from a disaster and kept whichever came first. Recolor is
  // worth more than a stress fail (it is 1.5 points and makes the template resellable), so it
  // dominates the ordering; stress then breaks ties by how many slots actually blow up.
  return { count: (brandPass ? 0 : 100) + stFail, text, deckAvg, stFail, brandPass };
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
  return ensureTextAboveSurfaces(extractDoc(await respond({ instructions: REMIX ? SYSTEM_REMIX : SYSTEM, input: [{ role: 'user', content: parts }] })));
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
const REVIEW = `You are checking a REPRODUCTION of a reference Instagram carousel for faithfulness and visual correctness. For each slide you are shown the REFERENCE image, then the REPRODUCTION image. Report concrete DEFECTS where the reproduction is visually broken or fails to match the reference:
- COLLISION: elements overlap wrongly — a pill/shape/badge sits on top of the headline, or text overlaps text. (In the reference these sit in clear space; if the reproduction stacks them onto the type, that is a defect.)
- CLIPPING: text runs off the slide edge or is cut by its own box.
- OCCLUDED: an element (usually body text) is hidden behind a card/panel, so the block looks empty though it should hold copy.
- MISSING: an element clearly present in the reference is absent in the reproduction.
- CHROME: fake editor/social UI that must NOT appear in a template — LIKE / SAVE / SHARE / COMMENT / HASHTAGS labels, @handles, page counters, swipe/next prompts. The neutral brand lockup (YOURBRAND) is fine; the source's social bar is not.
- SIZE: an element is much larger or smaller than in the reference (e.g. an oversized headline that dominates wrongly).
Report ONLY real, visible defects. If a slide faithfully matches the reference and is clean, report nothing for it.
Return ONLY minified JSON: {"defects":[{"slide":<n>,"type":"COLLISION|CLIPPING|OCCLUDED|MISSING|CHROME|SIZE","problem":"what is wrong","fix":"specific change to make it match the reference"}],"clean":<true only if zero defects across all slides>}`;

// ── remix design review (--remix) ────────────────────────────────────────────────
// DERIVED from REVIEW. The structural defects (collision/clipping/occlusion/chrome) are exactly
// the same failures and stay word-for-word — they are what the gates cannot see, and they are
// what shipped the-drawn-line at 10/10 with colliding tabs. Only the fidelity framing changes:
// grading a remix on "does it match the reference" would punish it for doing its job. MISSING/SIZE
// are re-aimed at the design language, and PLAGIARISM is added — the one defect unique to remix.
const REVIEW_REMIX = (() => {
  const swaps = [
    [
      'You are checking a REPRODUCTION of a reference Instagram carousel for faithfulness and visual correctness. For each slide you are shown the REFERENCE image, then the REPRODUCTION image. Report concrete DEFECTS where the reproduction is visually broken or fails to match the reference:',
      'You are checking a REMIX of a reference Instagram carousel. The remix deliberately has its OWN topic, copy and composition — it must only share the reference\'s design language (type character, scale contrast, grid, density, composing devices). Different words and a different layout are CORRECT, never defects. For each slide you are shown the REFERENCE image, then the REMIX image. Report concrete DEFECTS where the remix is visually broken or has lost the reference\'s craft:',
    ],
    [
      '- MISSING: an element clearly present in the reference is absent in the reproduction.',
      '- MISSING: the slide is missing something it needs to work — a headline with no support, a device the design language depends on, an empty region with no job.\n- PLAGIARISM: the remix reuses the reference\'s actual words, headline, brand name, @handle or placeholder text ("BORCELLE", "@REALLYGREATSITE", "reallygreatsite.com"). This is the worst defect: the copy must be the remix\'s own.\n- FLAT: the slide reads plainer or cheaper than the reference. Be strict and concrete — this is the most common failure and it is easy to wave through. A slide that is only a headline plus a paragraph of body text on a plain background, while the reference composes with cards, panels, highlight bars, rules, chips, oversized numerals or marks, IS FLAT — report it. So is a slide carrying a large empty band (roughly a third of its height with nothing in it), one with no real scale contrast between headline and body, and one whose body is shouty all-caps where the reference was restrained. Name the device from the reference\'s design language that the slide should be using.',
    ],
    [
      '- SIZE: an element is much larger or smaller than in the reference (e.g. an oversized headline that dominates wrongly).',
      '- SIZE: an element is mis-scaled for its role — an oversized headline that dominates wrongly, or body type too small to read.',
    ],
    [
      'Report ONLY real, visible defects. If a slide faithfully matches the reference and is clean, report nothing for it.',
      'Report ONLY real, visible defects. If a slide is clean and carries the reference\'s craft, report nothing for it — do NOT report it for differing from the reference in words, topic or composition. That is the point. But do NOT call a slide clean merely because nothing is broken: a slide that is intact yet flat is a defect, and shipping flat decks is the failure this review exists to stop.',
    ],
    [
      '"fix":"specific change to make it match the reference"',
      '"fix":"specific change to fix the defect, keeping the remix\'s own content"',
    ],
    ['COLLISION|CLIPPING|OCCLUDED|MISSING|CHROME|SIZE', 'COLLISION|CLIPPING|OCCLUDED|MISSING|PLAGIARISM|FLAT|CHROME|SIZE'],
  ];
  let s = REVIEW;
  for (const [from, to] of swaps) {
    if (!s.includes(from)) throw new Error(`--remix: REVIEW changed, cannot derive REVIEW_REMIX (missing: ${from.slice(0, 60)}…)`);
    s = s.replace(from, to);
  }
  return s;
})();

// Faithfulness review (vision): the deterministic gates catch overflow/contrast but are blind to a
// pill colliding with the headline, body text hidden behind a card, a missing element, or fake
// social chrome. This shows the model each REFERENCE page beside the REPRODUCTION and asks for
// concrete faithfulness defects — the same look-and-fix a human does by eye, which is what makes
// the pipeline converge to hand-authored quality instead of shipping a blind one-shot.
async function faithReview(renders, refs) {
  if (!renders || !renders.length || !refs || !refs.length) return null;
  const content = [{ type: 'input_text', text: REMIX
    ? 'For each slide: REFERENCE first, then REMIX. The remix has its own topic, copy and composition by design — report only broken craft or reused reference copy, never differences from the reference. Return ONLY the JSON.'
    : 'For each slide: REFERENCE first, then REPRODUCTION. Report faithfulness defects only. Return ONLY the JSON.' }];
  const n = Math.min(renders.length, refs.length, 10);
  for (let i = 0; i < n; i++) {
    content.push({ type: 'input_text', text: `Slide ${i + 1} — REFERENCE:` });
    content.push(imgPart(refs[i]));
    content.push({ type: 'input_text', text: `Slide ${i + 1} — REPRODUCTION:` });
    content.push(imgPart(renders[i]));
  }
  try {
    const raw = await respond({ instructions: REMIX ? REVIEW_REMIX : REVIEW, input: [{ role: 'user', content }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.defects)) j.defects = [];
    return j;
  } catch { return null; }
}
// Turn the review's per-slide defects into a repair instruction block.
function reviewFailures(j) {
  if (!j || !Array.isArray(j.defects) || !j.defects.length) return '';
  return (REMIX
    ? `design review — fix these visual defects, keeping this deck's own topic and copy:\n`
    : `faithfulness review — fix these visual defects so the reproduction matches the reference:\n`) +
    j.defects.map((x) => `  slide ${x.slide} [${x.type}]: ${x.problem} -> ${x.fix}`).join('\n');
}

// Gold-standard structural exemplar (a real 10/10 template, base64 stripped).
const EXEMPLAR = (() => { try { return fs.readFileSync(path.join(SCRIPTS, 'exemplar-template.html'), 'utf8'); } catch { return ''; } })();

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE-IMAGE authoring (kind === 'single-image')
//
// Structurally a different contract from the carousel path above, not a variant of it:
// content-gen's single-image kind (.si-single > ONE .si-page) requires FLOW LAYOUT for every
// content slot (flexbox/grid — the SAME convention its own real seeded si-*.html files use,
// confirmed by reading si-photo-hero.html directly), whereas the carousel path deliberately
// gives every text node its OWN absolutely-positioned wrapper to mirror Canva's exact source
// geometry. Those two authoring instructions contradict each other, so decode-geometry.mjs's
// exact x/y coordinates are deliberately NOT fed here — an exact-geometry reproduction is
// incompatible with the flow-layout requirement by construction. This path is REMIX-only for
// that reason: it studies the cloned single-image reference's craft (density, hierarchy, the
// devices it uses) and re-composes it in flow layout with an invented topic, the same
// "recognisably the same family, its own piece" philosophy as the carousel remix path,
// never a pixel-exact clone (which the target format doesn't support anyway).
//
// Rules mirrored from content-gen's own contract, verified against real source, not guessed:
// backend/services/content/src/services/SingleImageTemplateGenerationService.ts (its "HARD
// CONTRACT" block) and the ground-truth si-photo-hero.html / si-big-quote.html seeded files.
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_SI = `You author ONE self-contained, brand-recolorable single-image social post HTML template INSPIRED BY a reference single-image design. You are given a plan (an invented topic + copy + chosen layout) and the reference's page image. Build the plan in the reference's design family — its density, hierarchy and decorative devices — while realizing the plan's own content. Recognisably the same family, but its own piece. Output ONLY the complete HTML document (no prose, no markdown fences).

STRUCTURE CONTRACT (a template that violates this is rejected outright — no exceptions):
- Root: ONE <div class="si-single"> (CSS: width:fit-content; margin:0; — never centered) containing EXACTLY ONE <div class="si-page">. NEVER <section class="slide"> or class="ig-carousel" — those are the carousel format, a different kind entirely.
- .si-page declares its OWN fixed pixel canvas matching the reference's aspect ratio (1:1 -> 1080x1080, 4:5 -> 1080x1350, 9:16 -> 1080x1920, 1.91:1 -> 1200x628): width/height in px, container-type:inline-size, overflow:hidden. Never aspect-ratio or width:100% on .si-page.
- FLOW LAYOUT ONLY for content: lay out every content slot (eyebrow/headline/body/cta) with flexbox or grid + gaps/padding, so a longer generated headline pushes what follows down instead of overlapping it. position:absolute is allowed ONLY for (a) a full-bleed background photo wrapper at inset:0, and (b) ONE optional corner decoration — never on a content slot itself. This is the opposite of a carousel template; do not default to per-element absolute positioning.
- ONE hard-required slot: <h1 class="headline">...</h1>, exactly that element and class — an SVG or a div labelled "headline" does not count, an <h1> without class="headline" does not count. Optional slots: <p class="body">, <a class="cta">, an eyebrow via a class containing "eyebrow", and at most ONE content image <img class="si-image" data-image="true" data-image-size="1024x1536" ...> as a DIRECT child of .si-page (never nested inside the text wrapper), styled with CSS (object-fit:cover etc.) to fill whatever box you give it — the generator's own pixel size is unrelated to the canvas size, NEVER set data-image-size to the canvas's own WxH. data-image-size MUST be exactly "1024x1024" (square/landscape canvas) or "1024x1536" (portrait/tall canvas) — no other value is a valid generator size.
- Brand tokens: in :root declare exactly these nine pairs, and NEVER define a --brand-* variable yourself or invent a different intermediate name: --primary:var(--brand-primary,<hex>); --secondary:var(--brand-secondary,<hex>); --accent:var(--brand-accent,<hex>); --bg:var(--brand-bg,<hex>); --surface:var(--brand-surface,<hex>); --text-high:var(--brand-ink,<hex>); --text-low:var(--brand-text-muted,<rgba>); --border:var(--brand-border,<rgba>); --highlight:var(--brand-accent,<hex>) — NEVER --brand-highlight, it does not exist.
- Brand lockup (optional — add only where it suits the design): <span class="brand-word">YOURBRAND</span> and <img class="brand-mark" data-brand-logo="" alt="" src="<grey svg placeholder data-uri>"/>.
- Clamp every text run with -webkit-line-clamp, line-height >= 1.14, a few px padding-bottom so descenders are not sheared. Size text with clamp(min, Ncqw, max) against the fixed canvas width.
- EDITOR SAFETY: every text element's content is on ONE line in the source.
- Fonts: two-font pairing (a display face + a contrasting body face), closest Google Fonts (@import), only the weights used.
- INLINE SVG is for VECTOR GRAPHICS ONLY. NEVER readable copy inside <svg><text> (webfont-load race — put it in HTML + CSS instead). EVERY <svg> root carries data-cg-svg, data-cg-preserve, aria-hidden="true", AND focusable="false".
- SVG PAINT: inner geometry paints ONLY via fill="var(--cg-fill)" / stroke="var(--cg-stroke)", with --cg-fill/--cg-stroke declared on the OUTER <svg> (inline style or a class) as one of the existing role tokens (var(--primary), var(--accent), var(--text-high), etc — never --brand-* directly, never a literal color). NEVER currentColor or a literal hex/rgb/hsl on inner fill/stroke, NEVER inline style= on an inner node (allowed only on the outer <svg> — the backend strips it elsewhere), NEVER an SVG <filter>/<feGaussianBlur>/<feTurbulence> (hard-stripped with contents) — use CSS filter:blur(Npx) on the outer <svg> instead, and skip grain/texture effects entirely (no compliant equivalent).
- COLOR PURITY: outside :root, every color is a var(--token) reference (or color-mix() built from one). Only pure white/black/transparent/currentColor may be a literal.

Study the reference's craft — its density (how full the frame is), its hierarchy (headline vs body scale contrast), its decorative devices (cards, rules, chips, oversized numerals, scrims) — and re-compose that craft in flow layout, with the plan's own topic and copy. Map the reference's actual colours onto the brand tokens so a palette swap re-skins it. The result should read as a sibling of the reference — same craft, its own content — never a pixel-exact clone (structurally impossible here) and never plainer/flatter than the reference.

CHROME — the copy is the plan's, and the source's identity never appears:
- The reference's brand name/logo becomes the lockup <span class="brand-word">YOURBRAND</span> — never the source label.
- Drop the reference's social UI, @handle, watermark.
- NEVER the reference's words, headline, brand names, @handles or placeholder text ("BORCELLE", "@REALLYGREATSITE", "reallygreatsite.com") — a deck that reuses them is a clone and fails, however good it scores.`;

// Faithfulness/craft review for a single-image remix — same defect vocabulary and "different
// words/layout is correct, never a defect" framing as REVIEW_REMIX, adapted to one page instead
// of N slides, plus an SI-specific defect (FLOW) for the one failure mode unique to this kind:
// per-element absolute positioning where flow layout was required.
const REVIEW_SI = `You are checking a REMIX of a reference single-image social post. The remix deliberately has its OWN topic, copy and composition — it must only share the reference's design language (density, hierarchy, decorative devices). Different words and a different layout are CORRECT, never defects. You are shown the REFERENCE image, then the REMIX image. Report concrete DEFECTS where the remix is visually broken or has lost the reference's craft:
- COLLISION: elements overlap wrongly — a pill/shape/badge sits on top of the headline, or text overlaps text.
- CLIPPING: text runs off the canvas edge or is cut by its own box.
- OCCLUDED: an element (usually body text) is hidden behind a card/panel.
- MISSING: the page is missing something it needs to work — a headline with no support, a device the design language depends on, an empty region with no job.
- PLAGIARISM: the remix reuses the reference's actual words, headline, brand name, @handle or placeholder text. This is the worst defect: the copy must be the remix's own.
- FLAT: the page reads plainer or cheaper than the reference — a bare headline plus a paragraph on a plain background while the reference composes with cards, panels, highlight bars, rules, chips or marks IS FLAT. So is a page with a large empty band and no real scale contrast between headline and body.
- FLOW: a content slot (headline/body/cta) is positioned with position:absolute instead of flow layout — the wrong mechanism for this format, will not survive real copy of a different length.
- CHROME: fake editor/social UI — LIKE/SAVE/SHARE/COMMENT/HASHTAGS, @handles, watermarks. The neutral brand lockup (YOURBRAND) is fine.
- SIZE: an element is mis-scaled for its role.
Report ONLY real, visible defects. If the page is clean and carries the reference's craft, report nothing — do NOT report it for differing from the reference in words, topic or composition. That is the point. But do NOT call it clean merely because nothing is broken: intact yet flat is still a defect.
Return ONLY minified JSON: {"defects":[{"slide":1,"type":"COLLISION|CLIPPING|OCCLUDED|MISSING|PLAGIARISM|FLAT|FLOW|CHROME|SIZE","problem":"what is wrong","fix":"specific change, keeping the remix's own content"}],"clean":<true only if zero defects>}`;

// Stage 1 (single-image) — invent an original topic + a single-page plan from the reference.
// No decodeGeometry call (see the header comment above: exact positions are the wrong tool
// for a flow-layout target) — the model gets the reference IMAGE (for craft/density/devices)
// and its transcribed text (for what role each piece of copy played), nothing more specific.
async function planSI({ td, thumb, attempt = 1 }) {
  const text = slideTexts(td)[0] || '';
  const brief =
    `Reference title: ${td.title || '(untitled)'}\n` +
    (attempt > 1 ? `Your previous reply was not valid JSON. Return STRICTLY valid minified JSON this time.\n` : '') +
    `Extracted text on the reference page (authoritative, for understanding what role each piece of copy played — headline vs body vs cta vs eyebrow):\n  ${text || '(no text — decorative)'}\n` +
    `Study the attached reference image: its density (how full the frame is), its hierarchy, and its decorative devices (cards, rules, chips, numerals, scrims, an image treatment if it has one).\n` +
    `Invent an ORIGINAL topic unrelated to the reference's own subject, and a plan for a single-image post in the reference's design family. Return ONLY this minified JSON:\n` +
    `{"topic":"<the new topic, one line>","slug":"<3-word-kebab-slug for the new topic>","eyebrow":"<or empty>","headline":"<4-12 words, the hook>","body":"<12-28 words, or empty if the layout does not need one>","cta":"<or empty>","layout":"<one of PHOTO-HERO, SPLIT-FEATURE, FEATURE-LIST, COMPARISON, QUOTE-PORTRAIT, CENTERED-STATEMENT — whichever the reference's own composition most resembles>","devices":"<the reference's decorative devices to reproduce, e.g. 'oversized quote mark, thin accent rule'>"}`;
  const content = [{ type: 'input_text', text: brief }, imgPart(thumb)];
  let raw;
  try {
    raw = await respond({ instructions: PLANNER_SI, input: [{ role: 'user', content }] });
  } catch (err) {
    if (/unsupported|image|invalid|400/i.test(err.message) && attempt === 1) {
      // vision rejected — retry once without the image, text-only framing.
      const brief2 = brief.replace('Study the attached reference image', 'Study the reference (image unavailable this attempt)');
      raw = await respond({ instructions: PLANNER_SI, input: [{ role: 'user', content: [{ type: 'input_text', text: brief2 }] }] });
    } else throw err;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  let p = null;
  try { p = m ? JSON.parse(m[0]) : null; } catch {}
  if (!p || !p.headline) {
    if (attempt < 3) return planSI({ td, thumb, attempt: attempt + 1 });
    throw new Error('single-image planner returned no usable JSON after 3 attempts');
  }
  return p;
}
const PLANNER_SI = `You study a single-image social post design and invent an original plan for a NEW one in its design family. Return ONLY minified JSON as instructed. Never invent facts presented as real (no fabricated stats/prices/brand names) — use neutral placeholder specifics.`;

function planDeckSI(p) {
  return `SINGLE-IMAGE PLAN — an invented topic, NOT the reference's own subject. Build to this plan, in the reference's design family:\n` +
    `topic: ${p.topic || '(untitled)'}\n` +
    `layout: ${p.layout || '(match the reference composition)'}\n` +
    (p.eyebrow ? `eyebrow: "${p.eyebrow}"\n` : '') +
    `headline: "${p.headline}"\n` +
    (p.body ? `body: "${p.body}"\n` : '') +
    (p.cta ? `cta: "${p.cta}"\n` : '') +
    (p.devices ? `reference's decorative devices to reproduce: ${p.devices}\n` : '');
}

async function authorSI({ td, thumb, deck, sight = null }) {
  const brief =
    `Author a single-image template inspired by the reference below — its own topic and copy, the reference's design family (craft, density, devices), in FLOW LAYOUT (see STRUCTURE CONTRACT — this format never uses per-element absolute positioning for content).\n` +
    `Reference fonts: ${(td.fonts || []).join(', ') || 'unknown'} (substitute the closest Google Fonts).\n\n` +
    `=== PLAN ===\n${deck}=== END ===\n\n` +
    `MIRROR THE STRUCTURE of the gold-standard exemplar below EXACTLY where it overlaps this contract (nine :root brand tokens, semantic classes, -webkit-line-clamp, single-line source text) — but note the exemplar is a CAROUSEL (.slide, absolute positioning); THIS format is .si-single > .si-page with FLOW LAYOUT for content. Follow the STRUCTURE CONTRACT above over the exemplar wherever they conflict on positioning.\n\n` +
    `CRITICAL — RECOLORABILITY: every themeable color (background, surface, accent, highlight, headline color on a dark bg, border) MUST be var(--brand-<role>, <fallback-hex>). Only pure black/white body copy may be a literal.\n` +
    `CRITICAL — LEGIBILITY: every text run must clear >= 4.5:1 contrast against the ACTUAL background behind it. If text sits over a photo, add a scrim behind it.\n` +
    `CRITICAL — NO CLIPPING / NO COLLISION: text must fit its box and the canvas; in flow layout this means real gaps/padding between blocks, not overlapping absolute coordinates.\n\n` +
    `=== GOLD-STANDARD EXEMPLAR (carousel structure/token reference only — do NOT copy its .slide/absolute-positioning approach) ===\n${EXEMPLAR}\n=== END EXEMPLAR ===\n\n` +
    (sight && sight.defects
      ? `\n=== RE-AUTHOR FROM SIGHT ===\nBelow, after the REFERENCE image, is YOUR OWN previous attempt's RENDER. It has these defects:\n${sight.defects}\nAuthor a COMPLETE NEW document that fixes every defect. Keep what already matched the plan.\n`
      : '') +
    `Return ONLY the complete HTML document.`;
  const content = [{ type: 'input_text', text: brief }];
  if (sight && sight.render) {
    content.push({ type: 'input_text', text: 'REFERENCE:' }, imgPart(thumb));
    content.push({ type: 'input_text', text: 'YOUR PREVIOUS RENDER:' }, imgPart(sight.render));
  } else {
    content.push(imgPart(thumb));
  }
  return ensureTextAboveSurfaces(extractDoc(await respond({ instructions: SYSTEM_SI, input: [{ role: 'user', content }] })));
}

async function repairSI({ currentHtml, failures, render, thumb }) {
  const parts = [{ type: 'input_text', text:
    `This single-image template FAILED gate checks. Return the COMPLETE corrected HTML.\n` +
    `Make MINIMAL, TARGETED edits to fix ONLY the listed problems — keep everything that already works.\n` +
    `STRUCTURE LOCK: exactly ONE <div class="si-single"> containing exactly ONE <div class="si-page"> — never add a second page or switch to carousel markup. Content slots stay in FLOW LAYOUT (no position:absolute on headline/body/cta).\n` +
    `The rendered page is attached so you can SEE the overflow / collision / contrast.\n\n` +
    `FAILURES:\n${failures}\n\n` +
    `CURRENT HTML:\n${stripBase64(currentHtml).slice(0, 90000)}` }];
  if (render) parts.push(imgPart(render));
  return ensureTextAboveSurfaces(extractDoc(await respond({ instructions: SYSTEM_SI, input: [{ role: 'user', content: parts }] })));
}

async function faithReviewSI(render, ref) {
  if (!render || !ref) return null;
  const content = [
    { type: 'input_text', text: 'REFERENCE first, then REMIX. The remix has its own topic, copy and composition by design — report only broken craft or reused reference copy. Return ONLY the JSON.' },
    { type: 'input_text', text: 'REFERENCE:' }, imgPart(ref),
    { type: 'input_text', text: 'REMIX:' }, imgPart(render),
  ];
  try {
    const raw = await respond({ instructions: REVIEW_SI, input: [{ role: 'user', content }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.defects)) j.defects = [];
    return j;
  } catch { return null; }
}
function reviewFailuresSI(j) {
  if (!j || !Array.isArray(j.defects) || !j.defects.length) return '';
  return `design review — fix these visual defects, keeping this page's own topic and copy:\n` +
    j.defects.map((x) => `  [${x.type}]: ${x.problem} -> ${x.fix}`).join('\n');
}

// ── process one design (single-image) ────────────────────────────────────────────
// Same overall shape as processOne (plan -> author -> bounded repair -> faithfulness vision
// loop -> ship), simplified to ONE generation attempt rather than best-of-N: the structural
// contract here is tighter (one page, one required slot) so a single well-repaired attempt
// converges reliably. Easy to extend to a gen loop later if that turns out not to hold.
async function processOneSI(entry) {
  const { designId } = entry;
  const t0 = Date.now();
  let genRetries = 0;
  const { td, thumbs } = loadIntake(designId);
  const thumb = thumbs[0];
  const slug = slugify(td.title, designId);
  const replica = path.join(REPLICAS, `${slug}.html`);
  fs.mkdirSync(REPLICAS, { recursive: true });

  setStage(designId, 'planning');
  const planObj = await planSI({ td, thumb });
  const deck = planDeckSI(planObj);
  const shipSlug = slugify(planObj?.slug || planObj?.topic || td.title, designId);
  log(`  remix topic (single-image): ${String(planObj?.topic || '(unnamed)').slice(0, 70)} -> ${shipSlug}`);

  setStage(designId, 'authoring');
  fs.writeFileSync(replica, await authorSI({ td, thumb, deck }));
  fillImages(replica);

  let cand = null;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const contract = runGate('check-template-contract.mjs', replica);
    const verify = runGate('verify-slides.mjs', replica);
    const cv = contractViolations(contract.out);
    const vFail = Number((verify.out.match(/(\d+)\s+fail/i) || [])[1] || 0);
    const cur = fs.readFileSync(replica, 'utf8');
    const failures = `check-template-contract:\n${contract.out.slice(-800)}\nverify-slides:\n${verify.out.slice(-700)}`;
    const structClean = cv === 0 && vFail === 0;
    const nearClean = cv === 0 && vFail <= 1;
    const q = nearClean ? qualityFailures(replica) : { count: Infinity, text: '' };
    const allFailures = q.text ? `${failures}\n${q.text}` : failures;
    const better = !cand || cv < cand.cv || (cv === cand.cv && vFail < cand.vFail) || (cv === cand.cv && vFail === cand.vFail && q.count < cand.qFail);
    if (better) cand = { cv, vFail, qFail: q.count, html: cur, failures: allFailures };
    if (structClean && q.count === 0) break;
    if (attempt === MAX_REPAIRS) break;
    if (vFail > 60) { log(`  ${vFail} verify fails — abandoning blown-up draft`); genRetries++; break; }
    log(`  repair ${attempt + 1}/${MAX_REPAIRS} (contract ${cv}, verify fail ${vFail})`);
    genRetries++;
    setStage(designId, `repair ${attempt + 1}/${MAX_REPAIRS} (contract ${cv}, verify ${vFail})`);
    if (cur !== cand.html) { fs.writeFileSync(replica, cand.html); runGate('verify-slides.mjs', replica); }
    const renders = renderImages(replica);
    fs.writeFileSync(replica, await repairSI({ currentHtml: cand.html, failures: cand.failures, render: renders[0] }));
    fillImages(replica);
  }
  if (cand) fs.writeFileSync(replica, cand.html);
  if (!cand || cand.cv > 0) throw new Error(`no contract-clean single-image candidate (contract ${cand ? cand.cv : '?'})`);

  setStage(designId, 'scoring');
  let score = scoreReplica(replica);
  log(`  gen 1/1: score ${score}/10 · verify fail ${cand.vFail}${score >= MIN_SCORE && cand.vFail === 0 ? ' ✓' : ` (< ${MIN_SCORE})`}`);

  // faithfulness/craft vision loop — same purpose as processOne's, one page instead of N.
  let bestDefects = Infinity;
  let bestHtml = fs.readFileSync(replica, 'utf8');
  for (let fr = 1; fr <= FAITH_ITERS; fr++) {
    setStage(designId, `faithfulness review ${fr}/${FAITH_ITERS}`);
    runGate('verify-slides.mjs', replica);
    const renders = renderImages(replica);
    const review = await faithReviewSI(renders[0], thumb);
    const dc = review ? (review.defects || []).length : 0;
    if (review && dc < bestDefects) { bestDefects = dc; bestHtml = fs.readFileSync(replica, 'utf8'); }
    if (!review || review.clean || dc === 0) { log(`  faithfulness review ${fr}: clean`); break; }
    log(`  faithfulness review ${fr}/${FAITH_ITERS}: ${dc} defect(s) — ${[...new Set(review.defects.map((d) => d.type))].join(', ')}`);
    if (fr === FAITH_ITERS) break;
    genRetries++;
    const prev = fs.readFileSync(replica, 'utf8');
    setStage(designId, `re-author from sight ${fr}/${FAITH_ITERS}`);
    fs.writeFileSync(replica, await authorSI({ td, thumb, deck, sight: { render: renders[0], defects: reviewFailuresSI(review) } }));
    fillImages(replica);
    const gateOk = contractViolations(runGate('check-template-contract.mjs', replica).out) === 0;
    if (!gateOk) {
      log(`  re-author ${fr}: broke gates — falling back to local repair`);
      fs.writeFileSync(replica, prev); fillImages(replica);
      fs.writeFileSync(replica, await repairSI({ currentHtml: prev, failures: reviewFailuresSI(review), render: renders[0] }));
      fillImages(replica);
      if (contractViolations(runGate('check-template-contract.mjs', replica).out) !== 0) { fs.writeFileSync(replica, prev); fillImages(replica); }
    }
  }
  fs.writeFileSync(replica, bestHtml);
  fillImages(replica);
  score = scoreReplica(replica);
  const belowThreshold = score < MIN_SCORE;
  if (belowThreshold) log(`  best ${score}/10 < ${MIN_SCORE} — shipping best`);

  setStage(designId, 'finalizing');
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.copyFileSync(replica, path.join(OUTPUT, `${shipSlug}.html`));
  addRemixMap(designId, shipSlug);
  runGate('score-template.mjs', shipSlug);
  // Draft the content-gen seed catalog entry (B4) for this template automatically — no design
  // ships without one going forward. Non-fatal: a metadata-draft hiccup must never fail a ship
  // that already succeeded.
  try { execSync(`node "${path.join(SCRIPTS, 'generate-seed-metadata.mjs')}" --slug ${shipSlug}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  // Publish photos to blob storage + emit the seed-ready copy at output/.seed/<slug>.html, so a
  // freshly generated template is immediately seedable without a separate manual step. Skips any
  // image already uploaded with identical content, so re-runs cost only HEAD requests.
  // Non-fatal for the same reason as above — and specifically so a machine WITHOUT storage
  // credentials in .env still generates templates fine, it just doesn't publish them.
  try { execSync(`node "${path.join(SCRIPTS, 'publish-images.mjs')}" --slug ${shipSlug}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  setGenMetrics(designId, {
    genDurationMs: Date.now() - t0, genRetries, genProvider: PROVIDER, genStage: '',
    status: 'success', lastError: '', belowThreshold, score, detScore: score, premiumScore: 0,
  });
  try {
    execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' });
  } catch (e) {
    log(`refresh after ship failed (non-fatal): ${String(e.message).slice(0, 120)}`);
  }
  return { slug: shipSlug, score, belowThreshold };
}
const PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='5'><rect width='100%25' height='100%25' fill='%23c9c4bb'/></svg>";
const stripBase64 = (html) => html.replace(/data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=]+/g, PLACEHOLDER);
const imgPart = (p) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') });
// Fresh per-slide renders written by the last verify-slides run on THIS replica. verify
// writes to <dirname(html)>/.verify/<template-name>/ — a per-template dir, so concurrent
// runs (other designs, other chats, the single-slide mode) never clobber these renders.
// Must be derived from the replica path, never a shared dir, or repair/review would be fed
// another template's slides.
function renderImages(htmlFile) {
  const stem = path.basename(htmlFile).replace(/\.html?$/i, '');
  const src = path.basename(path.dirname(htmlFile));
  const dir = path.join(WORKSPACE, '.renders', src, stem); // must mirror verify-slides.mjs
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
  const planObj = await plan({ td, thumbs });
  let deck = planDeck(planObj);
  // A remix names itself off the topic it invented; the reference's title describes content this
  // deck deliberately does not have. Falls back to the reference-derived slug if the model
  // omitted one. (Scratch files keep the original slug — they're internal and short-lived.)
  const shipSlug = REMIX ? slugify(planObj?.slug || planObj?.topic || td.title, designId) : slug;
  if (REMIX) log(`  remix topic: ${String(planObj?.topic || '(unnamed)').slice(0, 70)} -> ${shipSlug}`);
  log(REMIX
    ? `  plan ready — authoring remix in the reference's design family (deck ${deck.length} chars)`
    : `  transcription ready — authoring faithful reproduction (deck ${deck.length} chars)`);
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
      // Recolor/stress are expensive (a browser launch each), so only weigh them once the deck is
      // structurally sound. NEAR-clean, not clean: one stubborn verify fail would otherwise block
      // the quality phase for the whole budget (observed: vFail stuck at 1 for 4 attempts, so
      // stress was never repaired and the deck shipped at stress 0/1.5).
      const structClean = cv === 0 && vFail === 0 && badCount === 0;
      const nearClean = cv === 0 && badCount === 0 && vFail <= 1;
      // Infinity, not a number: "not measured" must never rank ABOVE a measured deck (a sentinel
      // of 9 would have beaten a real brand failure at 100 and shipped the unmeasured one).
      const q = nearClean ? qualityFailures(replica) : { count: Infinity, text: '' };
      const allFailures = q.text ? `${failures}\n${q.text}` : failures;
      // Rank lexicographically: contract -> verify -> recolor/stress. Without the last term a
      // brand-repaired candidate ties its broken predecessor and loses, so the fix is discarded.
      const better = !cand || cvEff < cand.cv ||
        (cvEff === cand.cv && vFail < cand.vFail) ||
        (cvEff === cand.cv && vFail === cand.vFail && q.count < cand.qFail);
      if (better) cand = { cv: cvEff, vFail, qFail: q.count, html: cur, failures: allFailures };
      if (structClean && q.count === 0) break; // clean on every gate
      if (attempt === MAX_REPAIRS) break;
      if (nearClean) log(`  gen ${gen} quality repair ${attempt + 1}/${MAX_REPAIRS} (verify ${vFail}, brand ${q.deckAvg}%, stress-fail ${q.stFail})`);
      // Blown-up draft guard: a fresh author that renders with a huge verify-fail count is garbage;
      // repairing it just feeds a giant failures blob back in (the 7->193 cascade + 13-min calls).
      // Abandon this draft and let the next gen re-author from scratch instead.
      if (vFail > 60) { log(`  gen ${gen}: ${vFail} verify fails — abandoning blown-up draft`); genRetries++; break; }
      if (!nearClean) log(`  gen ${gen} repair ${attempt + 1}/${MAX_REPAIRS} (contract ${cv}, verify fail ${vFail})`);
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
      fs.writeFileSync(replica, await repair({ currentHtml: cand.html, failures: cand.failures, renders: renderImages(replica), slideCount: EXPECT }));
      fillImages(replica);
    }
    // restore this gen's best candidate (repair may have regressed on the last attempt)
    if (cand) { fs.writeFileSync(replica, cand.html); cv = cand.cv; }

    if (cv > 0) { log(`  gen ${gen}/${GEN_ATTEMPTS}: contract still ${cv} — discarding`); genRetries++; continue; }

    // Faithful reproduction ships on the DETERMINISTIC gates (contract clean + legibility/
    // overflow/recolor). No originality gate — matching the reference IS the goal now — and no
    // premium-invention judge (which is what made this slow and inconsistent). Rank candidates by
    // the deterministic score, tie-break on fewest verify fails; keep the best across gens.
    setStage(designId, `scoring (gen ${gen}/${GEN_ATTEMPTS})`);
    const score = scoreReplica(replica);
    const vFail = cand ? cand.vFail : 0;
    log(`  gen ${gen}/${GEN_ATTEMPTS}: score ${score}/10 · verify fail ${vFail}${score >= MIN_SCORE && vFail === 0 ? ' ✓' : ` (< ${MIN_SCORE})`}`);
    if (!best || score > best.combined || (score === best.combined && vFail < best.vFail)) {
      best = { score, combined: score, premium: 0, vFail };
      fs.copyFileSync(replica, bestFile);
    }
    if (score >= MIN_SCORE && vFail === 0) break;
  }

  if (!best) throw new Error(`no contract-clean candidate after ${GEN_ATTEMPTS} generations`);

  // Faithfulness vision polish (look-and-fix). The deterministic gates are blind to pills colliding
  // with the headline, body text hidden behind a card, a missing element, or fake social chrome —
  // exactly the defects a blind one-shot author leaves. Show the model each rendered slide beside
  // its reference, collect concrete faithfulness defects, and repair until the deck is clean (or the
  // round budget runs out). This is the single biggest lever for matching hand-authored quality.
  fs.writeFileSync(replica, fs.readFileSync(bestFile, 'utf8'));
  fillImages(replica);
  const gatesOk = (f) => contractViolations(runGate('check-template-contract.mjs', f).out) === 0 && slideCount(fs.readFileSync(f, 'utf8')) === EXPECT && !leakedBrandTokens(fs.readFileSync(f, 'utf8'), td).length;
  let bestDefects = Infinity;
  for (let fr = 1; fr <= FAITH_ITERS; fr++) {
    setStage(designId, `faithfulness review ${fr}/${FAITH_ITERS}`);
    runGate('verify-slides.mjs', replica); // fresh renders for the review
    const review = await faithReview(renderImages(replica), thumbs);
    const dc = review ? (review.defects || []).length : 0;
    if (review && dc < bestDefects) { bestDefects = dc; fs.copyFileSync(replica, bestFile); } // keep the version the reviewer likes most
    if (!review || review.clean || dc === 0) { log(`  faithfulness review ${fr}: clean`); break; }
    log(`  faithfulness review ${fr}/${FAITH_ITERS}: ${dc} defect(s) — ${[...new Set(review.defects.map((d) => `s${d.slide}:${d.type}`))].join(', ')}`);
    if (fr === FAITH_ITERS) break;
    genRetries++;
    const prev = fs.readFileSync(replica, 'utf8');
    const renders = renderImages(replica).slice();
    // RE-AUTHOR FROM SIGHT: hand the model its own render beside the reference and let it redo the deck
    // coherently (a holistic redo, closer to how a person re-composes) instead of dabbing at violations.
    setStage(designId, `re-author from sight ${fr}/${FAITH_ITERS}`);
    fs.writeFileSync(replica, await author({ td, thumbs, deck, sight: { renders, defects: reviewFailures(review) } }));
    fillImages(replica);
    if (!gatesOk(replica)) {
      // The holistic redo broke the deterministic floor — fall back to a safe LOCAL repair from prev.
      log(`  re-author ${fr}: broke gates — falling back to local repair`);
      fs.writeFileSync(replica, prev); fillImages(replica);
      fs.writeFileSync(replica, await repair({ currentHtml: prev, failures: reviewFailures(review), renders, slideCount: EXPECT }));
      fillImages(replica);
      if (!gatesOk(replica)) { fs.writeFileSync(replica, prev); fillImages(replica); } // repair also broke it → revert
    }
  }
  // rescore the (possibly improved) best for the dashboard
  fs.writeFileSync(replica, fs.readFileSync(bestFile, 'utf8'));
  best.score = scoreReplica(replica); best.combined = best.score;
  const belowThreshold = best.combined < MIN_SCORE;
  if (belowThreshold) log(`  best ${best.combined}/10 (verify fail ${best.vFail}) < ${MIN_SCORE} — shipping best`);

  // ship best + register + rescore into store + comparison + refresh
  setStage(designId, 'finalizing');
  fs.copyFileSync(bestFile, path.join(OUTPUT, `${shipSlug}.html`));
  fs.copyFileSync(bestFile, replica);
  try { fs.unlinkSync(bestFile); } catch {}
  if (REMIX) addRemixMap(designId, shipSlug); else addMap(designId, shipSlug);
  runGate('score-template.mjs', shipSlug);
  // build-comparison renders the design's archetype beside its reference — a remix has no
  // archetype (it ships standalone), so there is nothing for it to build. The dashboard shows
  // a remix through its own render gallery instead.
  if (!REMIX) {
    try { execSync(`node "${path.join(SCRIPTS, 'build-comparison.mjs')}" --design-id ${designId}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  }
  // Draft the content-gen seed catalog entry (B4) for this template automatically — no design
  // ships without one going forward. Non-fatal: a metadata-draft hiccup must never fail a ship
  // that already succeeded.
  try { execSync(`node "${path.join(SCRIPTS, 'generate-seed-metadata.mjs')}" --slug ${shipSlug}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  // Publish photos to blob storage + emit the seed-ready copy at output/.seed/<slug>.html, so a
  // freshly generated template is immediately seedable without a separate manual step. Skips any
  // image already uploaded with identical content, so re-runs cost only HEAD requests.
  // Non-fatal for the same reason as above — and specifically so a machine WITHOUT storage
  // credentials in .env still generates templates fine, it just doesn't publish them.
  try { execSync(`node "${path.join(SCRIPTS, 'publish-images.mjs')}" --slug ${shipSlug}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
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
  return { slug: shipSlug, score: best.combined, premium: best.premium, belowThreshold };
}

// ── loop ─────────────────────────────────────────────────────────────────────
// Self-heal: a prior WORKER killed mid-generation leaves rows stuck in 'generating', which the
// cloned queue then skips forever. On startup, return any such orphans to 'cloned' so they retry.
// This used to fire unconditionally the instant the worker started — fine when only this worker
// ever set 'generating', but template-remix-agent/template-author-agent now legitimately hold that
// status for real, multi-minute hand-authoring runs (via `agent-canva-clone.mjs --action mark`).
// Without a staleness check, just starting the worker to look at ONE design stomped every OTHER
// design's live agent back to 'cloned' mid-run. A real crashed worker row is stale for MINUTES,
// not seconds, so only recover rows whose updatedAt is old enough to be a genuine orphan.
const ORPHAN_STALE_MS = 20 * 60 * 1000; // 20 min — comfortably longer than any real authoring run
function healOrphans() {
  withStoreLock(() => {
    const s = readStore();
    let n = 0;
    const now = Date.now();
    for (const e of s.entries) {
      if (e.status !== 'generating') continue;
      const age = now - (Date.parse(e.updatedAt || '') || 0);
      if (!(age > ORPHAN_STALE_MS)) continue; // NaN (bad/missing updatedAt) also skips — never guess
      e.status = 'cloned'; e.genStage = ''; n++;
    }
    if (n) { fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n'); log(`recovered ${n} stuck 'generating' row(s) -> cloned`); }
  });
}

// Author ONE reference page in isolation, repair to clean, render a preview, and stop. Fast
// per-slide quality iteration: confirm a single slide is faithful before committing the whole
// deck, so a bad slide never forces a full-deck rework. Preview lands in output/_slide-<slug>-N.html.
async function genOneSlide(designId, slideNum) {
  const { td, thumbs } = loadIntake(designId);
  const N = Math.max(1, Math.min(slideNum, thumbs.length));
  const slug = slugify(td.title, designId);
  const tdOne = { ...td, pages: [td.pages[N - 1]], pageCount: 1 }; // single-page doc → geometry + author focus on this page only
  const thumbsOne = [thumbs[N - 1]];
  fs.mkdirSync(REPLICAS, { recursive: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const replica = path.join(REPLICAS, `_slide-${slug}-${N}.html`);
  const preview = path.join(OUTPUT, `_slide-${slug}-${N}.html`);

  log(`single-slide: ${designId} page ${N}/${thumbs.length} — "${(td.title || '').slice(0, 46)}"`);
  const deck = planDeck(await plan({ td: tdOne, thumbs: thumbsOne }));
  fs.writeFileSync(replica, await author({ td: tdOne, thumbs: thumbsOne, deck }));
  fillImages(replica);

  let cand = null;
  for (let a = 0; a <= MAX_REPAIRS; a++) {
    const contract = runGate('check-template-contract.mjs', replica);
    const verify = runGate('verify-slides.mjs', replica);
    const cv = contractViolations(contract.out);
    const vFail = Number((verify.out.match(/(\d+)\s+fail/i) || [])[1] || 0);
    const cur = fs.readFileSync(replica, 'utf8');
    if (!cand || cv < cand.cv || (cv === cand.cv && vFail < cand.vFail)) {
      cand = { cv, vFail, html: cur, failures: `check-template-contract:\n${contract.out.slice(-800)}\nverify-slides:\n${verify.out.slice(-700)}` };
    }
    if (cv === 0 && vFail === 0) break;
    if (a === MAX_REPAIRS) break;
    if (vFail > 60) { log(`  page ${N}: ${vFail} verify fails — abandoning blown-up draft`); break; }
    log(`  page ${N} repair ${a + 1}/${MAX_REPAIRS} (contract ${cv}, verify fail ${vFail})`);
    fs.writeFileSync(replica, await repair({ currentHtml: cand.html, failures: cand.failures, renders: renderImages(replica), slideCount: 1 }));
    fillImages(replica);
  }
  if (cand) fs.writeFileSync(replica, cand.html);
  const score = scoreReplica(replica);
  fs.copyFileSync(replica, preview);
  runGate('verify-slides.mjs', preview); // render the preview's slide PNG for inspection
  log(`page ${N}: score ${score}/10 · verify fail ${cand ? cand.vFail : '?'} · preview ${preview}`);
  return { preview, score, vFail: cand ? cand.vFail : null };
}

(async () => {
  if (SLIDE_NUM > 0) {
    if (!ONE_ID) { log('single-slide mode needs --design-id <ID> --slide <N>'); process.exit(1); }
    await genOneSlide(ONE_ID, SLIDE_NUM);
    log('worker exit.');
    return;
  }
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
      const r = next.kind === 'single-image' ? await processOneSI(next) : await processOne(next);
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
