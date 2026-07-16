#!/usr/bin/env node
/**
 * Fill a carousel archetype's image slots with generated photos.
 *
 * Every `<img data-image="true">` is a slot. The prompt for each slot is derived from
 * its own slide's copy, so the photo matches the content. Results are inlined as data
 * URIs — the template must stay self-contained.
 *
 *   node canva-template-workspace/scripts/fill-image-slots.mjs <template.html> [--dry] [--probe]
 *
 *   --probe  verify the API + model, generate nothing
 *   --dry    print the derived prompts, generate nothing (free)
 *
 * Per-slot overrides on the <img>:
 *   data-image-size="1024x1536"   portrait (phone screens, tall scraps)
 *   data-image-prompt="..."       bypass the derived prompt entirely
 *
 * Provider resolution (first complete set wins), from canva-template-workspace/.env:
 *   1. AZURE_IMAGE_ENDPOINT + AZURE_IMAGE_API_KEY + AZURE_IMAGE_MODEL   <- preferred
 *   2. OPENAI_API_KEY (workspace .env, else backend/services/content/.env, else process.env)
 *
 * GOTCHA: the Azure IMAGE resource is on *.openai.azure.com. The Azure CHAT resource is a
 * DIFFERENT host (*.services.ai.azure.com) and has no image deployment — probing it for
 * images returns "Unknown model" / "Unavailable model" and looks like nothing is deployed.
 *
 * Generated images are downscaled to the slot's real pixel size and re-encoded as JPEG
 * before inlining: a raw 1024x1536 PNG is ~2.5 MB of base64, and six slots would push a
 * ~20 MB htmlContent row into Postgres. Requires ImageMagick (`magick`); without it the
 * PNG is inlined uncompressed and the script says so.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const PROBE = argv.includes('--probe');
const DRY = argv.includes('--dry');
const htmlPath = path.resolve(argv.find((a) => !a.startsWith('--')) || '');

// Standalone: workspace is the parent of this scripts/ dir; .env lives there.
const workspaceRoot = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const repoRoot = path.resolve(workspaceRoot, '..');
const ENV_FILES = [
  path.join(workspaceRoot, '.env'),
  path.join(repoRoot, 'canva-template-workspace', '.env'),
  path.join(repoRoot, 'backend', 'services', 'content', '.env'),
];

function loadEnv(p) {
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

const env = Object.assign({}, ...ENV_FILES.map(loadEnv).reverse(), {});
const DEFAULT_SIZE = env.IMAGE_SIZE && /^\d+x\d+$/.test(env.IMAGE_SIZE) ? env.IMAGE_SIZE : '1024x1024';
const QUALITY = env.IMAGE_QUALITY || 'high';

/**
 * Provider. Azure first (dedicated image resource + key), else OpenAI direct.
 * NOTE: the Azure IMAGE resource lives on *.openai.azure.com — a DIFFERENT host from
 * the chat resource (*.services.ai.azure.com), which has no image deployment.
 */
const AZ_URL = env.AZURE_IMAGE_ENDPOINT;
const AZ_KEY = env.AZURE_IMAGE_API_KEY;
const AZ_MODEL = env.AZURE_IMAGE_MODEL;
const OA_KEY = loadEnv(ENV_FILES[0]).OPENAI_API_KEY || loadEnv(ENV_FILES[1]).OPENAI_API_KEY || process.env.OPENAI_API_KEY;

const provider = AZ_URL && AZ_KEY && AZ_MODEL
  ? { name: 'azure', url: AZ_URL, model: AZ_MODEL, headers: { 'api-key': AZ_KEY, 'Content-Type': 'application/json' } }
  : OA_KEY
    ? { name: 'openai', url: 'https://api.openai.com/v1/images/generations', model: env.IMAGE_MODEL || 'gpt-image-1.5',
        headers: { Authorization: `Bearer ${OA_KEY}`, 'Content-Type': 'application/json' } }
    : null;

if (!provider) {
  console.error('No image provider configured. Set AZURE_IMAGE_ENDPOINT + AZURE_IMAGE_API_KEY + AZURE_IMAGE_MODEL,');
  console.error('or OPENAI_API_KEY, in:\n  ' + ENV_FILES.join('\n  '));
  process.exit(1);
}

/**
 * Downscale to the slot's real pixel size and re-encode as JPEG.
 * A raw 1024x1536 PNG inlines to ~2.5 MB of base64 — six slots would push a 20 MB
 * htmlContent row into Postgres. The slot never renders larger than a slide, so the
 * full-res PNG is pure waste.
 */
function compress(buf, targetW, targetH) {
  const tmpIn = path.join(os.tmpdir(), `slot-in-${Date.now()}.png`);
  const tmpOut = path.join(os.tmpdir(), `slot-out-${Date.now()}.jpg`);
  fs.writeFileSync(tmpIn, buf);
  const geom = `${targetW}x${targetH}^`;
  const r = spawnSync('magick', [tmpIn, '-resize', geom, '-gravity', 'center', '-extent', `${targetW}x${targetH}`,
                                 '-strip', '-quality', '82', tmpOut], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(tmpOut)) {
    try { fs.unlinkSync(tmpIn); } catch {}
    return { buf, mime: 'image/png', compressed: false };
  }
  const out = fs.readFileSync(tmpOut);
  try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
  return { buf: out, mime: 'image/jpeg', compressed: true };
}

async function generate(prompt, size) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify({ model: provider.model, prompt, size, n: 1, quality: QUALITY }),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message ?? text; } catch {}
    return { ok: false, status: r.status, message: String(msg) };
  }
  const d = JSON.parse(text).data?.[0] ?? {};
  const buf = d.b64_json
    ? Buffer.from(d.b64_json, 'base64')
    : Buffer.from(await (await fetch(d.url)).arrayBuffer());
  return { ok: true, buf };
}

if (PROBE) {
  console.log(`provider: ${provider.name}  model: ${provider.model}  size: ${DEFAULT_SIZE}  quality: ${QUALITY}`);
  const res = await generate('a plain neutral grey square', DEFAULT_SIZE);
  if (res.ok) { console.log(`OK — generated ${Math.round(res.buf.length / 1024)} KB`); process.exit(0); }
  console.error(`FAIL ${res.status}: ${res.message}`);
  process.exit(1);
}

if (!fs.existsSync(htmlPath)) { console.error(`no such template: ${htmlPath}`); process.exit(1); }

/**
 * Refuse to run twice against the same template. Two concurrent runs interleave writes to
 * .slot-images/ and to the HTML, so slots end up holding images generated from a previous
 * run's prompts — and neither run notices.
 */
// Lives under <root>/.locks/, never beside the HTML: output/ holds ONLY final template
// HTML so the folder can be lifted elsewhere as-is. Keyed by source dir + filename so two
// templates (or a replica and a shipped deck sharing a slug) get separate locks.
const WS_ROOT = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const LOCK_DIR = path.join(WS_ROOT, '.locks');
fs.mkdirSync(LOCK_DIR, { recursive: true });
const lockPath = path.join(
  LOCK_DIR,
  `${path.basename(path.dirname(htmlPath))}--${path.basename(htmlPath)}.imagelock`
);
if (fs.existsSync(lockPath)) {
  const held = fs.readFileSync(lockPath, 'utf8').trim();
  console.error(`Another fill-image-slots run holds the lock (${held}).`);
  console.error(`If it is dead, remove: ${lockPath}`);
  process.exit(1);
}
fs.writeFileSync(lockPath, `pid ${process.pid}`);
const releaseLock = () => { try { fs.unlinkSync(lockPath); } catch {} };
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

let html = fs.readFileSync(htmlPath, 'utf8');

// Quote-aware <img> matcher. `<img[^>]*>` is WRONG here: a placeholder src is an
// SVG data URI containing `<svg ...>`, so `[^>]*` truncates the tag mid-attribute
// and the src replacement silently no-ops.
const SLOT_RE = /<img(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const isSlot = (tag) => /\bdata-image="true"/i.test(tag);
const slots = (html.match(SLOT_RE) || []).filter(isSlot);
if (!slots.length) { console.log('no image slots — nothing to do.'); process.exit(0); }

// Map each slot to the slide it lives in, so the prompt reflects that slide's copy.
// These templates ship to premium brands. The default direction has to fight the model's
// pull toward generic stock: name the film, the lens, the light, the palette, the restraint —
// and explicitly ban the stock-photo tells.
// "matte low-contrast finish" was in this string, and it did exactly what it said:
// photos so flat they measure a grey stddev of 0.14 and read as a smudge at feed size.
// Restraint is a palette instruction, not a contrast instruction — ask for the full
// tonal range and let the colour stay quiet.
const STYLE =
  'Shot on medium-format film, 80mm lens, single soft directional window light that models the ' +
  'subject with a clear bright side and a soft shadow side, restrained palette of bone, clay, ecru ' +
  'and warm grey, matte finish carrying a full tonal range from deep shadow through clean highlight, ' +
  'fine natural grain, generous negative space, quiet considered composition, unposed and understated, ' +
  'premium editorial still-life. Not flat, not washed out, not evenly lit. No faces toward camera, ' +
  'no smiling stock poses, no clutter, no props arranged in a fan, no text, no letters, no numbers, ' +
  'no logos, no watermark, no visible screens with UI.';

function slideOf(offset) {
  const before = html.slice(0, offset);
  const start = before.lastIndexOf('<section');
  if (start === -1) return '';
  const end = html.indexOf('</section>', offset);
  return html.slice(start, end === -1 ? html.length : end);
}

const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Which physical object holds this slot — a phone screen crops differently than a torn scrap. */
function roleOf(offset) {
  const win = html.slice(Math.max(0, offset - 500), offset);
  const classes = [...win.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).reverse();
  for (const c of classes) {
    if (/\bphone\b/.test(c)) return 'a phone screen (tall 2:3 crop, shown inside a device mockup)';
    if (/\bscrap\b/.test(c)) return 'a torn-edged photo print (square, small, pinned in a collage)';
    if (/\bround\b/.test(c)) return 'a circular photo cut-out (square source, centre-cropped to a circle)';
    if (/\bcard\b/.test(c)) return 'a small tilted photo print with a dark border (square, collage element)';
  }
  return 'a small photo element in a paper collage';
}

/** Everything an art director would need, pulled from the deck itself. */
function deckContext() {
  const sections = html.split('<section').slice(1);
  const first = sections[0] ?? '';
  const deckTitle = clean(first.match(/data-title="true"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '');
  const deckSub = clean(first.match(/data-message="true"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '');
  const palette = [...html.matchAll(/--(brand-primary|brand-accent|paper|ink):\s*(#[0-9a-f]{3,8})/gi)]
    .map((m) => `${m[1]}=${m[2]}`).join(' ');
  return { deckTitle, deckSub, palette };
}

function slotBrief(slotTag, offset, i) {
  const sec = slideOf(offset);
  return {
    n: i + 1,
    slideTitle: clean(sec.match(/data-title="true"[^>]*>([\s\S]*?)<\//i)?.[1] ?? ''),
    slideMessage: clean(sec.match(/data-message="true"[^>]*>([\s\S]*?)<\//i)?.[1] ?? ''),
    role: roleOf(offset),
    aspect: slotTag.match(/data-image-size="(\d+x\d+)"/i)?.[1] ?? DEFAULT_SIZE,
  };
}

/**
 * Art-direct one photo subject per slot, using a text model, from the deck's own content.
 * Hand-written per-template prompts do not scale — this is an engine, not a one-off script.
 * Returns null on any failure so the caller can fall back loudly.
 */
async function authorSubjects(briefs, deck) {
  const host = String(env.AZURE_OPENAI_ENDPOINT || '').match(/^https:\/\/[^/]+/)?.[0];
  const key = env.AZURE_OPENAI_API_KEY;
  const model = env.AZURE_TEXT_MODEL || 'gpt-5.3-codex';
  if (!host || !key) return null;

  const instruction = [
    'You are an art director for a premium brand. Below is a social carousel and its photo slots.',
    'For EACH slot, write ONE photo subject line: a concrete, specific, photographable scene that carries',
    'that slide\'s idea. Not a metaphor, not an illustration, not a mood word — a scene a photographer',
    'could shoot tomorrow.',
    '',
    'Rules:',
    '- Every subject must be DISTINCT. No two slots may show the same object or setting.',
    '- Respect the slot role: a tall phone screen wants a vertical scene; a small circular cut-out wants',
    '  one close object, not a wide room.',
    '- Restraint over abundance. One or two elements, generous empty space.',
    '- Stay inside a quiet, tactile material world: paper, ink, linen, ceramic, wood, glass, plaster,',
    '  dried plants, hands at work, a studio or a still room. Intimate detail, not wide scenes.',
    '- Do NOT illustrate the caption as a literal metaphor. "Start before ready" is NOT a runner at a',
    '  starting line. Choose an object or gesture that simply belongs to the idea, and let it be quiet.',
    '- BANNED settings: cafes, baristas, offices, gyms, streets, shops, bathrooms, mirrors, stadiums,',
    '  anything that reads as commercial stock photography.',
    '- People: at most 2 of the slots may include a person, and only hands or a turned back. Never a face.',
    '- Avoid stock cliches: no laptop-and-coffee, no fanned-out props, no thumbs up, no smiling at camera,',
    '  no hands forming a heart, no sticky-note walls, no lightbulbs, no rising-arrow metaphors,',
    '  no stacked stones, no open door in a hallway, no single boot on a path.',
    '- Do NOT mention lighting, film, lens, palette or grain — house style is appended automatically.',
    '- No text, letters, numbers, logos or UI in the scene.',
    '- 12 to 28 words each.',
    '',
    `Deck: "${deck.deckTitle}" — ${deck.deckSub}`,
    `Palette: ${deck.palette}`,
    '',
    'Slots:',
    ...briefs.map((b) => `${b.n}. [${b.aspect}, ${b.role}] slide: "${b.slideTitle}" — ${b.slideMessage}`),
    '',
    `Reply with ONLY a JSON array of ${briefs.length} strings, in slot order. No prose, no code fence.`,
  ].join('\n');

  try {
    const r = await fetch(`${host}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: instruction }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j.output_text
      ?? (j.output ?? []).flatMap((o) => (o.content ?? []).map((c) => c.text)).filter(Boolean).join('');
    const raw = String(text).replace(/^```(?:json)?|```$/gm, '').trim();
    const arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    if (!Array.isArray(arr) || arr.length !== briefs.length) return null;
    if (arr.some((s) => typeof s !== 'string' || s.length < 12)) return null;
    if (new Set(arr.map((s) => s.toLowerCase())).size !== arr.length) return null; // duplicates
    return arr;
  } catch {
    return null;
  }
}

const jobs = [];
{
  let m;
  SLOT_RE.lastIndex = 0;
  while ((m = SLOT_RE.exec(html)) !== null) {
    if (!isSlot(m[0])) continue;
    const size = m[0].match(/data-image-size="(\d+x\d+)"/i)?.[1] ?? DEFAULT_SIZE;
    // A slot counts as filled only when it holds a REAL raster photo (png/jpeg/webp).
    // The authored template ships every slot with a grey `data:image/svg+xml` placeholder;
    // treating that as filled made the default (non-force) pass skip every slot, so photos
    // never generated in the pipeline. Placeholders must read as EMPTY.
    const filled = /\ssrc="data:image\/(?:png|jpe?g|webp);base64,/i.test(m[0]);
    jobs.push({ tag: m[0], index: m.index, size, filled });
  }
}

// Incremental by default: a slot that already holds an image is left alone. Refilling
// every slot to add one photo re-bills — and re-rolls — the images already approved.
//   (default)      fill only empty slots
//   --force        regenerate every slot
//   --only 1,4     regenerate exactly these slots (1-based, over all slots)
const FORCE = argv.includes('--force');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  if (i < 0) return null;
  return new Set(String(argv[i + 1] || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean));
})();
jobs.forEach((j, i) => {
  j.selected = ONLY ? ONLY.has(i + 1) : FORCE ? true : !j.filled;
});

console.log(`${path.basename(htmlPath)} — ${jobs.length} slot(s)`);
console.log(`provider: ${provider.name}  model: ${provider.model}  quality: ${QUALITY}`);

// 1) explicit per-slot override wins. 2) otherwise the engine art-directs from the deck.
const deck = deckContext();
const briefs = jobs.map((j, i) => slotBrief(j.tag, j.index, i));
const needsAuthoring = jobs.filter((j) => !/data-image-prompt="/i.test(j.tag));

let authored = null;
if (needsAuthoring.length) {
  process.stdout.write(`art-directing ${needsAuthoring.length} slot(s) from deck content … `);
  authored = await authorSubjects(briefs, deck);
  console.log(authored ? 'ok' : 'FAILED (falling back to slide copy verbatim — prompts will be weak)');
}

let ai = 0;
for (let i = 0; i < jobs.length; i++) {
  const explicit = jobs[i].tag.match(/data-image-prompt="([^"]+)"/i)?.[1];
  if (explicit) { jobs[i].prompt = explicit; continue; }
  const subject = authored
    ? authored[i]
    : `A scene evoking: "${[briefs[i].slideTitle, briefs[i].slideMessage].filter(Boolean).join('. ')}"`;
  jobs[i].prompt = `${subject.trim().replace(/\.?$/, '.')} ${STYLE}`;
  ai++;
}

console.log('');
jobs.forEach((j, i) => {
  const src = /data-image-prompt="/i.test(j.tag) ? 'manual' : authored ? ' auto ' : ' weak ';
  const state = j.selected ? '   ' : 'keep';
  console.log(`  [${String(i + 1).padStart(2)}] ${state} ${j.size} ${src}  ${j.prompt.split('. ')[0].slice(0, 84)}`);
});
const todo = jobs.filter((j) => j.selected).length;
console.log(`\n${todo} slot(s) to generate, ${jobs.length - todo} kept as-is.`);
if (!todo) { console.log('nothing to do (use --force or --only N to regenerate).'); process.exit(0); }
if (DRY) { console.log('\n--dry: nothing generated.'); process.exit(0); }

// Generated slot images are BUILD ARTEFACTS, not deliverables: they live under
// <root>/.slot-images/<source-dir>/<template>/, never beside the HTML. output/ must hold
// ONLY final template HTML so the whole folder can be lifted elsewhere as-is.
// Per-template subdir so parallel fills of DIFFERENT templates never share a slot-N.png
// path. (Inlining uses the freshly generated buffer directly, so the HTML was already
// safe — the per-template archive keeps regeneration/debugging correct under concurrency.)
const outDir = path.join(
  WS_ROOT, // declared with the lock dir above
  '.slot-images',
  path.basename(path.dirname(htmlPath)),
  path.basename(htmlPath, '.html')
);
fs.mkdirSync(outDir, { recursive: true });

console.log('');
let filled = 0;
// replace back-to-front so earlier offsets stay valid
for (let i = jobs.length - 1; i >= 0; i--) {
  const j = jobs[i];
  if (!j.selected) continue;
  process.stdout.write(`  slot ${i + 1}/${jobs.length} (${j.size}) … `);
  const res = await generate(j.prompt, j.size);
  if (!res.ok) { console.log(`FAILED ${res.status}: ${res.message.slice(0, 70)} — placeholder kept`); continue; }
  fs.writeFileSync(path.join(outDir, `slot-${i + 1}.png`), res.buf);
  const [w, h] = j.size.split('x').map(Number);
  const { buf: small, mime, compressed } = compress(res.buf, w, h);
  const uri = `data:${mime};base64,${small.toString('base64')}`;
  const newTag = j.tag.replace(/\ssrc="[^"]*"/i, ` src="${uri}"`);
  if (newTag === j.tag) {
    console.log('FAILED — could not rewrite src (no src attribute matched); image saved but NOT inlined');
    continue;
  }
  html = html.slice(0, j.index) + newTag + html.slice(j.index + j.tag.length);
  const note = compressed
    ? `${Math.round(res.buf.length / 1024)} KB → ${Math.round(small.length / 1024)} KB jpeg`
    : `${Math.round(res.buf.length / 1024)} KB (magick missing, no compression)`;
  console.log(`ok (${note})`);
  filled++;
}

fs.writeFileSync(htmlPath, html);

// Never claim success without proving it landed in the file.
const written = fs.readFileSync(htmlPath, 'utf8');
const inlined = (written.match(/data:image\/(png|jpeg);base64,/g) || []).length;
console.log(`\nfilled ${filled}/${jobs.length}, verified ${inlined} inlined image(s) in the file.`);
if (inlined < filled) { console.error('MISMATCH — generated more than were inlined.'); process.exit(1); }
console.log(`template ${Math.round(written.length / 1024)} KB — wrote ${htmlPath}`);
console.log(`raw PNGs → ${outDir}`);
