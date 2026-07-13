#!/usr/bin/env node
/**
 * render-clean-layout.mjs — DIRECTION #1 (structure -> designed layout)
 *
 * Instead of tracing Canva's absolute coordinates (which overflow/overlap when
 * reflowed into HTML), this reads the *content + roles + palette* extracted from
 * a Canva design and renders it onto a clean, hand-designed flow layout — the
 * same quality bar as backend/database/carousels/*.html. Fully brand-driven
 * (var(--brand-*)) and text-slotted.
 *
 * Usage:
 *   node scripts/canva/render-clean-layout.mjs \
 *     --input .tmp/canva-template-json/<ID>/template-data.json \
 *     --output .tmp/canva-carousel-out/<slug>-clean.html
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}
const arr = (v) => (Array.isArray(v) ? v : []);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fix = (s) => String(s || '').replace(/â€™/g, '’').replace(/â€œ/g, '“').replace(/â€/g, '”').replace(/â€“/g, '–').replace(/\n+/g, ' ').trim();

// --- palette (luminance/saturation classification, same as converter) ---
function normHex(c) {
  if (!c || typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((x) => x + x).join('');
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
function lum(h) {
  const { r, g, b } = rgb(h);
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function sat(h) {
  const { r, g, b } = rgb(h);
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2, d = mx - mn;
  return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
}

function extract(data) {
  const colorFreq = {};
  const add = (c) => { const h = normHex(typeof c === 'object' && c ? c.B : c); if (h) colorFreq[h] = (colorFreq[h] || 0) + 1; };
  const slides = arr(data.pages).map((pg) => {
    add(pg?.D?.C);
    const byRole = {};
    for (const el of arr(pg.E)) {
      if (el['A?'] === 'K') {
        const r = el.N || 'text';
        const t = fix(arr(el?.a?.A).map((x) => x.A || '').join(''));
        if (t) (byRole[r] = byRole[r] || []).push(t);
        for (const run of arr(el?.a?.B)) if (run?.['A?'] === 'A' && run.A?.color) add(run.A.color);
      } else if (el['A?'] === 'J') {
        const shp = arr(el.b)[0] || {};
        add(shp?.B?.C || shp?.C);
      }
    }
    return byRole;
  });
  return { slides, colorFreq };
}

function palette(colorFreq) {
  const e = Object.entries(colorFreq).map(([hex, c]) => ({ hex, c, l: lum(hex), s: sat(hex) })).sort((a, b) => b.c - a.c);
  const light = e.filter((x) => x.l > 0.82);
  const dark = e.filter((x) => x.l < 0.22);
  const chrom = e.filter((x) => x.s > 0.15 && x.l >= 0.22 && x.l <= 0.82);
  return {
    bg: (light[0] || { hex: '#ffffff' }).hex,
    ink: (dark[0] || { hex: '#111111' }).hex,
    accent: (chrom[0] || dark[0] || { hex: '#ffde59' }).hex,
    accent2: (chrom[1] || chrom[0] || { hex: '#af993f' }).hex,
  };
}

// Highlight the last word of a title so a key word gets the accent marker —
// mirrors the "highlighted word" look common to these Canva carousels.
function markTitle(title) {
  const words = String(title).trim().split(/\s+/);
  if (words.length < 2) return `<span class="mark">${esc(title)}</span>`;
  const last = words.pop();
  return `${esc(words.join(' '))} <span class="mark">${esc(last)}</span>`;
}

function slideHtml(byRole, i, total, pal) {
  const num = String(i + 1).padStart(2, '0');
  const totalStr = String(total).padStart(2, '0');
  const eyebrow = (byRole.pretitle || [])[0] || '';
  const badge = (byRole.pretitle || [])[1] || '';
  const title = (byRole.title || [])[0] || '';
  const subtitle = (byRole.subtitle || [])[0] || (byRole.paragraph || [])[0] || '';
  const isCover = i === 0;
  const isOutro = i === total - 1 && /save|follow|swipe|thanks|forget/i.test(title);

  const header = `<div class="hd">
        <span class="eyebrow" data-role="pretitle" data-slot="pretitle-${num}-1">${esc(eyebrow)}</span>
        ${badge ? `<span class="badge" data-role="pretitle" data-slot="pretitle-${num}-2">${esc(badge)}</span>` : ''}
      </div>`;
  const footer = `<div class="ft">
        <span class="pg">${num} / ${totalStr}</span>
        <span class="swipe">${isOutro ? 'Save this ✦' : 'Swipe →'}</span>
      </div>`;

  if (isCover) {
    return `<section class="slide cover" data-slide="${i + 1}">
      ${header}
      <div class="body">
        <h1 class="title xl" data-role="title" data-slot="title-${num}-1">${markTitle(title)}</h1>
      </div>
      ${footer}
    </section>`;
  }
  if (isOutro) {
    return `<section class="slide outro" data-slide="${i + 1}">
      ${header}
      <div class="body center">
        <div class="ring">✦</div>
        <h1 class="title lg" data-role="title" data-slot="title-${num}-1">${esc(title)}</h1>
      </div>
      ${footer}
    </section>`;
  }
  return `<section class="slide" data-slide="${i + 1}">
      ${header}
      <div class="body">
        <div class="idx">${num}</div>
        <h2 class="title" data-role="title" data-slot="title-${num}-1">${markTitle(title)}</h2>
        ${subtitle ? `<p class="sub" data-role="subtitle" data-slot="subtitle-${num}-1">${esc(subtitle)}</p>` : ''}
      </div>
      ${footer}
    </section>`;
}

function build(data) {
  const { slides, colorFreq } = extract(data);
  const pal = palette(colorFreq);
  const total = slides.length;
  const body = slides.map((s, i) => slideHtml(s, i, total, pal)).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;800&family=Inter:wght@400;500;600&display=swap');
      :root {
        --primary: var(--brand-primary, ${pal.ink});
        --accent: var(--brand-accent, ${pal.accent});
        --accent-2: var(--brand-secondary, ${pal.accent2});
        --bg: var(--brand-bg, ${pal.bg});
        --ink: var(--brand-ink, var(--brand-text, ${pal.ink}));
        --ink-low: var(--brand-text-muted, color-mix(in srgb, ${pal.ink} 55%, ${pal.bg}));
        --on-accent: var(--brand-on-accent, #111111);
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      .ig-carousel { display: flex; gap: 0; }
      .slide {
        width: 1080px; height: 1350px; flex-shrink: 0; position: relative;
        background: var(--bg); color: var(--ink);
        font-family: 'Inter', sans-serif;
        padding: 96px; display: flex; flex-direction: column; justify-content: space-between;
        overflow: hidden;
      }
      .hd { display: flex; align-items: center; justify-content: space-between; }
      .eyebrow { font-size: 26px; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; color: var(--ink-low); }
      .badge { font-size: 24px; font-weight: 700; letter-spacing: .1em; color: var(--on-accent);
        background: var(--accent); padding: 10px 22px; border-radius: 999px; }
      .body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
      .body.center { align-items: center; text-align: center; gap: 40px; }
      .idx { font-family: 'Sora'; font-size: 40px; font-weight: 800; color: var(--accent);
        border-bottom: 6px solid var(--accent); width: fit-content; padding-bottom: 6px; margin-bottom: 40px; }
      .title { font-family: 'Sora', sans-serif; font-weight: 800; line-height: 1.03; letter-spacing: -0.02em; font-size: 96px; }
      .title.xl { font-size: 150px; line-height: 0.98; }
      .title.lg { font-size: 120px; }
      .mark { background: var(--accent); color: var(--on-accent); padding: 0 .12em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      .sub { margin-top: 44px; font-size: 40px; line-height: 1.45; font-weight: 400; color: var(--ink-low); max-width: 80%; }
      .ring { width: 150px; height: 150px; border-radius: 50%; display: grid; place-items: center;
        font-size: 64px; color: var(--on-accent); background: var(--accent); }
      .ft { display: flex; align-items: center; justify-content: space-between;
        font-size: 26px; font-weight: 600; color: var(--ink-low); }
      .swipe { color: var(--ink); font-weight: 700; }
      .cover .title { text-transform: none; }
    </style>
  </head>
  <body>
    <div class="ig-carousel">
${body}
    </div>
  </body>
</html>`;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.input) throw new Error('Missing --input <template-data.json>');
  const inPath = path.resolve(a.input);
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const outPath = a.output ? path.resolve(a.output) : path.join(path.dirname(inPath), 'clean-layout.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, build(data), 'utf8');
  console.log(JSON.stringify({ output: outPath, slides: arr(data.pages).length }, null, 2));
}
try { main(); } catch (e) { console.error(e?.stack || String(e)); process.exit(1); }
