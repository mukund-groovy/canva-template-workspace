#!/usr/bin/env node
/**
 * verify-slides.mjs — post-generation render QA for an authored carousel template.
 *
 * The authoring stage can produce HTML that parses, validates and still looks broken:
 * a Google font that silently fell back to Times, a headline that overran its note and
 * ran through a photo, a caption sitting on a background it cannot be read against, or
 * a generated photo so flat it reads as a smudge at thumbnail size. None of those fail
 * a DOM check. All of them are visible in a render.
 *
 * So: render every slide, then measure.
 *
 *   FONT      every declared family actually loaded (no silent fallback)
 *   OVERFLOW  no text element spills its slide or clips its own box
 *   COLLISION no text bbox overlaps a photo slot or drawn object past tolerance
 *   CONTRAST  every text run clears WCAG AA against what is actually behind it
 *   PHOTO     every generated photo has enough tonal range to read as a photo
 *
 * Exits non-zero when any check fails, so the engine cannot report success over it.
 *
 *   node scripts/verify-slides.mjs <template.html> [--out DIR] [--json]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

/** playwright is a dep of the content service, not of this workspace. */
const chromium = await (async () => {
  try {
    return (await import('playwright')).chromium;
  } catch {
    const candidates = [
      'backend/services/content/node_modules/playwright/index.js',
      'node_modules/playwright/index.js',
    ].map((p) => path.resolve(process.cwd(), p));
    for (const c of candidates) {
      if (fs.existsSync(c)) return createRequire(import.meta.url)(c).chromium;
    }
    console.error('playwright not found. Run from the repo root, or install it in this workspace.');
    process.exit(1);
  }
})();

const argv = process.argv.slice(2);
const htmlPath = path.resolve(argv.find((a) => !a.startsWith('--')) || '');
// Renders live OUTSIDE the template folder, under <root>/.renders/<source-dir>/<template>/.
// Two reasons: output/ must contain ONLY final template HTML (nothing else), and a
// per-template dir means parallel runs — agents in different chats, on different designs —
// can never overwrite each other's slide-NN.png. Keyed by source dir too, so a replica and
// a shipped template with the same slug stay separate.
const WS = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const outDir = (() => {
  const i = argv.indexOf('--out');
  if (i >= 0) return path.resolve(argv[i + 1]);
  const stem = path.basename(htmlPath).replace(/\.html?$/i, '');
  const src = path.basename(path.dirname(htmlPath));
  return path.join(WS, '.renders', src, stem);
})();
const asJson = argv.includes('--json');

if (!htmlPath || !fs.existsSync(htmlPath)) {
  console.error('usage: verify-slides.mjs <template.html> [--out DIR] [--json]');
  process.exit(1);
}

// Tolerances. Deliberately loose enough that honest design choices pass and
// the defects we have actually shipped do not.
const OVERLAP_TOL = 0.04; // >4% of a text box covered by an object = collision
const CONTRAST_MIN = 4.5; // WCAG AA, normal text
const CONTRAST_MIN_LARGE = 3.0; // AA, >=24px or >=19px bold
// A text run whose modal background passes but >= this fraction of its ACTUAL background
// is below AA is illegible over a photo/gradient. 0.5 = most of the run sits on failing
// ground; conservative enough that a scrimmed run (mostly dark) or a small bright highlight
// behind one corner does not trip it.
const CONTRAST_BAD_AREA = 0.5;
// Grey stddev below which a photo has too little tonal range to survive being
// scaled to a feed thumbnail. Calibrated against one 8-photo deck: the two
// visibly-flat photos measured 0.144, every other photo fell in 0.193-0.295.
// Provisional — n=8, single deck. Re-check once more decks have been measured.
const PHOTO_STDDEV_MIN = 0.18;
const SLIDE_W = 1080;
const SLIDE_H = 1350;

fs.mkdirSync(outDir, { recursive: true });

const relLum = ([r, g, b]) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastRatio = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const parseRgb = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((n) => parseFloat(n));
  if (p.length > 3 && p[3] === 0) return null; // fully transparent
  return [p[0], p[1], p[2]];
};
const hexRgb = (h) => {
  let x = String(h || '').trim().replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(x)) return null;
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};

// `--brand "<primary>,<accent>"` — skin the deck with a brand palette before checking.
// on-accent is derived the way the production skinner does it: whichever of black/white
// actually clears AA on that accent, so a template that ASKS for --brand-on-accent stays
// legible and one that hardcodes #fff does not.
const BRAND = (() => {
  const i = argv.indexOf('--brand');
  if (i < 0) return null;
  const [p, a] = String(argv[i + 1] || '').split(',').map((s) => s && s.trim());
  const aRgb = hexRgb(a);
  const on = aRgb
    ? contrastRatio(aRgb, [0, 0, 0]) >= contrastRatio(aRgb, [255, 255, 255])
      ? '#0a0a0a'
      : '#ffffff'
    : null;
  return { p: p || null, a: a || null, on };
})();

// Pixels come from the BROWSER, not ImageMagick. These crops used to shell to `magick`,
// which is not installed on every machine (this one included) — the call threw ENOENT,
// the functions returned null, and every caller did `if (!x) continue`, silently
// disabling CONTRAST and PHOTO on every run. That dead gate is why a deck failing 18
// contrast checks in production scored a clean `verify` here. `decodeSampled` (below)
// renders the PNG to a canvas and hands back a downsampled RGB buffer; sampling is pure JS.

/** Decode a PNG to a downsampled RGB buffer via the open page (no external binary). */
async function decodeSampled(page, pngPath, step = 3) {
  const b64 = fs.readFileSync(pngPath).toString('base64');
  const r = await page.evaluate(async ({ b64, step }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const w = Math.max(1, Math.floor(img.width / step));
    const h = Math.max(1, Math.floor(img.height / step));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false; // nearest-neighbour: keep true pixel colours, don't blend
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let s = '';
    for (let i = 0; i < d.length; i += 4) s += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
    return { w, h, b64: btoa(s) };
  }, { b64, step });
  return { w: r.w, h: r.h, step, rgb: Buffer.from(r.b64, 'base64') };
}

/** Iterate the RGB pixels of a CSS-px rect within a downsampled buffer. */
function* cropPixels(buf, x, y, w, h) {
  const s = buf.step;
  const x0 = Math.max(0, Math.floor(x / s)), y0 = Math.max(0, Math.floor(y / s));
  const x1 = Math.min(buf.w, Math.ceil((x + w) / s)), y1 = Math.min(buf.h, Math.ceil((y + h) / s));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * buf.w + px) * 3;
      yield [buf.rgb[i], buf.rgb[i + 1], buf.rgb[i + 2]];
    }
  }
}

/** Mean + stddev of a crop, in grey, normalised 0..1. */
function cropStats(buf, x, y, w, h) {
  if (!buf) return null;
  let n = 0, sum = 0, sumsq = 0;
  for (const [r, g, b] of cropPixels(buf, x, y, w, h)) {
    const gr = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    n++; sum += gr; sumsq += gr * gr;
  }
  if (!n) return null;
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sumsq / n - mean * mean)) };
}

/**
 * Modal sRGB of a crop — the colour a text run actually sits on. Quantised to 4-bit bins
 * so antialiased glyph edges and any rounded-corner paper spill collapse into the true
 * surface colour instead of shifting the sample.
 */
function cropModeRgb(buf, x, y, w, h) {
  if (!buf) return null;
  const bins = new Map();
  let best = null, bestN = -1;
  for (const [r, g, b] of cropPixels(buf, x, y, w, h)) {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const c = (bins.get(key) || 0) + 1; bins.set(key, c);
    if (c > bestN) { bestN = c; best = [r, g, b]; }
  }
  return best;
}

/**
 * Fraction of a crop's pixels that fail AA against `fg` (0..1). The modal colour is
 * blind over a PHOTO or GRADIENT: a headline over a sunset sky has no single dominant
 * colour, so the mode returns some mid pixel that passes while most of the run sits on
 * bright, illegible ground (the 2.21:1 cover the production gate caught and this one
 * missed). This measures the whole distribution: text is legible only if most of what
 * is actually behind it clears AA.
 */
function cropFractionBelowAA(buf, x, y, w, h, fg, min) {
  if (!buf) return null;
  let total = 0, below = 0;
  for (const px of cropPixels(buf, x, y, w, h)) {
    total++;
    if (contrastRatio(fg, px) < min) below++;
  }
  return total ? below / total : null;
}

const findings = [];
const photoStats = [];
const add = (slide, check, severity, message) =>
  findings.push({ slide, check, severity, message });

// The bundled playwright chromium is often not downloaded on these machines; the
// system Chrome always is. Prefer it (like build-comparison.mjs), fall back to the
// bundled browser. Launching with neither used to throw — and the caller swallowed
// the throw and scored a full verify pass, silently disabling this entire gate.
function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}
const browser = await (async () => {
  const bin = chromeBinary();
  try {
    return await chromium.launch(bin ? { executablePath: bin } : {});
  } catch (e) {
    if (bin) return await chromium.launch(); // last resort: bundled
    throw e;
  }
})();
const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H } });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);

// Single-image canvases aren't locked to the carousel's fixed 1080x1350 — content-gen supports
// 1:1 (1080x1080), 9:16 (1080x1920), and 1.91:1 (1200x628) too. Resize the viewport to the
// actual .si-page box (if present) so the element screenshot below isn't clipped or padded.
const siBox = await page.evaluate(() => {
  const el = document.querySelector('.si-single .si-page');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
});
if (siBox && siBox.w && siBox.h && (siBox.w !== SLIDE_W || siBox.h !== SLIDE_H)) {
  await page.setViewportSize({ width: siBox.w, height: siBox.h });
  await page.waitForTimeout(300);
}

// ---------- BRAND PASS ----------
// `--brand "<primary>,<accent>"` skins the deck with a brand palette before any check
// runs, exactly like the production skinner (which sets --brand-* on the root). The
// existing CONTRAST check then does the work: a template that hardcodes #fff on an
// accent-filled surface fails the moment the brand accent is light. Pair it with
// --brand-on-accent so text CAN resolve an AA-safe on-colour if it asks for one.
if (BRAND) {
  await page.evaluate(({ p, a, on }) => {
    const r = document.documentElement.style;
    if (p) r.setProperty('--brand-primary', p);
    if (a) r.setProperty('--brand-accent', a);
    if (on) r.setProperty('--brand-on-accent', on);
    if (p) r.setProperty('--brand-on-primary', '#ffffff');
  }, BRAND);
  await page.waitForTimeout(400);
}

// ---------- FONT: is every family that TEXT ACTUALLY USES loaded, at the
// weight and style it is used at? ----------
// Probing a family at a default weight/style is meaningless: a Google @import
// commonly ships only the weights it was asked for (e.g. 500/600 and no 400),
// so a check at 400 reports a fallback for a font that renders perfectly.
// Enumerate the (family, weight, style) triples in use, then verify each one.
const fontReport = await page.evaluate(() => {
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|inherit|initial|unset)$/i;
  const used = new Map();
  for (const el of document.querySelectorAll('.ig-carousel .slide *, .si-single .si-page *')) {
    if (el.children.length || !(el.textContent || '').trim()) continue;
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const first = cs.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (!first || generic.test(first)) continue;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const style = cs.fontStyle === 'italic' ? 'italic' : 'normal';
    used.set(`${first}|${weight}|${style}`, { family: first, weight, style });
  }

  const probe = (css) => {
    const s = document.createElement('span');
    s.textContent = 'Hamburgefonstiv 0123456789';
    s.style.cssText = `position:absolute;left:-9999px;font-size:72px;white-space:nowrap;${css}`;
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  };

  return [...used.values()].map(({ family, weight, style }) => {
    const spec = `font-weight:${weight};font-style:${style};`;
    const bogus = probe(`font-family:"__cg_absent__",serif;${spec}`);
    const real = probe(`font-family:"${family}",serif;${spec}`);
    return {
      family,
      weight,
      style,
      apiSaysLoaded: document.fonts.check(`${style} ${weight} 72px "${family}"`),
      widthMatchesFallback: Math.abs(real - bogus) < 0.5,
    };
  });
});
for (const f of fontReport) {
  // Trust either signal: the API is authoritative when true; the width probe
  // catches faces the API reports optimistically.
  if (!f.apiSaysLoaded && f.widthMatchesFallback) {
    add(0, 'FONT', 'fail',
      `"${f.family}" ${f.weight}${f.style === 'italic' ? ' italic' : ''} did not load — rendering in a fallback face`);
  }
}

// ---------- per-slide geometry ----------
const slides = await page.$$('.ig-carousel .slide, .si-single .si-page');
for (let i = 0; i < slides.length; i++) {
  const n = i + 1;
  const png = path.join(outDir, `slide-${String(n).padStart(2, '0')}.png`);
  await slides[i].screenshot({ path: png });

  await slides[i].scrollIntoViewIfNeeded();

  // ── descenders: g/y/p/q/j ink sliced off by the text's own clip box ────────────
  // The line-clamp contract forces display:-webkit-box + overflow:hidden. When an author
  // also sets line-height below ~1.0 (common for tight display type), the line box is
  // shorter than the font's ascent+descent, so descender ink falls outside it and is cut.
  // Measure the real ink (canvas TextMetrics) against the clip box rather than guessing.
  const clipped = await slides[i].evaluate((slide) => {
    const ctx = document.createElement('canvas').getContext('2d');
    const DESC = /[gjpqy]/;
    const clips = (h) => {
      const s = getComputedStyle(h);
      return s.overflow === 'hidden' || s.overflowY === 'hidden' || s.webkitLineClamp !== 'none';
    };
    const out = [];
    for (const el of slide.querySelectorAll('*')) {
      if (el.children.length) continue;
      if (el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let text = (el.textContent || '').trim();
      if (!text) continue;
      // uppercase-transformed text has no descenders even if the source string does
      if (cs.textTransform === 'uppercase') text = text.toUpperCase();
      if (!DESC.test(text)) continue;
      // nearest clipping box (self or a close ancestor)
      let host = null;
      for (let h = el, d = 0; h && d < 4; h = h.parentElement, d++) if (clips(h)) { host = h; break; }
      if (!host) continue;
      const F = parseFloat(cs.fontSize);
      if (!F) continue;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${F}px ${cs.fontFamily}`;
      const m = ctx.measureText(text);
      const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
      if (!isFinite(asc) || !isFinite(desc)) continue;
      let L = cs.lineHeight === 'normal' ? F * 1.2 : parseFloat(cs.lineHeight);
      if (!isFinite(L) || L <= 0) L = F * 1.2;
      const hs = getComputedStyle(host);
      const pt = parseFloat(hs.paddingTop) || 0, pb = parseFloat(hs.paddingBottom) || 0;
      const lines = Math.max(1, Math.round((host.clientHeight - pt - pb) / L));
      const halfLeading = (L - (asc + desc)) / 2;
      const inkBottom = pt + (lines - 1) * L + halfLeading + asc + desc;
      const over = inkBottom - host.clientHeight; // overflow:hidden clips at the padding box
      if (over > 1) {
        out.push({ over: Math.round(over * 10) / 10, lh: Math.round((L / F) * 100) / 100, text: text.slice(0, 40) });
      }
    }
    return out;
  });
  for (const c of clipped) {
    add(n, 'DESCENDER', 'fail',
      `descender clipped ~${c.over}px (line-height ${c.lh}) — "${c.text}" — the tail of g/y/p/q/j is cut off; raise line-height toward 1.0+ or add padding-bottom to the clipping box`);
  }

  const geo = await slides[i].evaluate((slide, tol) => {
    const box = slide.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
    const visible = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.05;
    };
    const objectOf = (el) => el && el.closest && el.closest('img[data-image="true"], svg');

    const texts = [];
    for (const el of slide.querySelectorAll('*')) {
      if (!visible(el)) continue;
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!t) continue;
      // Text that lives inside an SVG is part of the drawing, not a run over it.
      if (el.closest('svg')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;

      // Clipping only counts when a GLYPH is actually sheared by the box edge.
      //
      // `scrollHeight > clientHeight` is not that test. A line box is `line-height` tall,
      // but the ink inside it (ascenders, descenders, a display serif's overshoot) is
      // routinely taller, and Chrome reports that ink in scrollHeight. On an
      // overflow:hidden element the two differ by ~8-10px with nothing visibly cut, so
      // the naive test fires on every clamped heading. Measure the glyphs: the last line's
      // rendered rect must still sit inside the element's padding box.
      const clips = cs.overflow !== 'visible' && cs.overflow !== '';
      let clipped = false;
      if (clips) {
        const box = el.getBoundingClientRect();
        const rng = document.createRange();
        rng.selectNodeContents(el);
        const inkRects = [...rng.getClientRects()];
        rng.detach?.();
        // A glyph is cut only when its rect crosses the box edge by MORE than the
        // natural per-line ink overshoot, which scales with font size. A fixed 1.5px
        // hairline false-fired on every large display headline (a 120px face overshoots
        // its line box by 5-10px with nothing visibly cut). Tolerance ~0.18*size still
        // catches a genuine clip (a hidden partial line sits >0.5*line-height past the box).
        const tol = Math.max(2, size * 0.18);
        clipped = inkRects.some((q) => q.bottom > box.bottom + tol || q.right > box.right + tol);
        // Also catch the case where whole lines were dropped by -webkit-line-clamp —
        // but require a genuine extra line (> half a line past the clamp), not a 1px
        // rounding artifact of scrollHeight/line-height.
        const lineClamp = parseInt(cs.webkitLineClamp || cs.lineClamp || '0', 10);
        if (!clipped && lineClamp > 0) {
          const lh = parseFloat(cs.lineHeight) || size * 1.2;
          if (el.scrollHeight > (lineClamp + 0.55) * lh) clipped = true;
        }
      }

      // Sample the LINE BOXES, not the element box. A block-level headline's box
      // spans its whole column, so a decoration sitting in the empty half of that
      // box is not touching the text — measuring the element box reports a
      // collision where a reader sees none. Range rects bound the glyphs.
      const range = document.createRange();
      range.selectNodeContents(el);
      const lineRects = [...range.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
      range.detach?.();
      const boxes = lineRects.length ? lineRects : [r];

      // Occlusion, not intersection: ask what is actually painted on top.
      // An object behind the text is fine; one over it is not.
      let hits = 0, samples = 0, occluderEl = null;
      const COLS = 9, ROWS = 3;
      for (const q of boxes) {
        for (let cx = 0; cx < COLS; cx++) {
          for (let cy = 0; cy < ROWS; cy++) {
            const px = q.left + ((cx + 0.5) / COLS) * q.width;
            const py = q.top + ((cy + 0.5) / ROWS) * q.height;
            if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
            samples++;
            const top = document.elementFromPoint(px, py);
            if (!top || top === el || el.contains(top)) continue;
            const obj = objectOf(top);
            if (obj && !obj.contains(el)) { hits++; occluderEl = occluderEl || obj; }
          }
        }
      }
      const occluded = samples ? hits / samples : 0;
      const occluder = occluderEl
        ? (occluderEl.tagName.toLowerCase() === 'svg' ? 'object' : 'photo')
        : null;

      // Union of the line boxes — the tight region to sample contrast from.
      const union = boxes.reduce(
        (a, q) => ({
          left: Math.min(a.left, q.left), top: Math.min(a.top, q.top),
          right: Math.max(a.right, q.right), bottom: Math.max(a.bottom, q.bottom),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
      );

      texts.push({
        text: t.slice(0, 42),
        rect: rel(r),
        textRect: rel({ left: union.left, top: union.top, width: union.right - union.left, height: union.bottom - union.top }),
        color: cs.color,
        fontSize: size,
        isLarge: size >= 24 || (size >= 19 && weight >= 700),
        clipped,
        occluded,
        occluder,
      });
    }

    const objects = [];
    for (const el of slide.querySelectorAll('img[data-image="true"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      objects.push({ kind: 'photo', rect: rel(r) });
    }

    // Painted surfaces that give a slide visual body: cards, pills, colored panels,
    // svg shapes, bordered boxes. These are what a designer uses to FILL a frame, so
    // the coverage check must count them — not just text and photos. Skip the slide's
    // own full-bleed background layer (area ~= whole slide) so a solid page colour does
    // not read as "full"; skip tiny specks.
    const surfaces = [];
    const slideArea = box.width * box.height;
    for (const el of slide.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 0.004 * slideArea || area > 0.9 * slideArea) continue;
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const bg = cs.backgroundColor;
      const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(bg);
      const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs['border' + s + 'Width']) > 0.5)
        && cs.borderStyle !== 'none';
      const hasImg = cs.backgroundImage && cs.backgroundImage !== 'none';
      if (tag === 'svg' || tag === 'img' || hasBg || hasBorder || hasImg) surfaces.push(rel(r));
    }
    return { texts, objects, surfaces, box: { w: box.width, h: box.height } };
  }, OVERLAP_TOL);

  // Background plate: same slide with every glyph made invisible, so a contrast
  // sample measures what is BEHIND the run instead of averaging in the run itself.
  const bgPng = path.join(outDir, `slide-${String(n).padStart(2, '0')}-bg.png`);
  await page.addStyleTag({
    content: '.ig-carousel .slide *:not(svg):not(svg *),.si-single .si-page *:not(svg):not(svg *){color:transparent !important;text-shadow:none !important;}',
  }).then(async (tag) => {
    await slides[i].screenshot({ path: bgPng });
    await tag.evaluate((el) => el.remove());
  });

  // Decode both plates to RGB buffers here, once, for the CONTRAST + PHOTO checks. If
  // this fails, say so loudly — a null buffer would otherwise skip both checks silently,
  // which is exactly the dead gate this replaced.
  let bgBuf = null, mainBuf = null;
  try {
    bgBuf = await decodeSampled(page, bgPng);
    mainBuf = await decodeSampled(page, png);
  } catch (e) {
    add(n, 'CONTRAST', 'warn', `could not decode slide pixels — contrast/photo unchecked (${String(e.message).slice(0, 80)})`);
  }

  // OVERFLOW — measure the GLYPH ink (textRect = union of line boxes), not the element
  // box. A large display numeral's element box includes line-height leading that routinely
  // extends a few px past the slide edge while the visible glyph sits comfortably inside;
  // the element-box test false-failed every oversized number/headline. Tolerance scales
  // with type size so honest big type passes and a genuinely bled-off glyph still fails.
  for (const t of geo.texts) {
    const q = t.textRect || t.rect;
    const tol = Math.max(2, t.fontSize * 0.12);
    if (q.x < -tol || q.y < -tol || q.x + q.w > geo.box.w + tol || q.y + q.h > geo.box.h + tol) {
      add(n, 'OVERFLOW', 'fail', `"${t.text}" spills the slide bounds`);
    } else if (t.clipped) {
      add(n, 'OVERFLOW', 'fail', `"${t.text}" is clipped by its own box`);
    }
  }

  // COLLISION
  for (const t of geo.texts) {
    if (t.occluded > OVERLAP_TOL) {
      add(n, 'COLLISION', 'fail',
        `"${t.text}" is covered by a ${t.occluder || 'object'} over ${(t.occluded * 100).toFixed(0)}% of its area`);
    }
  }

  // CONTRAST — sampled off the glyph-free background plate.
  for (const t of geo.texts) {
    const fg = parseRgb(t.color);
    if (!fg) continue;
    const q = t.textRect || t.rect;
    const bg = cropModeRgb(bgBuf, q.x, q.y, q.w, q.h);
    if (!bg) continue;
    const ratio = contrastRatio(fg, bg);
    const min = t.isLarge ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
    if (ratio < min) {
      add(n, 'CONTRAST', 'fail',
        `"${t.text}" ${ratio.toFixed(2)}:1 against its background (AA needs ${min}:1)`);
      continue;
    }
    // The modal colour passed, but over a photo/gradient the mode is one pixel among
    // many — check the whole distribution. If most of what is actually behind the run
    // is below AA, the run is illegible even though its dominant colour cleared.
    const frac = cropFractionBelowAA(bgBuf, q.x, q.y, q.w, q.h, fg, min);
    if (frac !== null && frac >= CONTRAST_BAD_AREA) {
      add(n, 'CONTRAST', 'fail',
        `"${t.text}" sits on a varied background — ${(frac * 100).toFixed(0)}% of it is below AA (${min}:1); the run is illegible over that area`);
    }
  }

  // PHOTO — flat photos read as smudges once scaled to a feed thumbnail.
  for (const o of geo.objects.filter((o) => o.kind === 'photo')) {
    const st = cropStats(mainBuf, o.rect.x, o.rect.y, o.rect.w, o.rect.h);
    if (!st) continue;
    photoStats.push({ slide: n, mean: st.mean, stddev: st.stddev });
    if (st.stddev < PHOTO_STDDEV_MIN) {
      add(n, 'PHOTO', 'warn',
        `photo has flat tonal range (stddev ${st.stddev.toFixed(3)} < ${PHOTO_STDDEV_MIN}) — reads as a smudge`);
    }
  }

  // COVERAGE — a slide can pass every DOM/geometry check and still look empty:
  // a headline in the top third and a footer at the bottom, with a dead band of
  // blank paper between. The scorer has no other signal for this, so the model
  // has no pressure to fill the frame. Grid the slide and require content
  // (text runs, photos, AND painted surfaces/shapes) to occupy it without a large
  // contiguous empty band. Feeds the repair loop and lowers the verify score.
  {
    const W = geo.box.w, H = geo.box.h, COLS = 4, ROWS = 6;
    const cell = Array(ROWS * COLS).fill(0);
    const cw = W / COLS, ch = H / ROWS, cellArea = cw * ch;
    const rects = [
      ...geo.texts.map((t) => t.textRect || t.rect),
      ...geo.objects.map((o) => o.rect),
      ...geo.surfaces,
    ];
    for (const r of rects) {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
      if (x1 <= x0 || y1 <= y0) continue;
      for (let cy = 0; cy < ROWS; cy++) {
        for (let cx = 0; cx < COLS; cx++) {
          const ox = Math.min(x1, (cx + 1) * cw) - Math.max(x0, cx * cw);
          const oy = Math.min(y1, (cy + 1) * ch) - Math.max(y0, cy * ch);
          if (ox > 0 && oy > 0 && (ox * oy) / cellArea > 0.12) cell[cy * COLS + cx] = 1;
        }
      }
    }
    const covered = cell.reduce((a, b) => a + b, 0);
    const frac = covered / (ROWS * COLS);
    let band = 0, run = 0;
    for (let cy = 0; cy < ROWS; cy++) {
      const empty = cell.slice(cy * COLS, (cy + 1) * COLS).every((v) => !v);
      run = empty ? run + 1 : 0;
      band = Math.max(band, run);
    }
    const bandFrac = band / ROWS;
    const pct = (x) => `${Math.round(x * 100)}%`;
    // Role by position: the first slide is the cover and the last is the closer —
    // a type-forward, airier composition is a legitimate premium choice there, so
    // only flag them when genuinely empty. The interior point/list slides carry the
    // content and must FILL the frame — an airy middle slide reads as unfinished, so
    // hold them to a hard fail. This is what forces the repair loop to add a
    // surface/card or scale the type instead of leaving a dead band.
    const isEdge = (n === 1 || n === slides.length);
    const advice = 'enlarge the headline, add a surface/card/panel, or spread the composition so no band is empty';
    if (isEdge) {
      if (frac < 0.34 || bandFrac >= 0.42) {
        add(n, 'COVERAGE', 'fail', `cover/closer only ${pct(frac)} filled${bandFrac >= 0.42 ? `, ${pct(bandFrac)} empty band` : ''} — too sparse even for a type-forward slide; ${advice}`);
      } else if (frac < 0.5 || bandFrac >= 0.34) {
        add(n, 'COVERAGE', 'warn', `cover/closer ${pct(frac)} filled${bandFrac >= 0.34 ? `, ${pct(bandFrac)} empty band` : ''} — could carry more weight`);
      }
    } else {
      if (frac < 0.55 || bandFrac >= 0.28) {
        add(n, 'COVERAGE', 'fail', `content slide only ${pct(frac)} filled${bandFrac >= 0.28 ? `, ${pct(bandFrac)} of its height is an empty band` : ''} — a content slide must fill the frame; ${advice}`);
      } else if (frac < 0.68) {
        add(n, 'COVERAGE', 'warn', `content slide ${pct(frac)} filled — could carry more visual weight`);
      }
    }
  }
}

await browser.close();

const fails = findings.filter((f) => f.severity === 'fail');
const warns = findings.filter((f) => f.severity === 'warn');
const report = {
  template: htmlPath,
  slides: slides.length,
  fonts: fontReport,
  photoStats,
  findings,
  pass: fails.length === 0,
};
fs.writeFileSync(path.join(outDir, 'verify-report.json'), JSON.stringify(report, null, 2));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nverify — ${path.basename(htmlPath)} (${slides.length} slides)\n`);
  const seen = new Set();
  for (const f of fontReport) {
    const label = `${f.family} ${f.weight}${f.style === 'italic' ? 'i' : ''}`;
    if (seen.has(label)) continue;
    seen.add(label);
    const ok = f.apiSaysLoaded || !f.widthMatchesFallback;
    console.log(`  FONT  ${label.padEnd(24)} ${ok ? 'loaded' : 'FALLBACK'}`);
  }
  if (photoStats.length) {
    console.log('\n  photo tonal range (grey stddev; low = flat):');
    for (const p of photoStats) {
      const flag = p.stddev < PHOTO_STDDEV_MIN ? '  <-- flat' : '';
      console.log(`    slide ${String(p.slide).padStart(2)}  mean ${p.mean.toFixed(3)}  stddev ${p.stddev.toFixed(3)}${flag}`);
    }
  }
  console.log('');
  if (!findings.length) console.log('  no findings.');
  for (const f of findings) {
    const tag = f.severity === 'fail' ? 'FAIL' : 'warn';
    console.log(`  ${tag.padEnd(5)} slide ${String(f.slide).padStart(2)}  ${f.check.padEnd(9)} ${f.message}`);
  }
  console.log(`\n  ${fails.length} fail, ${warns.length} warn — renders in ${outDir}\n`);
}

process.exit(fails.length ? 1 : 0);
