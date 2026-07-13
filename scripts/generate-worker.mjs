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
async function respond(args) { return PROVIDER === 'claude' ? respondClaude(args) : respondCodex(args); }

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

// ── authoring contract (system prompt) ───────────────────────────────────────────
const SYSTEM = `You author ONE self-contained, brand-recolorable Instagram carousel HTML template that matches a reference design's LAYOUT while using entirely NEW copy and NEW photo subjects. Output ONLY the complete HTML document (no prose, no markdown fences).

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

KEEP the reference composition and each object's role. CHANGE all copy (new headlines/body/cta — never the reference words) and every photo SUBJECT (derive from YOUR new copy). Write real, punchy copy — not lorem, not the reference's text.`;

async function author({ td, thumbs, useVision = true }) {
  const brief =
    `Author a NEW carousel template that MATCHES the reference design's LAYOUT (shown in the attached page images) but with entirely NEW copy and NEW photo subjects.\n` +
    `Reference title: ${td.title || '(untitled)'}\n` +
    `Reference fonts: ${(td.fonts || []).join(', ') || 'unknown'} (substitute closest Google Fonts)\n` +
    `Slide count: ${thumbs.length} (produce exactly this many <section class="slide">)\n\n` +
    `MIRROR THE STRUCTURE of the gold-standard exemplar below EXACTLY: the nine :root brand tokens, the brand lockup, one <section class="slide" data-cg-slide-type> per page, EVERY text node in its own absolutely-positioned wrapper with the text in normal flow, -webkit-line-clamp on every run, single-line source text, semantic data-* slots. Your VISUAL layout differs to match the reference images; the structural scaffolding is identical to the exemplar.\n\n` +
    `CRITICAL — EVERYTHING MUST FIT the 1080x1350 slide with comfortable margins; ZERO overflow is the #1 quality bar (overflow is the most common failure).\n` +
    `- Reuse the exemplar's font sizes / line-heights as your ceiling; when unsure go SMALLER.\n` +
    `- Put -webkit-line-clamp on EVERY text run (headline 2-3 lines, body 3-4 lines) with line-height >= 1.14 and a few px padding-bottom.\n` +
    `- Keep copy TIGHT so it fits: cover headline <= ~32 chars, section headline <= ~40 chars, body <= ~140 chars, kicker/label <= ~24 chars. Fewer words beats clipped words.\n` +
    `- Absolutely-position each text block with a fixed max width well inside 1080; never let a block run to the slide edge.\n\n` +
    `CRITICAL — RECOLORABILITY (scored by a brand-audit that swaps the palette and measures how many pixels change):\n` +
    `- EVERY themeable color — page background, surfaces/cards, accent, the highlight, headline color on a dark bg, borders, the numeral/kicker color — MUST be var(--brand-<role>, <fallback-hex>). NEVER a bare hex for these.\n` +
    `- Only pure body-copy black or white may be a literal color. Everything that gives the design its LOOK must flow from the brand tokens, exactly like the exemplar — otherwise the template fails to re-skin and scores badly.\n` +
    `- Make the accent + backgrounds visibly brand-driven so a palette swap changes a large area of every slide.\n\n` +
    `=== GOLD-STANDARD EXEMPLAR — mirror this structure ===\n${EXEMPLAR}\n=== END EXEMPLAR ===\n\n` +
    `Return ONLY the complete HTML document.`;
  const content = [{ type: 'input_text', text: brief }];
  if (useVision) for (const p of thumbs.slice(0, 10)) content.push(imgPart(p));
  try {
    return stripFences(await respond({ instructions: SYSTEM, input: [{ role: 'user', content }] }));
  } catch (err) {
    if (useVision && /unsupported|image|invalid|400/i.test(err.message)) {
      log('  vision rejected by model — retrying text-only');
      return author({ td, thumbs, useVision: false });
    }
    throw err;
  }
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
  const { td, thumbs } = loadIntake(designId);
  const slug = slugify(td.title, designId);
  const replica = path.join(REPLICAS, `${slug}.html`);
  fs.mkdirSync(REPLICAS, { recursive: true });

  // best-of-N: each generation authors fresh, repairs to a contract-clean template,
  // scores it, and keeps the highest. Stops early once score >= MIN_SCORE; otherwise
  // ships the best candidate after GEN_ATTEMPTS and flags it as below threshold.
  const bestFile = path.join(REPLICAS, `${slug}.best.html`);
  let best = null; // { score }

  for (let gen = 1; gen <= GEN_ATTEMPTS; gen++) {
    fs.writeFileSync(replica, await author({ td, thumbs }));
    fillImages(replica);

    let cv = 99;
    let cand = null; // best candidate THIS gen: {cv, vFail, html} — repair can regress, so keep the best
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const contract = runGate('check-template-contract.mjs', replica);
      const verify = runGate('verify-slides.mjs', replica);
      cv = contractViolations(contract.out);
      const vFail = Number((verify.out.match(/(\d+)\s+fail/i) || [])[1] || 0);
      const cur = fs.readFileSync(replica, 'utf8');
      if (!cand || cv < cand.cv || (cv === cand.cv && vFail < cand.vFail)) cand = { cv, vFail, html: cur };
      if (cv === 0 && vFail === 0) break;
      if (attempt === MAX_REPAIRS) break;
      const failures = `check-template-contract:\n${contract.out.slice(-800)}\nverify-slides:\n${verify.out.slice(-700)}`;
      log(`  gen ${gen} repair ${attempt + 1}/${MAX_REPAIRS} (contract ${cv}, verify fail ${vFail})`);
      // surgical repair: model sees its own rendered slides (output/.verify) + exact failures
      fs.writeFileSync(replica, await repair({ currentHtml: cur, failures, renders: renderImages() }));
      fillImages(replica);
    }
    // restore this gen's best candidate (repair may have regressed on the last attempt)
    if (cand) { fs.writeFileSync(replica, cand.html); cv = cand.cv; }

    if (cv > 0) { log(`  gen ${gen}/${GEN_ATTEMPTS}: contract still ${cv} — discarding`); continue; }
    const score = scoreReplica(replica);
    log(`  gen ${gen}/${GEN_ATTEMPTS}: score ${score}/10${score >= MIN_SCORE ? ' ✓' : ` (< ${MIN_SCORE})`}`);
    if (!best || score > best.score) { best = { score }; fs.copyFileSync(replica, bestFile); }
    if (score >= MIN_SCORE) break;
  }

  if (!best) throw new Error(`no contract-clean candidate after ${GEN_ATTEMPTS} generations`);
  const belowThreshold = best.score < MIN_SCORE;
  if (belowThreshold) log(`  best ${best.score}/10 < ${MIN_SCORE} after ${GEN_ATTEMPTS} gens — shipping best`);

  // ship best + register + rescore into store + comparison + refresh
  fs.copyFileSync(bestFile, path.join(OUTPUT, `${slug}.html`));
  fs.copyFileSync(bestFile, replica);
  try { fs.unlinkSync(bestFile); } catch {}
  addMap(designId, slug);
  runGate('score-template.mjs', slug);
  try { execSync(`node "${path.join(SCRIPTS, 'build-comparison.mjs')}" --design-id ${designId}`, { cwd: WORKSPACE, stdio: 'ignore' }); } catch {}
  execSync(`node "${path.join(SCRIPTS, 'agent-canva-clone.mjs')}" --action refresh`, { cwd: WORKSPACE, stdio: 'ignore' });
  return { slug, score: best.score, belowThreshold };
}

// ── loop ─────────────────────────────────────────────────────────────────────
(async () => {
  let done = 0;
  while (done < MAX) {
    const q = clonedQueue();
    const next = ONE_ID ? q.find((e) => e.designId === ONE_ID) : q[0];
    if (!next) { log(q.length ? 'requested design not in cloned queue' : 'queue empty — no cloned rows left. done.'); break; }
    log(`generating ${next.designId} — "${(next.meta && next.meta.title || '').slice(0, 40)}" (${q.length} in queue)`);
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
