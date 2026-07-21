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

// TOKEN_BRAND_MAP, copied exactly from validateColorTokens.ts (checkBrandDerivation) — a
// required token existing is not enough; it must derive from ITS mapped --brand-* var, or
// content-gen's real validator rejects it even though this gate's old C1 check passed it clean.
// This is exactly the bug that shipped: --highlight:var(--brand-highlight,#hex) had the token
// declared, but --brand-highlight is never one of the vars the brand skin actually injects, so
// the color never re-branded. Caught here now, before ship, not discovered by hand later.
const TOKEN_BRAND_MAP = {
  '--primary': ['--brand-primary'],
  '--secondary': ['--brand-secondary'],
  '--accent': ['--brand-accent'],
  '--bg': ['--brand-bg'],
  '--surface': ['--brand-surface', '--brand-bg-alt'],
  '--text-high': ['--brand-ink', '--brand-text'],
  '--text-low': ['--brand-text-muted'],
  '--border': ['--brand-border'],
  '--highlight': ['--brand-accent'],
};

const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);
const violations = [];
const warnings = [];
const v = (rule, msg) => violations.push(`${rule}: ${msg}`);
const w = (rule, msg) => warnings.push(`${rule}: ${msg}`);

// ── C1. brand colour tokens ──────────────────────────────────────────────────
const styleText = $('style').text();
for (const t of REQUIRED_TOKENS) {
  const re = new RegExp(`${t}\\s*:\\s*([^;]+);`);
  const m = styleText.match(re);
  if (!m) { v('C1-TOKENS', `missing required token ${t}`); continue; }
  const expected = TOKEN_BRAND_MAP[t];
  const derivesOk = expected.some((b) => m[1].includes(`var(${b}`));
  if (!derivesOk) {
    v('C1-TOKENS', `${t} must derive from ${expected.map((b) => `var(${b}, ...)`).join(' or ')} — found: ${m[1].trim()}`);
  }
}
const selfDefined = styleText.match(/--brand-[a-z-]+\s*:\s*(?!var)[^;]/g) || [];
if (selfDefined.length) {
  v('C1-TOKENS', `defines ${selfDefined.length} --brand-* variable(s); the brand skin supplies those and cannot override a definition`);
}

// ── C2. brand lockup ─────────────────────────────────────────────────────────
if ($('.brand-word').length === 0) v('C2-LOCKUP', 'no .brand-word — injectBrandLogo() cannot set the brand name; ships "YOURBRAND"');
if ($('img[data-brand-logo]').length === 0) w('C2-LOCKUP', 'no img[data-brand-logo] — the brand logo will never be injected (wordmark only)');

// ── single-image detection ────────────────────────────────────────────────────
// content-gen's single-image kind (.si-single > EXACTLY ONE .si-page) is a structurally
// different, mutually-exclusive contract from the carousel one (.ig-carousel > N .slide):
// flow-layout content instead of per-element absolute positioning, a hard-required
// <h1 class="headline">, and — uniquely — a 1.91:1 landscape aspect is legal. Rules mirrored
// from backend/services/content/src/services/SingleImageTemplateGenerationService.ts's own
// "HARD CONTRACT" block (rules 1-11) and the ground-truth seeded si-*.html files.
const siPages = $('.si-page');
const isSingleImage = siPages.length > 0;

if (isSingleImage) {
  // S1. exactly one .si-page, and it must be a direct child of .si-single.
  if (siPages.length > 1) v('S1-STRUCT', `${siPages.length} .si-page elements — single-image allows EXACTLY one`);
  const $sis = $('.si-single');
  if (!$sis.length) v('S1-STRUCT', 'no .si-single root — required wrapper for a single-image template');
  siPages.each((_i, el) => {
    if (!$(el).parent().is('.si-single')) v('S1-STRUCT', '.si-page must be a DIRECT child of .si-single');
  });
  // S2. mutual exclusivity — a single-image template must never carry carousel markup.
  if ($('.slide').length) v('S2-MIXED', 'both .si-page and .slide present — single-image and carousel structure cannot mix');
  if ($('.ig-carousel').length) v('S2-MIXED', '.ig-carousel present on a single-image template — carousel-only wrapper');

  siPages.each((i, el) => {
    const $p = $(el);
    // S3. the one hard-required slot: <h1 class="headline">, exactly that class, no substitute.
    const headlines = $p.find('h1.headline');
    if (!headlines.length) v('S3-HEADLINE', 'missing required <h1 class="headline"> — content-gen\'s validator rejects every attempt without exactly this element+class');
    if ($p.find('h1').length > headlines.length) v('S3-HEADLINE', 'an <h1> exists without class="headline" — only <h1 class="headline"> counts, others are invisible to the validator and to content-fill');

    // S4. flow layout only. Per the real contract: position:absolute is allowed ONLY for (a)
    // a full-bleed background/photo wrapper, or (b) a single corner decoration — never on a
    // content slot itself (headline/body/cta/eyebrow). Checked via the inline style attribute,
    // since that's how this pipeline's own authoring emits positioning.
    $p.find('.headline, .body, .cta, .eyebrow').each((_j, e) => {
      const style = $(e).attr('style') || '';
      if (/position\s*:\s*absolute/i.test(style)) {
        v('S4-FLOW', `slide ${i + 1}: .${$(e).attr('class')} is position:absolute — single-image content slots must use flow layout (flexbox/grid), not per-element positioning (that's the carousel convention, not this one)`);
      }
    });

    // S5. at most one content image, and it must be a direct child of .si-page (not nested
    // inside the text cluster) — mirrors carousel's C7/C8 image-slot rules for this kind.
    const contentImgs = $p.find('img').filter((_j, e) => {
      const $img = $(e);
      return $img.attr('data-brand-logo') === undefined
        && $img.closest('.brand, .brand-mark-clip, .lockup').length === 0
        && !/brand-mark|brand-logo/.test($img.attr('class') || '');
    });
    if (contentImgs.length > 1) v('S5-IMG', `slide ${i + 1}: ${contentImgs.length} content images — single-image allows at most one (.si-image)`);
    contentImgs.each((_j, e) => {
      if (!$(e).parent().is('.si-page')) v('S5-IMG', 'the content image (.si-image) must be a DIRECT child of .si-page, not nested inside a text wrapper');
    });
  });
}

// ── per-slide rules (carousel only) ───────────────────────────────────────────
const slides = isSingleImage ? $() : $('.slide');
if (!isSingleImage && !slides.length) v('C3-SLIDES', 'no .slide elements found');
slides.each((i, el) => {
  const n = i + 1;
  const $s = $(el);
  // C3b: downgraded from a violation to a warning (2026-07-21) — verified against content-gen's
  // real source (carousel-template-parser.ts, carouselTemplateContract.ts, every .ts file under
  // backend/services/content/src): NO code consumer of data-cg-slide-type was found anywhere. It
  // appears in every seeded carousels/*.html file as an authoring convention, but nothing reads
  // it at runtime. Kept as a warning (not required) since it costs nothing to keep writing and
  // may be consumed by a frontend/editor feature outside the paths searched — but a template
  // missing it is NOT a contract violation until a real consumer is confirmed.
  if ($s.attr('data-cg-slide-type') === undefined) w('C3-SLIDES', `slide ${n}: missing data-cg-slide-type (convention only — no confirmed runtime consumer)`);

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

// ── C9. no readable copy inside <svg><text> ──────────────────────────────────
// SVG <text> does NOT reliably repaint when an async webfont arrives after first
// paint (unlike HTML text, which does FOUT/FOIT). Under load — content-gen opens
// up to 8 template iframes at once, all fetching the same Google Font — an SVG
// numeral/label painted before its font loads stays stuck in the fallback face
// PERMANENTLY (not a flash). Any readable copy must be a plain HTML element and,
// if it needs a decorative treatment, use CSS (background-clip:text,
// -webkit-text-stroke, mask-image) — never move the text into <svg>.
$('svg text').each((_j, e) => {
  const t = ($(e).text() || '').trim();
  if (t) v('C9-SVGTEXT', `readable copy "${t.slice(0, 20)}" inside <svg><text> — will stick in the fallback font if it paints before the webfont loads; use an HTML element + CSS instead`);
});

// ── C10. every real <svg> graphic carries the content-gen contract attributes ──
// data-cg-svg   → makes the SVG a first-class editable element in the playground
//                 (selectable/movable/resizable); without it the SVG is inert.
// data-cg-preserve → marks it an opaque subtree the backend carries through
//                 byte-identical; without it cheerio (HTML mode) lowercases
//                 camelCase attrs (viewBox→viewbox) and mangles self-closing tags,
//                 corrupting the vector on the generation round-trip.
// Scoped to ROOT <svg> only (an <svg> nested inside another is covered by its root).
$('svg').each((_j, e) => {
  const $e = $(e);
  if ($e.parents('svg').length) return; // not a root
  const miss = [];
  if ($e.attr('data-cg-svg') === undefined) miss.push('data-cg-svg');
  if ($e.attr('data-cg-preserve') === undefined) miss.push('data-cg-preserve');
  if (miss.length) {
    const id = $e.attr('class') || $e.attr('id') || $e.attr('viewBox') || '(anon)';
    v('C10-SVGATTR', `<svg ${String(id).slice(0, 30)}> missing ${miss.join(' + ')} — required on every SVG root (editable in playground + preserved through the backend pipeline)`);
  }
  // a11y attrs the backend's own SVG lint checks for — auto-corrected there, but a
  // template that already carries them needs no correction pass on ship.
  if ($e.attr('aria-hidden') !== 'true') w('C10-SVGATTR', `<svg ${String($e.attr('class') || '(anon)').slice(0, 30)}> missing aria-hidden="true"`);
  if ($e.attr('focusable') !== 'false') w('C10-SVGATTR', `<svg ${String($e.attr('class') || '(anon)').slice(0, 30)}> missing focusable="false"`);
});

// ── C11. SVG paint contract — mirrored from content-gen's real enforcement code:
// carousel-preserve-guard.ts (sanitizer: style= stripped on every non-root SVG node) and
// svgEmitLint.ts (lintSvgEmit — HARD-REJECTS at seed/CI: no currentColor, no literal hex/
// rgb/hsl, no --brand-* on fill/stroke; --cg-fill/--cg-stroke must be an ecosystem token,
// never a literal or --brand-*). Verified against real seeded templates (glow-orbs.html,
// tech-futurist.html): they all paint inner geometry via fill="var(--cg-fill)" /
// stroke="var(--cg-stroke)", declared once on the outer <svg>.
const LITERAL_COLOR_RE = /^\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))\s*$/;
$('svg').each((_j, root) => {
  const $root = $(root);
  if ($root.parents('svg').length) return; // only walk from each root once
  const id = String($root.attr('class') || $root.attr('id') || '(anon)').slice(0, 30);
  // C11a. <filter> and its children are hard-stripped by the backend sanitizer — a
  // template shipping one loses that visual element silently at runtime, not at review time.
  if ($root.find('filter').length) {
    v('C11-SVGPAINT', `<svg ${id}> uses <filter> (blur/noise/etc.) — the backend's sanitizer hard-strips <filter> WITH its contents; use CSS filter:blur(Npx) on the outer <svg> instead, or drop the effect`);
  }
  $root.find('*').each((_k, node) => {
    const $n = $(node);
    if (node.tagName === 'svg') return; // nested svg roots are handled by their own iteration
    // C11b. inline style on any non-root node — the sanitizer strips this silently.
    if ($n.attr('style') !== undefined) {
      v('C11-SVGPAINT', `<svg ${id}> inner <${node.tagName}> has an inline style= — the backend's sanitizer strips style on every SVG node except the root; move fill/stroke into the fill="var(--cg-fill)"/stroke="var(--cg-stroke)" attributes instead`);
    }
    for (const prop of ['fill', 'stroke']) {
      const val = $n.attr(prop);
      if (val === undefined || val === 'none') continue;
      if (/currentColor/i.test(val)) {
        v('C11-SVGPAINT', `<svg ${id}> inner <${node.tagName} ${prop}="currentColor"> — HARD-REJECTED by the backend's seed/CI lint; use ${prop}="var(--cg-${prop})" instead`);
      } else if (LITERAL_COLOR_RE.test(val)) {
        v('C11-SVGPAINT', `<svg ${id}> inner <${node.tagName} ${prop}="${val}"> — a literal color is HARD-REJECTED by the backend's seed/CI lint; use ${prop}="var(--cg-${prop})" instead`);
      } else if (/var\(\s*--brand-/i.test(val)) {
        v('C11-SVGPAINT', `<svg ${id}> inner <${node.tagName} ${prop}="${val}"> references --brand-* directly — brand isn't resolved at template-creation time; route through --cg-${prop} instead`);
      }
    }
  });
  // C11c. --cg-fill/--cg-stroke themselves must be an ecosystem token, never literal or --brand-*.
  const rootStyle = String($root.attr('style') || '');
  const cgDecls = [...rootStyle.matchAll(/--cg-(fill|stroke)\s*:\s*([^;]+)/g)];
  for (const [, role, val] of cgDecls) {
    if (LITERAL_COLOR_RE.test(val.trim())) v('C11-SVGPAINT', `<svg ${id}> --cg-${role} is a literal color (${val.trim()}) — must be an ecosystem token like var(--primary), never a literal`);
    else if (/var\(\s*--brand-/i.test(val)) v('C11-SVGPAINT', `<svg ${id}> --cg-${role} references --brand-* directly — use the ecosystem token (var(--primary) etc.) instead`);
  }
});

// ── C12. content photos live in files, never inlined as base64 ────────────────
// A baked `data:…;base64` photo pushed templates to 16-21 MB (345 MB across output/).
// content-gen stores template HTML in a Postgres `html_content @db.Text` column that WILL
// accept that, but its own HTTP create/update path caps at 10 MB (express.json in
// config/middleware.ts), so an inlined template can be seeded yet never edited through the
// admin API — and its own 40 seeded templates carry ZERO base64 (every content photo is a
// plain URL). Photos belong in files: output/assets/images/<slug>/<name>.png, referenced by a
// relative path that is swapped for the hosted URL at seed time.
//
// Brand-logo <img data-brand-logo> is exempt: it is a few hundred bytes of URL-encoded SVG
// (not base64) and content-gen swaps it for the real brand logo at generation anyway.
const htmlDir = path.dirname(file);
$('img').each((_j, e) => {
  const $img = $(e);
  const src = $img.attr('src') || '';
  const isLogo = $img.attr('data-brand-logo') !== undefined
    || $img.closest('.brand, .brand-mark-clip').length > 0
    || /brand-mark|brand-logo/.test($img.attr('class') || '');
  if (isLogo) return;
  if (/^data:image\/[a-z+]+;base64,/i.test(src)) {
    const kb = Math.round((src.length * 0.75) / 1024);
    v('C12-IMGSRC', `content photo is inlined as base64 (~${kb} KB) — externalize it to assets/images/<slug>/ and reference the relative path (node scripts/externalize-images.mjs)`);
    return;
  }
  // A linked asset that doesn't exist on disk is worse than an inlined one — it renders as a
  // broken image with no error anywhere upstream.
  if (/^assets\/images\//.test(src) && !fs.existsSync(path.join(htmlDir, src))) {
    v('C12-IMGSRC', `linked image "${src}" does not exist on disk (resolved against ${path.basename(htmlDir)}/)`);
  }
});

// ── report ───────────────────────────────────────────────────────────────────
const unitCount = isSingleImage ? siPages.length : slides.length;
const result = { template: file, kind: isSingleImage ? 'single-image' : 'carousel', slides: unitCount, violations, warnings, pass: violations.length === 0 };
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\ncontract — ${path.basename(file)} (${isSingleImage ? 'single-image' : `${unitCount} slides`})\n`);
  if (!violations.length && !warnings.length) console.log('  clean.');
  for (const x of violations) console.log(`  FAIL  ${x}`);
  for (const x of warnings) console.log(`  warn  ${x}`);
  console.log(`\n  ${violations.length} violation(s), ${warnings.length} warning(s)\n`);
}
process.exit(violations.length ? 1 : 0);
