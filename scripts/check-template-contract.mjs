#!/usr/bin/env node
/**
 * check-template-contract.mjs — static gate: does this template obey the contract the
 * generation pipeline actually enforces?
 *
 * verify-slides.mjs renders and measures pixels. It cannot tell you that a text element
 * carries no slot semantics, so the slide generator is free to write a 200-character body
 * message into a 66px italic label and overlap the copy beneath it. That defect shipped,
 * and it was invisible to every check we had — because it is not a rendering bug, it is a
 * contract bug. This file checks the contract.
 *
 * Every rule below mirrors real code. The selectors are copied from
 *   backend/services/content/src/services/carousel-template-parser.ts
 * and the token list from
 *   backend/services/content/src/utils/validateColorTokens.ts
 * so the checker cannot silently diverge from what the runtime does.
 *
 *   node scripts/check-template-contract.mjs <template.html> [--json]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let cheerio;
for (const c of [
  'backend/services/content/node_modules/cheerio/dist/commonjs/index.js',
  'backend/services/content/node_modules/cheerio/lib/index.js',
  'node_modules/cheerio/dist/commonjs/index.js',
]) {
  const p = path.resolve(process.cwd(), c);
  if (fs.existsSync(p)) { cheerio = require(p); break; }
}
if (!cheerio) { try { cheerio = require('cheerio'); } catch {} }
if (!cheerio) { console.error('cheerio not found — run from the repo root.'); process.exit(1); }

const argv = process.argv.slice(2);
const file = path.resolve(argv.find((a) => !a.startsWith('--')) || '');
const asJson = argv.includes('--json');
if (!file || !fs.existsSync(file)) {
  console.error('usage: check-template-contract.mjs <template.html> [--json]');
  process.exit(1);
}

// ── mirrored from carousel-template-parser.ts ────────────────────────────────
const BODY_EXCLUDE =
  ':not(.kicker):not([class*="kicker"]):not(.eyebrow):not([class*="eyebrow"])' +
  ':not(.overline):not([class*="overline"]):not(.accent):not([class*="accent"])' +
  ':not(.cta-btn):not([class*="cta"]):not([class*="btn"]):not(.button):not([class*="button"])' +
  ':not([class*="-num"]):not([class*="number"]):not([class*="step"])' +
  ':not([class*="headline"]):not([class*="title"])';

const SLOT = {
  h1: 'h1, h2',
  kicker: '.kicker, [class*="kicker"], .eyebrow, [class*="eyebrow"], .overline, [class*="overline"]',
  body: `p${BODY_EXCLUDE}`,
  stepNum: '.step-num, [class*="-num"], [class*="number"]',
  ctaBtn: '.cta-btn, [class*="cta-btn"], a.btn, .button',
};
// An element the pipeline recognises as SOME slot, or as brand chrome it owns.
const RECOGNISED = [
  SLOT.h1, SLOT.kicker, SLOT.body, SLOT.stepNum, SLOT.ctaBtn,
  '[data-title]', '[data-message]', '[data-cta]', '[data-tagline]',
  '.brand-word', '.brand-mark', '[data-brand-logo]',
  '.foot', '[class*="foot"]', '.lockup', '[class*="cta"]',
].join(', ');

// ── mirrored from validateColorTokens.ts (R5) ────────────────────────────────
const REQUIRED_TOKENS = ['--primary','--secondary','--accent','--bg','--surface',
  '--text-high','--text-low','--border','--highlight'];

const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);
const violations = [];
const warnings = [];
const v = (rule, msg) => violations.push(`${rule}: ${msg}`);
const w = (rule, msg) => warnings.push(`${rule}: ${msg}`);

// ── C1. brand colour tokens ──────────────────────────────────────────────────
const styleText = $('style').text();
for (const t of REQUIRED_TOKENS) {
  if (!new RegExp(`${t}\\s*:`).test(styleText)) v('C1-TOKENS', `missing required token ${t}`);
}
const selfDefined = styleText.match(/--brand-[a-z-]+\s*:\s*(?!var)[^;]/g) || [];
if (selfDefined.length) {
  v('C1-TOKENS', `defines ${selfDefined.length} --brand-* variable(s); the brand skin supplies those and cannot override a definition`);
}

// ── C2. brand lockup ─────────────────────────────────────────────────────────
if ($('.brand-word').length === 0) v('C2-LOCKUP', 'no .brand-word — injectBrandLogo() cannot set the brand name; ships "YOURBRAND"');
if ($('img[data-brand-logo]').length === 0) w('C2-LOCKUP', 'no img[data-brand-logo] — the brand logo will never be injected (wordmark only)');

// ── per-slide rules ──────────────────────────────────────────────────────────
const slides = $('.slide');
if (!slides.length) v('C3-SLIDES', 'no .slide elements found');

slides.each((i, el) => {
  const n = i + 1;
  const $s = $(el);
  if ($s.attr('data-cg-slide-type') === undefined) v('C3-SLIDES', `slide ${n}: missing data-cg-slide-type`);

  // C4. A PROSE element (p / h1-h6) with no slot semantics is free real estate: the slide
  // generator reads it as content and may write a full body message into it. That is how a
  // 66px italic `<p class="step">Step 1</p>` ended up holding a 200-character paragraph,
  // overlapping the copy beneath it.
  //
  // Scoped to prose tags on purpose. Shipped templates carry plenty of unlabelled static
  // chrome — `.swipe`, `.cg-slide-counter`, `.cur`/`.sep`/`.tot`, `.arrow` — as div/span,
  // and the generator leaves those alone. Flagging them was a false positive that fired on
  // every shipped template.
  $s.find('p, h1, h2, h3, h4, h5, h6').each((_j, e) => {
    const $e = $(e);
    if ($e.children().length) return;
    const text = ($e.text() || '').trim();
    if (!text) return;
    if ($e.closest('svg').length) return;
    if ($e.is(RECOGNISED) || $e.closest(RECOGNISED).length) return;
    const cls = $e.attr('class') || $e.get(0).tagName;
    v('C4-SLOT', `slide ${n}: prose element .${cls} carries no slot semantics — the generator may write body copy into it ("${text.slice(0, 28)}")`);
  });

  // C5. exactly one body element — merge fills the first and CLEARS the rest.
  const bodies = $s.find(SLOT.body);
  if (bodies.length > 1) {
    w('C5-BODY', `slide ${n}: ${bodies.length} body paragraphs; the merge fills the first and blanks the others`);
  }

  // C6. editor safety: a newline inside a text element explodes under pre-wrap.
  $s.find('*').each((_j, e) => {
    const $e = $(e);
    if ($e.children().length) return;
    const raw = $e.text() || '';
    if (!raw.trim() || $e.closest('svg').length) return;
    if (/\n/.test(raw)) v('C6-EDITOR', `slide ${n}: multiline text in .${$e.attr('class') || 'element'} — explodes on click (white-space:pre-wrap)`);
  });

  // C8. at most ONE content photo per slide.
  // carousel-template-parser fills the FIRST <img> of a slide with that slide's image and
  // leaves any others untouched, so a second slot can never be replaced — it ships the
  // template's own baked-in photo into every brand's post.
  const contentPhotos = $s.find('img').filter((_j, e) => {
    const $i = $(e);
    return $i.attr('data-brand-logo') === undefined
      && $i.closest('.brand, .brand-mark-clip, .lockup').length === 0
      && !/brand-mark|brand-logo/.test($i.attr('class') || '');
  });
  if (contentPhotos.length > 1) {
    v('C8-PHOTO', `slide ${n}: ${contentPhotos.length} content photos — only the first is ever replaced; the rest ship the template's own image`);
  }

  // C7. a content photo must not live inside the brand lockup, or it will be
  // swapped for the brand logo instead of a topic photo.
  $s.find('img').each((_j, e) => {
    const $i = $(e);
    const isLogo = $i.attr('data-brand-logo') !== undefined || $i.closest('.brand, .brand-mark-clip').length > 0
                   || /brand-mark|brand-logo|(^|\s)logo(\s|$)/.test($i.attr('class') || '');
    if (!isLogo && $i.closest('.lockup, .brand').length) {
      v('C7-IMG', `slide ${n}: a content photo sits inside the brand lockup and will be replaced by the logo`);
    }
  });
});

// ── report ───────────────────────────────────────────────────────────────────
const result = { template: file, slides: slides.length, violations, warnings, pass: violations.length === 0 };
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\ncontract — ${path.basename(file)} (${slides.length} slides)\n`);
  if (!violations.length && !warnings.length) console.log('  clean.');
  for (const x of violations) console.log(`  FAIL  ${x}`);
  for (const x of warnings) console.log(`  warn  ${x}`);
  console.log(`\n  ${violations.length} violation(s), ${warnings.length} warning(s)\n`);
}
process.exit(violations.length ? 1 : 0);
