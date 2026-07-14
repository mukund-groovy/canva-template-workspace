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
const MIN_SCORE = Number(opt('min-score', 8));   // regenerate until score >= this (out of 10)
const GEN_ATTEMPTS = Number(opt('gens', 3));      // max full regenerations before shipping best

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

// ── creative planning (system prompt) ────────────────────────────────────────────
// Stage 1: study the reference purely for its STRUCTURE and THEME, then invent an
// original, premium concept with entirely new copy. Decoupled from HTML so the model
// designs the idea first instead of transcribing whatever text it can read off the
// reference images (the failure mode that produced a near-verbatim clone).
const PLANNER = `You are a senior brand designer and copywriter. You are shown the page images of a reference Instagram carousel. Study it ONLY to understand: its layout structure, how many slides, the role of each element (cover / point / list / closer), the topic space, and the visual mood.

Then INVENT AN ORIGINAL, PREMIUM carousel on a topic in the same space — your own creative angle, your own words. This is inspiration, not reproduction.

HARD RULES:
- NEVER reuse the reference's words, headlines, sentences, brand names, @handles, phone numbers, or placeholder text. If you can read a phrase in the reference, you may not use it.
- This includes CHROME the reference paints on every slide: a top-bar brand name (e.g. a made-up label like "BORCELLE"), social UI ("LIKE", "SAVE", "COMMENT"), page counters, @handles, and the words inside pills/buttons. None of those words may appear in your plan. Any button/pill you want is expressed as a slide's cta with YOUR OWN label.
- Write real, sharp, premium editorial copy — specific and confident, never lorem, never generic filler.
- Keep it tight so it will fit: cover headline <= ~32 chars, section headline <= ~40 chars, body <= ~140 chars, kicker/cta/label <= ~24 chars.
- Pick a fresh angle: a distinct point of view, a memorable through-line across slides, a strong closing CTA.

Return ONLY minified JSON, no prose, matching:
{"concept":"one-line premium angle","audience":"who","tone":"e.g. bold editorial","visualDirection":"typography + color + composition mood in one sentence","slides":[{"role":"cover|point|list|closer","kicker":"","title":"","body":"","cta":""}]}
Produce exactly one slides[] entry per reference page. Omit a field with "" when the slide's role doesn't use it.`;

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

// Stage 1 — study the reference images and return an original creative plan (JSON).
async function plan({ td, thumbs, useVision = true }) {
  const brief =
    `Reference title (for topic space only, do NOT reuse its words): ${td.title || '(untitled)'}\n` +
    `Slide count: ${thumbs.length} — return exactly this many slides[].\n` +
    `Study the attached reference page images for structure and mood, then invent an original premium carousel. Return ONLY the JSON.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  let raw;
  try {
    raw = await respond({ instructions: PLANNER, input: [{ role: 'user', content }] });
  } catch (err) {
    if (useVision && /unsupported|image|invalid|400/i.test(err.message)) {
      log('  plan: vision rejected — retrying text-only');
      return plan({ td, thumbs, useVision: false });
    }
    throw err;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('planner returned no JSON');
  const p = JSON.parse(m[0]);
  if (!Array.isArray(p.slides) || !p.slides.length) throw new Error('plan has no slides');
  return p;
}

// Serialize the plan into a compact copy deck the author fills into the layout.
function planDeck(p) {
  const line = (s, i) =>
    `Slide ${i + 1} [${s.role || 'point'}]` +
    (s.kicker ? ` · kicker: "${s.kicker}"` : '') +
    (s.title ? ` · title: "${s.title}"` : '') +
    (s.body ? ` · body: "${s.body}"` : '') +
    (s.cta ? ` · cta: "${s.cta}"` : '');
  return `CONCEPT: ${p.concept || ''}\nAUDIENCE: ${p.audience || ''}\nTONE: ${p.tone || ''}\nVISUAL DIRECTION: ${p.visualDirection || ''}\n\nCOPY DECK (use these EXACT words — they are already original; do not swap in reference text):\n${p.slides.map(line).join('\n')}`;
}

async function author({ td, thumbs, deck, useVision = true }) {
  const brief =
    `Author a premium, self-contained carousel HTML template that REALIZES the creative plan below in an elevated design.\n` +
    `Use the attached reference page images ONLY for LAYOUT/COMPOSITION inspiration (element placement, rhythm) — never for words.\n` +
    `Reference fonts: ${(td.fonts || []).join(', ') || 'unknown'} (substitute closest premium Google Fonts; you may choose better ones).\n` +
    `Slide count: ${thumbs.length} (produce exactly this many <section class="slide">)\n\n` +
    `=== ORIGINAL CREATIVE PLAN — this is your copy ===\n${deck}\n=== END PLAN ===\n\n` +
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
    `- Be conservative with display type near edges: a 40-char section headline wraps to 2-3 lines, so give it a box tall enough for 3 lines OR drop the size; body 3-4 lines. Leave a few px padding-bottom for descenders.\n` +
    `- Never give a text box a fixed height smaller than its clamped content — prefer min-height with generous room. Keep every element inside the 1080x1350 canvas with ~64-80px margins; nothing may spill a slide edge.\n\n` +
    `=== GOLD-STANDARD EXEMPLAR — mirror this structure ===\n${EXEMPLAR}\n=== END EXEMPLAR ===\n\n` +
    `Return ONLY the complete HTML document.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  try {
    return stripFences(await respond({ instructions: SYSTEM, input: [{ role: 'user', content }] }));
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
  'highlight highlighter marker underline divider accent surface primary secondary neutral texture'
).split(/\s+/));
function referenceBrandTokens(td) {
  const raw = JSON.stringify(td.pages || td);
  const words = (raw.match(/[A-Za-z][A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase());
  // keep long, non-dictionary-ish tokens that repeat (chrome painted on every slide) or look like a handle/brand
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return new Set(
    Object.keys(freq).filter((w) => w.length >= 6 && !COMMON.has(w) && (freq[w] >= td.pageCount || /site|brand|studio|official|great/.test(w)))
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
async function repair({ currentHtml, failures, renders }) {
  const parts = [{ type: 'input_text', text:
    `This carousel template FAILED gate checks. Return the COMPLETE corrected HTML.\n` +
    `Make MINIMAL, TARGETED edits to fix ONLY the listed problems — keep everything that already works; do NOT restructure passing slides (that just breaks other things).\n` +
    `The rendered slides are attached so you can SEE the overflow / collision / contrast.\n\n` +
    `FAILURES:\n${failures}\n\n` +
    `CURRENT HTML (photos shown as placeholders — keep the data-image slots as-is):\n${stripBase64(currentHtml).slice(0, 90000)}` }];
  for (const r of renders.slice(0, 8)) parts.push(imgPart(r));
  return stripFences(await respond({ instructions: SYSTEM, input: [{ role: 'user', content: parts }] }));
}

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

// Gold-standard structural exemplar (a real 10/10 template, base64 stripped).
const EXEMPLAR = (() => { try { return fs.readFileSync(path.join(SCRIPTS, 'exemplar-template.html'), 'utf8'); } catch { return ''; } })();
const PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='5'><rect width='100%25' height='100%25' fill='%23c9c4bb'/></svg>";
const stripBase64 = (html) => html.replace(/data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=]+/g, PLACEHOLDER);
const imgPart = (p) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') });
function renderImages() {
  const dir = path.join(OUTPUT, '.verify');
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
      const failures = `check-template-contract:\n${contract.out.slice(-800)}\nverify-slides:\n${verify.out.slice(-700)}`;
      if (!cand || cv < cand.cv || (cv === cand.cv && vFail < cand.vFail)) cand = { cv, vFail, html: cur, failures };
      if (cv === 0 && vFail === 0) break;
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
      fs.writeFileSync(replica, await repair({ currentHtml: cand.html, failures: cand.failures, renders: renderImages() }));
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
    const score = scoreReplica(replica);
    log(`  gen ${gen}/${GEN_ATTEMPTS}: score ${score}/10 · copy ${Math.round(overlap * 100)}% ref${score >= MIN_SCORE ? ' ✓' : ` (< ${MIN_SCORE})`}`);
    if (!best || score > best.score) { best = { score }; fs.copyFileSync(replica, bestFile); }
    if (score >= MIN_SCORE) break;
  }

  if (!best) throw new Error(`no contract-clean candidate after ${GEN_ATTEMPTS} generations`);
  const belowThreshold = best.score < MIN_SCORE;
  if (belowThreshold) log(`  best ${best.score}/10 < ${MIN_SCORE} after ${GEN_ATTEMPTS} gens — shipping best`);

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
    status: 'success', lastError: '', belowThreshold, score: best.score,
  });
  // NON-FATAL: a refresh hiccup must never flip an already-shipped success to failed.
  try {
    execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' });
  } catch (e) {
    log(`refresh after ship failed (non-fatal): ${String(e.message).slice(0, 120)}`);
  }
  return { slug, score: best.score, belowThreshold };
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
