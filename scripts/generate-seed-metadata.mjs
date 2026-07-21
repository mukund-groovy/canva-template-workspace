#!/usr/bin/env node
/**
 * generate-seed-metadata.mjs — draft content-gen's seed catalog entry for a shipped template.
 *
 * content-gen doesn't scan a directory at boot; it reads a hardcoded array
 * (backend/database/seeds/seed-carousel-templates.ts) — one object literal per template with
 * name/slug/description/category/order/enabled/isSystem/contentMode/recommendationProfile/kind.
 * None of that exists for anything this workspace ships. This script asks the model to draft it
 * end to end, straight from the template's own real copy — no human input, per the user's ask.
 *
 *   node scripts/generate-seed-metadata.mjs --all              # every output/*.html
 *   node scripts/generate-seed-metadata.mjs --slug <slug>       # just one (used by the worker
 *                                                                 to backfill a freshly-shipped
 *                                                                 template automatically)
 *
 * Writes/updates seed-metadata.json at the repo root — one entry per slug, matching content-gen's
 * seed-array shape plus `kind` and `sourceDesignId` (this workspace's own bookkeeping, drop those
 * two keys when pasting into seed-carousel-templates.ts).
 */
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT_DIR = path.join(WORKSPACE, 'output');
const META_PATH = path.join(WORKSPACE, 'seed-metadata.json');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const ONLY_SLUG = (() => { const i = argv.indexOf('--slug'); return i >= 0 ? argv[i + 1] : null; })();

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
const PROVIDER = String(env.GEN_PROVIDER || 'codex').toLowerCase();
const AZ_ENDPOINT = (env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
const AZ_KEY = env.AZURE_OPENAI_API_KEY;
const AZ_MODEL = env.AZURE_TEXT_MODEL;
const CL_ENDPOINT = (env.AZURE_ANTHROPIC_ENDPOINT || '').replace(/\/$/, '');
const CL_KEY = env.AZURE_ANTHROPIC_API_KEY;
const CL_MODEL = env.AZURE_ANTHROPIC_MODEL || 'claude-opus-4-8';
if (PROVIDER === 'claude' && (!CL_ENDPOINT || !CL_KEY)) { console.error('claude provider needs AZURE_ANTHROPIC_* in .env'); process.exit(1); }
if (PROVIDER !== 'claude' && (!AZ_ENDPOINT || !AZ_KEY || !AZ_MODEL)) { console.error('codex provider needs AZURE_OPENAI_* + AZURE_TEXT_MODEL in .env'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function respondCodex(instructions, text) {
  const r = await fetch(`${AZ_ENDPOINT}/openai/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': AZ_KEY },
    body: JSON.stringify({ model: AZ_MODEL, instructions, input: [{ role: 'user', content: [{ type: 'input_text', text }] }], max_output_tokens: 2000 }),
  });
  if (!r.ok) throw new Error(`azure ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.output_text || (j.output || []).map((o) => (o.content || []).map((c) => c.text || '').join('')).join('') || '';
}
async function respondClaude(instructions, text) {
  const r = await fetch(`${CL_ENDPOINT}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CL_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CL_MODEL, max_tokens: 2000, system: instructions, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  });
  if (!r.ok) throw new Error(`claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).map((b) => b.text || '').join('') || '';
}
async function respond(instructions, text) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try { return await (PROVIDER === 'claude' ? respondClaude(instructions, text) : respondCodex(instructions, text)); }
    catch (e) {
      const msg = String(e.message || '');
      const transient = /\b429\b|ratelimit|fetch failed|network|ECONNRESET|ETIMEDOUT|\b5\d\d\b/i.test(msg);
      if (!transient || attempt === 4) throw e;
      const wait = /429|ratelimit/i.test(msg) ? 65000 : 2000 * 2 ** attempt;
      console.log(`  API retry ${attempt + 1}/4 in ${Math.round(wait / 1000)}s: ${msg.slice(0, 70)}`);
      await sleep(wait);
    }
  }
}

// Existing categories/tags vocabulary content-gen's own seed array actually uses — verified by
// reading seed-carousel-templates.ts directly, not invented, so drafted entries fit the real
// catalog instead of introducing categories content-gen doesn't recognize.
const KNOWN_CATEGORIES = ['general', 'business', 'lifestyle', 'tech'];

function extractDeckText(html, isSI) {
  const $ = cheerio.load(html);
  if (isSI) {
    const headline = $('h1.headline').first().text().trim();
    const body = $('p.body').first().text().trim();
    const eyebrow = $('[class*="eyebrow"]').first().text().trim();
    return [eyebrow, headline, body].filter(Boolean).join(' | ');
  }
  const bits = [];
  $('.slide').each((_i, el) => {
    const $s = $(el);
    const t = $s.find('h1, h2').first().text().trim();
    const b = $s.find('p').first().text().trim();
    if (t || b) bits.push([t, b].filter(Boolean).join(': '));
  });
  return bits.join(' || ');
}

function detectKind(html) {
  const $ = cheerio.load(html);
  return $('.si-page').length ? 'single-image' : 'carousel';
}

const SYSTEM = `You are cataloging a social-media post template for a content-generation platform's template gallery. Given the template's actual copy (transcribed from the design), write ONE catalog entry as STRICT minified JSON, no prose, no markdown fences, matching exactly this shape:
{"name":"<Title Case display name, 2-5 words>","description":"<one line, what the template is for>","category":"<one of: general, business, lifestyle, tech — pick the closest fit, do not invent a new one>","contentMode":"<text-only | text-images | background-images — text-only if no photo slot, text-images if it has one or more photo slots as an accent, background-images if a photo IS the canvas/background>","recommendationProfile":{"version":1,"title":"<same as name or a short variant>","summary":"<1-2 sentences: what this template communicates and when to use it>","tags":["<6-10 lowercase tags: visual style, motifs, mood>"],"useCases":["<2-5 short use-case phrases like 'how-to','listicle','tips','announcement','testimonial','educational'>"],"tone":"<one word: professional | playful | elegant | bold | calm | warm | minimal | energetic>","visualStyle":["<2-4 short style descriptors>"],"slideCountSweet":{"min":<int>,"ideal":<int>,"max":<int>},"industries":[],"audience":[]}}
Base slideCountSweet on the ACTUAL slide count given (min = actual-1 or 2 whichever is higher, ideal = actual, max = actual+3). For a single-image template, slideCountSweet is {"min":1,"ideal":1,"max":1}. Never fabricate facts about the topic; describe the TEMPLATE (its design/purpose), not the placeholder copy's subject.`;

async function draftOne(slug, html) {
  const isSI = detectKind(html) === 'single-image';
  const deckText = extractDeckText(html, isSI);
  const slideCount = isSI ? 1 : (html.match(/class="slide"/g) || []).length;
  const prompt = `Template slug: ${slug}\nKind: ${isSI ? 'single-image (1 page)' : 'carousel'}\nSlide count: ${slideCount}\nTranscribed copy from the template:\n${deckText.slice(0, 2000)}\n\nReturn ONLY the JSON object.`;
  const raw = await respond(SYSTEM, prompt);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model reply for ${slug}: ${raw.slice(0, 200)}`);
  const j = JSON.parse(m[0]);
  if (!KNOWN_CATEGORIES.includes(j.category)) j.category = 'general';
  return {
    name: j.name || slug,
    slug,
    description: j.description || '',
    category: j.category,
    enabled: true,
    isSystem: false,
    contentMode: j.contentMode || (isSI ? 'background-images' : 'text-only'),
    recommendationProfile: j.recommendationProfile || {},
    kind: isSI ? 'single-image' : 'carousel',
  };
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { return {}; }
}
function saveMeta(meta) {
  // order is a position among the whole catalog, not a per-template attribute an AI call in
  // isolation can sensibly decide — assign it here as the sorted array index.
  const entries = Object.entries(meta).sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([, v], i) => { v.order = i; });
  fs.writeFileSync(META_PATH, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');
}

async function main() {
  const meta = loadMeta();
  let slugs;
  if (ONLY_SLUG) {
    slugs = [ONLY_SLUG];
  } else if (ALL) {
    slugs = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => f.replace(/\.html$/, ''));
  } else {
    console.error('usage: generate-seed-metadata.mjs --all | --slug <slug>');
    process.exit(1);
  }
  let done = 0, skipped = 0;
  for (const slug of slugs) {
    const file = path.join(OUTPUT_DIR, `${slug}.html`);
    if (!fs.existsSync(file)) { console.log(`skip ${slug}: no output/${slug}.html`); skipped++; continue; }
    if (meta[slug] && !ONLY_SLUG) { skipped++; continue; } // already drafted; --slug always re-drafts (fresh ship)
    try {
      console.log(`drafting ${slug} …`);
      meta[slug] = await draftOne(slug, fs.readFileSync(file, 'utf8'));
      saveMeta(meta); // save incrementally so a late failure doesn't lose earlier work
      done++;
    } catch (e) {
      console.error(`  FAILED ${slug}: ${e.message.slice(0, 200)}`);
    }
  }
  console.log(`\n${done} drafted, ${skipped} skipped (already present or missing file). Total in ${path.basename(META_PATH)}: ${Object.keys(meta).length}.`);
}
main();
