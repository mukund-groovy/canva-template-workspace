#!/usr/bin/env node
/**
 * Multi-brand fitness audit for a carousel archetype.
 *
 * MEASURES BRAND COVERAGE DIFFERENTIALLY: a pixel is "brand-driven" iff it CHANGES
 * when --brand-primary/--brand-accent change. Colour-matching against the brand hex
 * is wrong — it counts fixed canvas/ink pixels that merely happen to sit near the
 * test brand colour (a cream paper scores 82% against a tan brand; an ink-black
 * headline scores 60% against a navy brand). The differential is immune: fixed
 * literals never move, so they never count.
 *
 *   node canva-template-workspace/scripts/brand-audit.mjs <template.html> [--out <dir>]
 *
 * Thresholds (template-agent.md):
 *   per-slide >= 1.5% brand-driven pixels
 *   deck avg  >= 3.0%
 *
 * Also writes default-palette renders to --out so you can do the collision check by eye.
 * This script CANNOT see glyph collisions.
 */
import { createRequire } from 'module';

/** playwright is a dep of the content service, not of this workspace. */
const chromium = await (async () => {
  try { return (await import('playwright')).chromium; } catch {
    const c = path.resolve(process.cwd(), 'backend/services/content/node_modules/playwright/index.js');
    if (fs.existsSync(c)) return createRequire(import.meta.url)(c).chromium;
    console.error('playwright not found. Run from the repo root.');
    process.exit(1);
  }
})();
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const htmlPath = path.resolve(argv[0] || '');
const oi = argv.indexOf('--out');
const outDir = oi > -1 ? path.resolve(argv[oi + 1]) : null;
if (!fs.existsSync(htmlPath)) { console.error(`no such file: ${htmlPath}`); process.exit(1); }
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const PER_SLIDE_MIN = 1.5;
const DECK_AVG_MIN = 3.0;
const CHANGE_TOL = 30; // RGB distance between the two renders that counts as "moved"

// Two maximally-separated brand pairs. Any pixel driven by --brand-* must differ.
const A = { primary: '#FF0000', accent: '#00FF00' };
const B = { primary: '#0000FF', accent: '#FFFF00' };

const setBrand = async (page, { primary, accent }) => {
  await page.evaluate(({ p, a }) => {
    document.documentElement.style.setProperty('--brand-primary', p);
    document.documentElement.style.setProperty('--brand-accent', a);
  }, { p: primary, a: accent });
  await page.waitForTimeout(160);
};

const grab = async (page, el) => {
  const buf = await el.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(img.width / 4);
    c.height = Math.round(img.height / 4);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  }, buf.toString('base64'));
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.waitForTimeout(2400);

const defaults = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    primary: cs.getPropertyValue('--brand-primary').trim(),
    accent: cs.getPropertyValue('--brand-accent').trim(),
  };
});

const n = (await page.$$('.ig-carousel .slide')).length;
console.log(`template : ${path.basename(htmlPath)}`);
console.log(`slides   : ${n}`);
console.log(`defaults : primary ${defaults.primary}  accent ${defaults.accent}\n`);

// default-palette renders for the human collision check
if (outDir) {
  const slides = await page.$$('.ig-carousel .slide');
  for (let i = 0; i < slides.length; i++) {
    await slides[i].screenshot({ path: path.join(outDir, `slide-${i + 1}.png`) });
  }
}

await setBrand(page, A);
const shotsA = [];
{ const s = await page.$$('.ig-carousel .slide'); for (const el of s) shotsA.push(await grab(page, el)); }

await setBrand(page, B);
const shotsB = [];
{ const s = await page.$$('.ig-carousel .slide'); for (const el of s) shotsB.push(await grab(page, el)); }

await browser.close();

const pcts = [];
for (let i = 0; i < shotsA.length; i++) {
  const a = shotsA[i], b = shotsB[i];
  let moved = 0, total = 0;
  for (let p = 0; p < a.length; p += 4) {
    total++;
    const d = Math.hypot(a[p] - b[p], a[p + 1] - b[p + 1], a[p + 2] - b[p + 2]);
    if (d > CHANGE_TOL) moved++;
  }
  pcts.push((moved / total) * 100);
}

const avg = pcts.reduce((x, y) => x + y, 0) / pcts.length;
const low = pcts.map((p, i) => (p < PER_SLIDE_MIN ? i + 1 : 0)).filter(Boolean);
const pass = !low.length && avg >= DECK_AVG_MIN;

console.log('brand-driven pixels (differential — fixed literals excluded)');
pcts.forEach((p, i) => {
  const flag = p < PER_SLIDE_MIN ? `  << ${PER_SLIDE_MIN}% MIN` : '';
  console.log(`  slide ${String(i + 1).padStart(2)}  ${p.toFixed(2).padStart(6)}%${flag}`);
});
console.log(`  ${'deck avg'.padEnd(8)}  ${avg.toFixed(2).padStart(6)}%${avg < DECK_AVG_MIN ? `  << ${DECK_AVG_MIN}% MIN` : ''}`);
if (low.length) console.log(`\n  starved slides: ${low.join(', ')}`);
if (outDir) console.log(`\n  renders → ${outDir}  (LOOK at them: collisions are invisible here)`);

console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL — give brand colour more roles (accent words, fills, CTA, tabs, rules).'}`);
process.exit(pass ? 0 : 1);
