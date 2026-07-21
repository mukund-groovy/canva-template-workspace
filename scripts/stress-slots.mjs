#!/usr/bin/env node
/**
 * stress-slots.mjs — does the template survive the text the GENERATOR will put in it?
 *
 * verify-slides.mjs renders the template with the copy the author wrote. That proves
 * nothing: the author picks text that fits. In production an LLM writes the headline, and
 * a three-line headline in a slot sized for two grows straight down through the body copy.
 * That shipped, and no gate caught it, because every check ran against the author's copy.
 *
 * This fills every slot with realistic worst-case content, re-renders, and looks for
 * overflow and text-on-text collisions. A template only passes if it holds at the long end.
 *
 *   node scripts/stress-slots.mjs <template.html> [--json]
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const chromium = await (async () => {
  try { return (await import('playwright')).chromium; } catch {
    const c = path.resolve(process.cwd(), 'backend/services/content/node_modules/playwright/index.js');
    if (fs.existsSync(c)) return createRequire(import.meta.url)(c).chromium;
    console.error('playwright not found — run from the repo root.'); process.exit(1);
  }
})();

const argv = process.argv.slice(2);
const file = path.resolve(argv.find((a) => !a.startsWith('--')) || '');
const asJson = argv.includes('--json');
if (!file || !fs.existsSync(file)) {
  console.error('usage: stress-slots.mjs <template.html> [--json]');
  process.exit(1);
}

// Lengths taken from real generated posts, then pushed one notch past the worst seen.
const CASES = [
  { name: 'typical', title: 'Revamp Content Review', message: 'Streamline your entire review process with an AI-powered platform.' },
  { name: 'long', title: 'Revolutionize Your Entire Content Workflow', message: 'A reply is worth more than a post, and people always remember being answered quickly and with real care.' },
  { name: 'worst', title: 'Maximize SEO Performance With A Smarter Content Approval Workflow', message: 'Setting the right key performance indicators is crucial for any content team that wants accountability, measurable success, and a repeatable publishing rhythm that survives contact with a real deadline.' },
];

// The brand skin substitutes the brand's own face at render time, and its metrics are
// wider than our serif — the same headline gains a line and shoves the copy into the
// photo. Stress under a substituted font, not the author's.
const BRAND_FONT =
  "@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap');" +
  " .slide, .slide *, .si-page, .si-page *{font-family:'Plus Jakarta Sans',sans-serif !important;}";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });

/** A reload drops injected styles, so re-apply the substituted face every time. */
async function loadFresh() {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: BRAND_FONT });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
}
await loadFresh();

// Single-image canvases aren't locked to 1080x1350 (see verify-slides.mjs for the same fix) —
// resize the viewport to the real .si-page box so stress text isn't measured against a clipped
// or padded frame.
const siBox = await page.evaluate(() => {
  const el = document.querySelector('.si-page');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
});
if (siBox && siBox.w && siBox.h && (siBox.w !== 1080 || siBox.h !== 1350)) {
  await page.setViewportSize({ width: siBox.w, height: siBox.h });
  await page.waitForTimeout(300);
}

const findings = [];
for (const c of CASES) {
  const res = await page.evaluate(({ title, message, caseName }) => {
    document.querySelectorAll('[data-title="true"]').forEach((e) => { e.textContent = title; });
    // Single-image's own class-based slots (no data-title/data-message attribute convention —
    // see check-template-contract.mjs's S3 rule): stress the same worst-case copy directly.
    document.querySelectorAll('h1.headline').forEach((e) => { e.textContent = title; });
    document.querySelectorAll('p.body').forEach((e) => { e.textContent = message; });
    document.querySelectorAll('[data-message="true"]').forEach((e) => { e.textContent = message; });

    const out = [];

    // AUTOFIT: replicate backend/services/content/src/utils/renderAutoFit.ts:overflowRatio.
    //
    // When a slide overflows, applyRenderAutoFit stamps an absolute inline font-size on
    // EVERY element under the slide (`root.querySelectorAll('*')`) — including an inline
    // `<span class="accent">` inside a headline. The editor then resizes the block, the
    // span keeps its stamped size, and only part of the headline scales. That is the
    // "only one word resizes" bug: a SYMPTOM of overflow, not an editor defect. Shipped
    // templates fit, never trigger autofit, and resize correctly.
    //
    // So: a template that never overflows never gets stamped. Assert that here.
    document.querySelectorAll('.slide, .si-page').forEach((slide, i) => {
      const rootRect = slide.getBoundingClientRect();
      const frameH = rootRect.height || 1350;
      let ratio = 0, sawInFlow = false;
      for (const el of slide.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const pos = getComputedStyle(el).position;
        if (pos === 'absolute' || pos === 'fixed') continue;
        sawInFlow = true;
        const belowH = (rect.bottom - rootRect.top) / frameH;
        if (belowH > ratio) ratio = belowH;
      }
      if (!sawInFlow) ratio = slide.scrollHeight / frameH;
      if (ratio > 1.004) {
        out.push({ case: caseName, slide: i + 1, kind: 'AUTOFIT-TRIGGER',
                   text: `overflow ratio ${ratio.toFixed(3)} — renderAutoFit will stamp inline font-size on every element (breaks editor resize)` });
      }
    });

    document.querySelectorAll('.slide, .si-page').forEach((slide, i) => {
      const sr = slide.getBoundingClientRect();
      const texts = [...slide.querySelectorAll('*')].filter(
        (e) => !e.children.length && (e.textContent || '').trim() && !e.closest('svg')
      );

      // 1. spilling the slide
      for (const t of texts) {
        const r = t.getBoundingClientRect();
        if (r.bottom > sr.bottom + 2 || r.right > sr.right + 2 || r.top < sr.top - 2 || r.left < sr.left - 2) {
          out.push({ case: caseName, slide: i + 1, kind: 'OVERFLOW', text: t.textContent.trim().slice(0, 30) });
        }
      }

      // 2. text drawn on top of other text
      for (let a = 0; a < texts.length; a++) {
        for (let b = a + 1; b < texts.length; b++) {
          const ea = texts[a], eb = texts[b];
          if (ea.contains(eb) || eb.contains(ea)) continue;
          const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
          const ox = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
          const oy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
          if (ox * oy > 400) {
            out.push({ case: caseName, slide: i + 1, kind: 'TEXT-COLLISION',
                       text: `"${ea.textContent.trim().slice(0, 20)}" over "${eb.textContent.trim().slice(0, 20)}"`,
                       areaPx: Math.round(ox * oy) });
          }
        }
      }

      // 3. text running under a photo or a drawn object.
      // Checking text-vs-text only is not enough: a grown headline pushes the body copy
      // down beneath the phone mockup, which reads as broken and passed the text-only test.
      // Sample the glyph line boxes and ask what is actually painted on top.
      const objectOf = (el) => el && el.closest && el.closest('img, svg');
      for (const t of texts) {
        const range = document.createRange();
        range.selectNodeContents(t);
        const lines = [...range.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
        range.detach?.();
        let hits = 0, samples = 0, occluder = null;
        for (const q of lines) {
          for (let cx = 0; cx < 7; cx++) {
            for (let cy = 0; cy < 3; cy++) {
              const px = q.left + ((cx + 0.5) / 7) * q.width;
              const py = q.top + ((cy + 0.5) / 3) * q.height;
              if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
              samples++;
              const top = document.elementFromPoint(px, py);
              if (!top || top === t || t.contains(top)) continue;
              const obj = objectOf(top);
              if (obj && !obj.contains(t)) { hits++; occluder = occluder || (obj.tagName.toLowerCase() === 'svg' ? 'object' : 'photo'); }
            }
          }
        }
        const frac = samples ? hits / samples : 0;
        if (frac > 0.04) {
          out.push({ case: caseName, slide: i + 1, kind: 'TEXT-UNDER-' + (occluder || 'OBJECT').toUpperCase(),
                     text: `"${t.textContent.trim().slice(0, 26)}" covered ${(frac * 100).toFixed(0)}%` });
        }
      }
    });
    return out;
  }, { title: c.title, message: c.message, caseName: c.name });
  findings.push(...res);
  await loadFresh();
}

await browser.close();

if (asJson) console.log(JSON.stringify({ template: file, findings, pass: !findings.length }, null, 2));
else {
  console.log(`\nstress — ${path.basename(file)}\n`);
  if (!findings.length) console.log('  holds at every content length.');
  for (const f of findings) console.log(`  FAIL  [${f.case}] slide ${String(f.slide).padStart(2)}  ${f.kind.padEnd(15)} ${f.text}${f.areaPx ? ` (${f.areaPx}px²)` : ''}`);
  console.log(`\n  ${findings.length} failure(s) across ${CASES.length} content lengths\n`);
}
process.exit(findings.length ? 1 : 0);
