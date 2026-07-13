#!/usr/bin/env node
/**
 * canva-to-carousel-template.mjs  — PROOF OF CONCEPT
 *
 * Converts a captured Canva `template-data.json` into a ContentGen carousel
 * template: a brand-driven, slotted HTML file + an inferred seed metadata
 * object. This is the "convert" leverage step in the clone pipeline — write it
 * once, run it over every captured design folder to mint many templates.
 *
 * What it does differently from render-template-json-html.mjs (which produces a
 * pixel-exact *static copy* of the Canva design):
 *   1. Extracts the design's color palette and remaps every hard-coded color to
 *      a `var(--brand-*)` CSS variable, matching the convention in
 *      backend/database/carousels/*.html — so the template inherits brand colors.
 *   2. Tags each text element with its Canva semantic role (title/heading/
 *      pretitle/subtitle/paragraph) as a `data-role` / `data-slot` editable slot
 *      the generation pipeline can fill.
 *   3. Infers a carousel seed object (slug, contentMode, recommendationProfile)
 *      matching the shape seeded in seed-carousel-templates.ts.
 *
 * Usage:
 *   node scripts/canva/canva-to-carousel-template.mjs \
 *     --input .tmp/canva-template-json/<ID>/template-data.json \
 *     --out-dir .tmp/canva-carousel-out \
 *     [--slug my-slug] [--name "My Template"] [--category general]
 *
 * Outputs into --out-dir:
 *   <slug>.html        brand-driven, slotted carousel HTML (1 .slide per page)
 *   <slug>.seed.json   inferred carousel seed metadata object
 *   <slug>.report.json palette map, role counts, and conversion notes
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

const arr = (v) => (Array.isArray(v) ? v : []);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const px = (v) => `${Number(v || 0).toFixed(3)}px`;

function cssSingleQuoted(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'canva-template';
}

// ---------------------------------------------------------------------------
// Canva text-run grammar (ported from render-template-json-html.mjs)
// ---------------------------------------------------------------------------
function fixMojibake(text) {
  return String(text || '')
    .replace(/â€™/g, '’')
    .replace(/â€˜/g, '‘')
    .replace(/â€œ/g, '“')
    .replace(/â€/g, '”')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—');
}

function mergeStyle(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'B')) {
      out[k] = v.B;
    } else if (v && typeof v === 'object' && Object.keys(v).length === 0) {
      delete out[k];
    }
  }
  return out;
}

function toSegments(textRuns, text) {
  const runs = arr(textRuns);
  let cursor = 0;
  let style = {};
  const segs = [];
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    if (r['A?'] === 'A') {
      style = mergeStyle(style, r.A || {});
      continue;
    }
    if (r['A?'] === 'B') {
      const n = Number(r.A || 0);
      if (n <= 0) continue;
      segs.push({ text: String(text || '').slice(cursor, cursor + n), style: { ...style } });
      cursor += n;
    }
  }
  if (cursor < String(text || '').length) {
    segs.push({ text: String(text || '').slice(cursor), style: { ...style } });
  }
  return segs.length ? segs : [{ text: String(text || ''), style: {} }];
}

function fontStyleToWeight(style) {
  const map = { THIN: 100, EXTRA_LIGHT: 200, LIGHT: 300, REGULAR: 400, MEDIUM: 500, SEMI_BOLD: 600, BOLD: 700, ULTRA_BOLD: 800, HEAVY: 900 };
  return map[style] || 400;
}

// ---------------------------------------------------------------------------
// color helpers + palette classification
// ---------------------------------------------------------------------------
function normalizeHex(c) {
  if (!c || typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((ch) => ch + ch).join('');
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = s.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseInt(x, 10));
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}

function hexToRgb(hex) {
  const s = hex.replace('#', '');
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

// relative luminance 0..1
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// saturation 0..1 (HSL)
function saturation(hex) {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/**
 * Classify the design's colors into brand roles and produce:
 *  - varDecls: the `:root` CSS variable declarations (brand-driven, with the
 *    extracted hex as the fallback), matching the carousels/*.html convention
 *  - colorToVar: map of exact source hex -> `var(--x)` for rewriting styles
 */
function buildPalette(colorFreq) {
  const entries = Object.entries(colorFreq)
    .map(([hex, count]) => ({ hex, count, lum: luminance(hex), sat: saturation(hex) }))
    .sort((a, b) => b.count - a.count);

  const light = entries.filter((e) => e.lum > 0.82);
  const dark = entries.filter((e) => e.lum < 0.22);
  const chromatic = entries.filter((e) => e.sat > 0.15 && e.lum >= 0.22 && e.lum <= 0.82);

  const bgHex = (light[0] || entries.find((e) => e.lum > 0.6) || { hex: '#ffffff' }).hex;
  const inkHex = (dark[0] || entries.find((e) => e.lum < 0.4) || { hex: '#111111' }).hex;
  const primHex = (chromatic[0] || entries.find((e) => e.sat > 0.1) || { hex: inkHex }).hex;
  const secHex = (chromatic[1] || chromatic[0] || { hex: primHex }).hex;
  const accHex = (chromatic[2] || chromatic[1] || chromatic[0] || { hex: secHex }).hex;

  const surfaceHex = (light[1] || { hex: bgHex }).hex;
  const inkLowHex = (dark[1] || { hex: inkHex }).hex;

  const varDecls = {
    '--primary': `var(--brand-primary, ${primHex})`,
    '--secondary': `var(--brand-secondary, ${secHex})`,
    '--accent': `var(--brand-accent, ${accHex})`,
    '--bg': `var(--brand-bg, ${bgHex})`,
    '--surface': `var(--brand-surface, var(--brand-bg-alt, ${surfaceHex}))`,
    '--text-high': `var(--brand-ink, var(--brand-text, ${inkHex}))`,
    '--text-low': `var(--brand-text-muted, ${inkLowHex})`,
    '--on-primary': `var(--brand-on-primary, #ffffff)`,
    '--on-accent': `var(--brand-on-accent, #ffffff)`,
  };

  // Map every seen color to the nearest role var so style rewriting is total.
  const roleByHex = {};
  for (const e of entries) {
    if (e.hex === bgHex) roleByHex[e.hex] = 'var(--bg)';
    else if (e.hex === surfaceHex && e.lum > 0.82) roleByHex[e.hex] = 'var(--surface)';
    else if (e.hex === inkHex || e.hex === inkLowHex) roleByHex[e.hex] = 'var(--text-high)';
    else if (e.hex === primHex) roleByHex[e.hex] = 'var(--primary)';
    else if (e.hex === secHex) roleByHex[e.hex] = 'var(--secondary)';
    else if (e.hex === accHex) roleByHex[e.hex] = 'var(--accent)';
    else {
      // nearest by luminance bucket
      if (e.lum > 0.82) roleByHex[e.hex] = 'var(--bg)';
      else if (e.lum < 0.22) roleByHex[e.hex] = 'var(--text-high)';
      else roleByHex[e.hex] = 'var(--accent)';
    }
  }

  return { varDecls, roleByHex, resolved: { bgHex, inkHex, primHex, secHex, accHex } };
}

// ---------------------------------------------------------------------------
// parse the design into pages / elements / palette / roles
// ---------------------------------------------------------------------------
function analyze(data) {
  const colorFreq = {};
  const roleCounts = {};
  const textByRole = {};
  let mediaCount = arr(data.media).length;
  let imageElements = 0;

  const addColor = (c) => {
    const hex = normalizeHex(typeof c === 'object' && c && c.B ? c.B : c);
    if (hex) colorFreq[hex] = (colorFreq[hex] || 0) + 1;
  };

  for (const pg of arr(data.pages)) {
    addColor(pg?.D?.C);
    for (const el of arr(pg.E)) {
      const t = el['A?'];
      if (t === 'K') {
        const role = el.N || 'text';
        roleCounts[role] = (roleCounts[role] || 0) + 1;
        const text = fixMojibake(arr(el?.a?.A).map((x) => x.A || '').join('')).trim();
        if (text) (textByRole[role] = textByRole[role] || []).push(text);
        for (const r of arr(el?.a?.B)) {
          if (r && r['A?'] === 'A' && r.A && r.A.color) addColor(r.A.color);
        }
      } else if (t === 'J') {
        const shp = arr(el.b)[0] || {};
        addColor(shp?.B?.C || shp?.C);
        if (el.c && el.c.C) addColor(el.c.C);
      } else if (t === 'I') {
        imageElements++;
      }
    }
  }

  return { colorFreq, roleCounts, textByRole, mediaCount, imageElements };
}

// ---------------------------------------------------------------------------
// render brand-driven, slotted HTML
// ---------------------------------------------------------------------------
function buildFontFaces(data) {
  const fontEntries = arr(data.fonts);
  const usedFontIds = new Set();
  const fontNameById = {};
  for (const pg of arr(data.pages)) {
    for (const el of arr(pg.E)) {
      for (const r of arr(el?.a?.B)) {
        if (r && r['A?'] === 'A' && r.A && r.A['font-family'] && r.A['font-family'].B) {
          usedFontIds.add(String(r.A['font-family'].B).split(',')[0]);
        }
      }
    }
  }
  const blocks = [];
  for (const id of usedFontIds) {
    const entry = fontEntries.find((f) => f.A === id);
    if (!entry) continue;
    fontNameById[id] = entry.C || id;
    for (const st of arr(entry.D)) {
      const files = arr(st.files);
      const file = files.find((f) => f.format === 'WOFF2') || files.find((f) => f.format === 'WOFF') || files.find((f) => f.format === 'OTF' || f.format === 'TTF');
      if (!file || !file.url) continue;
      const styleName = String(st.style || 'REGULAR');
      const isItalic = styleName.includes('ITALIC');
      const weight = fontStyleToWeight(styleName.replace('_ITALICS', '').replace('_ITALIC', ''));
      const fmt = (file.format || 'woff2').toLowerCase();
      blocks.push(`@font-face{font-family:${JSON.stringify(entry.C || id)};src:url(${JSON.stringify(file.url)}) format('${fmt}');font-weight:${weight};font-style:${isItalic ? 'italic' : 'normal'};font-display:swap;}`);
    }
  }
  return { fontFaceBlocks: blocks, fontNameById };
}

function cssForStyle(style, fontNameById, roleByHex) {
  const out = [];
  if (style.color) {
    const hex = normalizeHex(style.color);
    out.push(`color:${hex && roleByHex[hex] ? roleByHex[hex] : style.color}`);
  }
  if (style['font-size']) out.push(`font-size:${Number(style['font-size']).toFixed(3)}px`);
  if (style['font-family']) {
    const id = String(style['font-family']).split(',')[0];
    out.push(`font-family:${cssSingleQuoted(fontNameById[id] || 'sans-serif')},sans-serif`);
  }
  if (style['font-weight']) {
    const w = String(style['font-weight']).toLowerCase();
    const map = { normal: 400, medium: 500, semibold: 600, bold: 700 };
    out.push(`font-weight:${map[w] || 400}`);
  }
  if (style['font-style']) out.push(`font-style:${style['font-style']}`);
  if (style['text-transform']) out.push(`text-transform:${style['text-transform']}`);
  if (style['text-align']) out.push(`text-align:${style['text-align']}`);
  if (style.leading) {
    const lh = Number(style.leading) / 1000;
    if (Number.isFinite(lh) && lh > 0) out.push(`line-height:${lh}`);
  }
  if (style.tracking) {
    const ls = Number(style.tracking) / 1000;
    if (Number.isFinite(ls) && ls !== 0) out.push(`letter-spacing:${ls}em`);
  }
  return out.join(';');
}

function renderHtml(data, palette, fonts) {
  const { roleByHex, varDecls } = palette;
  const { fontFaceBlocks, fontNameById } = fonts;
  const docW = Number(data?.docSize?.A || 1080);
  const docH = Number(data?.docSize?.B || 1350);
  const slotSeq = {};

  function renderText(el, pageIdx) {
    const role = el.N || 'text';
    slotSeq[role] = (slotSeq[role] || 0) + 1;
    const slotId = `${role}-${pageIdx + 1}-${slotSeq[role]}`;
    const text = fixMojibake(arr(el?.a?.A).map((x) => x.A || '').join(''));
    const segs = toSegments(el?.a?.B, text);
    const first = segs[0]?.style || {};
    const alignCss = cssForStyle({ 'text-align': first['text-align'], leading: first.leading, 'text-transform': first['text-transform'] }, fontNameById, roleByHex);
    const left = Number(el.A) > docW && Number(el.A) - Number(el.D) >= 0 ? Number(el.A) - Number(el.D) : Number(el.A);
    const container = ['position:absolute', `left:${px(left)}`, `top:${px(el.B)}`, `width:${px(el.D)}`, `height:${px(el.C)}`, 'white-space:normal', 'overflow:visible', alignCss].filter(Boolean).join(';');
    const inner = segs.map((s) => `<span style="${cssForStyle(s.style, fontNameById, roleByHex)}">${escapeHtml(s.text).replace(/\n/g, '<br>')}</span>`).join('');
    return `<div class="el text" data-role="${escapeHtml(role)}" data-slot="${escapeHtml(slotId)}" style="${container}">${inner}</div>`;
  }

  function renderShape(el) {
    const shape = arr(el.b)[0] || {};
    const pathD = shape.A || '';
    const fill = shape.B || {};
    const stroke = shape.C || {};
    const common = ['position:absolute', `left:${px(el.A)}`, `top:${px(el.B)}`, `width:${px(el.D)}`, `height:${px(el.C)}`];
    const isRect = pathD === 'M0 0H64V64H0z';
    const isCircle = pathD.startsWith('M32 0A32 32');
    const mapColor = (c) => {
      const hex = normalizeHex(c);
      return hex && roleByHex[hex] ? roleByHex[hex] : c || 'transparent';
    };
    if (isRect || isCircle) {
      const style = [...common, `background:${mapColor(fill.C)}`];
      if (stroke.B) style.push(`border:${Number(stroke.A || 1)}px solid ${mapColor(stroke.B)}`);
      if (isCircle) style.push('border-radius:50%');
      return `<div class="el shape" style="${style.join(';')}"></div>`;
    }
    const vbW = Number(el?.a?.D || 64);
    const vbH = Number(el?.a?.C || 64);
    return `<svg class="el shape-svg" style="${common.join(';')}" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none"><path d="${escapeHtml(pathD)}" fill="${escapeHtml(mapColor(fill.C))}" stroke="${escapeHtml(stroke.B ? mapColor(stroke.B) : 'none')}" stroke-width="${Number(stroke.A || 0)}"></path></svg>`;
  }

  function renderElement(el, pageIdx) {
    const t = el['A?'];
    if (t === 'K') return renderText(el, pageIdx);
    if (t === 'J') return renderShape(el);
    // Images (type 'I') are intentionally dropped in POC: brand templates use
    // their own imagery via contentMode, not the source design's licensed media.
    return '';
  }

  const slides = arr(data.pages)
    .map((pg, i) => {
      const bgHex = normalizeHex(pg?.D?.C);
      const bg = bgHex && roleByHex[bgHex] ? roleByHex[bgHex] : (pg?.D?.C || 'var(--bg)');
      const items = arr(pg.E).map((el) => renderElement(el, i)).join('\n      ');
      return `    <section class="slide" data-slide="${i + 1}" style="background:${bg}">
      ${items}
    </section>`;
    })
    .join('\n');

  const rootVars = Object.entries(varDecls).map(([k, v]) => `        ${k}: ${v};`).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
${fontFaceBlocks.join('\n')}
      :root {
${rootVars}
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      .ig-carousel { display: flex; gap: 0; }
      .slide {
        width: ${docW}px;
        height: ${docH}px;
        flex-shrink: 0;
        position: relative;
        overflow: hidden;
        background: var(--bg);
        color: var(--text-high);
      }
      .el { pointer-events: none; }
      .el.text { pointer-events: auto; }
    </style>
  </head>
  <body>
    <div class="ig-carousel">
${slides}
    </div>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// infer seed metadata object
// ---------------------------------------------------------------------------
function inferContentMode(a) {
  if (a.imageElements > 0 || a.mediaCount > 0) {
    // Heuristic: a single large media across pages reads as background; a few
    // discrete images read as compositional. POC keeps it simple.
    return a.imageElements > a.mediaCount ? 'text-images' : 'background-images';
  }
  return 'text-only';
}

const STOP = new Set(['the', 'and', 'for', 'your', 'you', 'with', 'this', 'that', 'www', 'com', 'https', 'http', 'swipe', 'more']);

function inferTags(textByRole) {
  const freq = {};
  for (const texts of Object.values(textByRole)) {
    for (const t of texts) {
      for (const w of String(t).toLowerCase().match(/[a-z]{3,}/g) || []) {
        if (STOP.has(w)) continue;
        freq[w] = (freq[w] || 0) + 1;
      }
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([w]) => w);
}

function buildSeedObject(data, analysis, palette, opts) {
  const title = opts.name || data.title || 'Canva Template';
  const slug = opts.slug || slugify(title);
  const pageCount = arr(data.pages).length;
  const contentMode = inferContentMode(analysis);
  const tags = inferTags(analysis.textByRole);

  return {
    name: title,
    slug,
    description: opts.description || `Imported from Canva design ${data.designId || ''}`.trim(),
    category: opts.category || 'general',
    order: 0,
    enabled: false, // POC imports land disabled until reviewed
    isSystem: true,
    contentMode,
    recommendationProfile: {
      version: 1,
      title,
      summary: `${title} — imported carousel layout with ${pageCount} slides.`,
      tags,
      useCases: ['tips', 'educational', 'listicle'],
      tone: 'professional',
      contentMode,
      visualStyle: [],
      slideCountSweet: {
        min: Math.max(3, pageCount - 2),
        ideal: pageCount,
        max: pageCount + 3,
      },
      industries: [],
      audience: [],
    },
    _meta: {
      sourceDesignId: data.designId || null,
      sourceTitle: data.title || null,
      docSize: data.docSize || null,
      roleCounts: analysis.roleCounts,
      palette: palette.resolved,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    throw new Error('Missing --input <template-data.json>. See file header for usage.');
  }
  const inputPath = path.resolve(args.input);
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const analysis = analyze(data);
  const palette = buildPalette(analysis.colorFreq);
  const fonts = buildFontFaces(data);
  const seed = buildSeedObject(data, analysis, palette, args);

  const outDir = path.resolve(args['out-dir'] || path.join(path.dirname(inputPath), 'carousel-out'));
  fs.mkdirSync(outDir, { recursive: true });

  const html = renderHtml(data, palette, fonts);
  const htmlPath = path.join(outDir, `${seed.slug}.html`);
  const seedPath = path.join(outDir, `${seed.slug}.seed.json`);
  const reportPath = path.join(outDir, `${seed.slug}.report.json`);

  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2), 'utf8');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        input: inputPath,
        pages: arr(data.pages).length,
        roleCounts: analysis.roleCounts,
        colorFreq: analysis.colorFreq,
        palette: palette.varDecls,
        resolvedPalette: palette.resolved,
        contentMode: seed.contentMode,
        tags: seed.recommendationProfile.tags,
        droppedImages: analysis.imageElements,
        notes: [
          'contentMode/tags/tone are heuristic — review before enabling.',
          'Image elements are dropped; brand templates supply their own imagery.',
          'Colors remapped to var(--brand-*) with source hex as fallback.',
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(JSON.stringify({ slug: seed.slug, contentMode: seed.contentMode, pages: arr(data.pages).length, roles: analysis.roleCounts, html: htmlPath, seed: seedPath, report: reportPath }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
