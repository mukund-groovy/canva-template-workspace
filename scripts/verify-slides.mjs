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
const outDir = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? path.resolve(argv[i + 1]) : path.join(path.dirname(htmlPath), '.verify');
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

/** Mean + stddev of a crop, in grey, normalised 0..1. Uses ImageMagick. */
function cropStats(png, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(Math.round(w), SLIDE_W - x));
  h = Math.max(1, Math.min(Math.round(h), SLIDE_H - y));
  try {
    const out = execFileSync(
      'magick',
      [png, '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-colorspace', 'gray',
        '-format', '%[fx:mean] %[fx:standard_deviation]', 'info:'],
      { encoding: 'utf8' }
    ).trim().split(/\s+/).map(Number);
    return { mean: out[0], stddev: out[1] };
  } catch {
    return null;
  }
}

/**
 * Modal sRGB of a crop — the colour a text run actually sits on.
 * Not the mean: averaging drags antialiased glyph edges and any rounded-corner
 * spill of the surrounding paper into the sample, which shifts the ratio enough
 * to flip a genuine AA pass into a reported failure.
 */
function cropModeRgb(png, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(Math.round(w), SLIDE_W - x));
  h = Math.max(1, Math.min(Math.round(h), SLIDE_H - y));
  try {
    const out = execFileSync(
      'magick',
      [png, '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-depth', '8',
        '-format', '%c', 'histogram:info:'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    let best = null, bestN = -1;
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const cnt = +m[1];
      if (cnt > bestN) { bestN = cnt; best = [+m[2], +m[3], +m[4]]; }
    }
    return best;
  } catch {
    return null;
  }
}

const findings = [];
const photoStats = [];
const add = (slide, check, severity, message) =>
  findings.push({ slide, check, severity, message });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H } });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);

// ---------- FONT: is every family that TEXT ACTUALLY USES loaded, at the
// weight and style it is used at? ----------
// Probing a family at a default weight/style is meaningless: a Google @import
// commonly ships only the weights it was asked for (e.g. 500/600 and no 400),
// so a check at 400 reports a fallback for a font that renders perfectly.
// Enumerate the (family, weight, style) triples in use, then verify each one.
const fontReport = await page.evaluate(() => {
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|inherit|initial|unset)$/i;
  const used = new Map();
  for (const el of document.querySelectorAll('.ig-carousel .slide *')) {
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
const slides = await page.$$('.ig-carousel .slide');
for (let i = 0; i < slides.length; i++) {
  const n = i + 1;
  const png = path.join(outDir, `slide-${String(n).padStart(2, '0')}.png`);
  await slides[i].screenshot({ path: png });

  await slides[i].scrollIntoViewIfNeeded();

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
        // A glyph is cut when its rect crosses the box edge by more than a hairline.
        clipped = inkRects.some((q) => q.bottom > box.bottom + 1.5 || q.right > box.right + 1.5);
        // Also catch the case where whole lines were dropped by -webkit-line-clamp.
        const lineClamp = parseInt(cs.webkitLineClamp || cs.lineClamp || '0', 10);
        if (!clipped && lineClamp > 0) {
          const lh = parseFloat(cs.lineHeight) || size * 1.2;
          const renderedLines = Math.round(el.scrollHeight / lh);
          if (renderedLines > lineClamp) clipped = true;
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
    return { texts, objects, box: { w: box.width, h: box.height } };
  }, OVERLAP_TOL);

  // Background plate: same slide with every glyph made invisible, so a contrast
  // sample measures what is BEHIND the run instead of averaging in the run itself.
  const bgPng = path.join(outDir, `slide-${String(n).padStart(2, '0')}-bg.png`);
  await page.addStyleTag({
    content: '.ig-carousel .slide *:not(svg):not(svg *){color:transparent !important;text-shadow:none !important;}',
  }).then(async (tag) => {
    await slides[i].screenshot({ path: bgPng });
    await tag.evaluate((el) => el.remove());
  });

  // OVERFLOW
  for (const t of geo.texts) {
    const { x, y, w, h } = t.rect;
    if (x < -1 || y < -1 || x + w > geo.box.w + 1 || y + h > geo.box.h + 1) {
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
    const bg = cropModeRgb(bgPng, q.x, q.y, q.w, q.h);
    if (!bg) continue;
    const ratio = contrastRatio(fg, bg);
    const min = t.isLarge ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
    if (ratio < min) {
      add(n, 'CONTRAST', 'fail',
        `"${t.text}" ${ratio.toFixed(2)}:1 against its background (AA needs ${min}:1)`);
    }
  }

  // PHOTO — flat photos read as smudges once scaled to a feed thumbnail.
  for (const o of geo.objects.filter((o) => o.kind === 'photo')) {
    const st = cropStats(png, o.rect.x, o.rect.y, o.rect.w, o.rect.h);
    if (!st) continue;
    photoStats.push({ slide: n, mean: st.mean, stddev: st.stddev });
    if (st.stddev < PHOTO_STDDEV_MIN) {
      add(n, 'PHOTO', 'warn',
        `photo has flat tonal range (stddev ${st.stddev.toFixed(3)} < ${PHOTO_STDDEV_MIN}) — reads as a smudge`);
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
