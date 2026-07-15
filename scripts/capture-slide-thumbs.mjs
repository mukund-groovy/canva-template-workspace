#!/usr/bin/env node
/**
 * Screenshot each rendered slide of a Canva design's editor into
 * designs/<id>/extract/assets/pages/page-NN-{thumbnail,preview}.png.
 *
 * These are the "original slide references" build-comparison.mjs needs to produce the
 * dashboard preview. Our CDP clone captures the doc JSON but not rendered page images, so
 * this fills that gap. Requires the debuggable, logged-in Chrome on port 9222.
 *
 *   node scripts/capture-slide-thumbs.mjs --design-id <ID> [--port 9222]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const WS = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return a;
  }, [])
);
const ID = args['design-id'];
const PORT = Number(args.port || 9222);
if (!ID) throw new Error('--design-id required');

const pad = (n) => String(n).padStart(2, '0');

async function main() {
  const pageCount = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(WS, 'designs', ID, 'extract', 'template-data.json'), 'utf8'));
      return j.pageCount || (j.pages || []).length || 0;
    } catch {
      return 0;
    }
  })();
  const outDir = path.join(WS, 'designs', ID, 'extract', 'assets', 'pages');
  fs.mkdirSync(outDir, { recursive: true });

  const b = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.canva.com/design/${ID}/edit`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(9000);
    if (/\/login/.test(page.url())) throw new Error('not logged in (editor redirected to /login)');

    // The main editor renders each page as a div with document aspect (1080/1350 = 0.8).
    // Side-panel thumbnails share the aspect but are narrower — filter by width. Key each page
    // by its ABSOLUTE position in the scroll container (scroll-invariant), so scrolling never
    // re-keys the same page. Screenshot every rendered page each pass (Playwright auto-scrolls
    // it into view); scroll to reveal virtualized pages until all pageCount are shot.
    const shots = new Map(); // absKey -> ordinal top (for ordering)
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(500);
    const maxPass = (pageCount || 10) + 12;
    for (let pass = 0; pass < maxPass && (!pageCount || shots.size < pageCount); pass++) {
      const tags = await page.evaluate(() => {
        const isMain = (e) => {
          const r = e.getBoundingClientRect();
          // Exact 1080x1350 slide aspect (0.800); the 0.02 tolerance rejects the editor page
          // wrapper (~0.764 — includes the "Add page title" header + toolbar), plus a text guard.
          return r.width > 420 && r.height > 420 && Math.abs(r.width / r.height - 0.8) < 0.02 &&
            !/Add page title|^Page \d/.test(e.textContent || '');
        };
        // Nearest scrollable ancestor gives a stable frame of reference.
        const scroller =
          [...document.querySelectorAll('div')].find((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 400) ||
          document.scrollingElement;
        const sTop = scroller.getBoundingClientRect ? scroller.getBoundingClientRect().top : 0;
        const out = [];
        for (const e of document.querySelectorAll('div,section')) {
          if (!isMain(e)) continue;
          const r = e.getBoundingClientRect();
          const abs = Math.round(r.top - sTop + (scroller.scrollTop || 0));
          const key = `p${abs}`;
          if (!e.dataset.pgKey) e.dataset.pgKey = key;
          out.push({ key: e.dataset.pgKey, abs });
        }
        return out;
      });
      for (const t of tags.sort((a, b) => a.abs - b.abs)) {
        if (shots.has(t.key)) continue;
        const loc = page.locator(`[data-pg-key="${t.key}"]`).first();
        if (!(await loc.count())) continue;
        const ordinal = shots.size + 1;
        const base = path.join(outDir, `page-${pad(ordinal)}`);
        let ok = true;
        await loc.screenshot({ path: `${base}-thumbnail.png`, timeout: 15000 }).catch(() => (ok = false));
        if (ok && fs.existsSync(`${base}-thumbnail.png`)) {
          fs.copyFileSync(`${base}-thumbnail.png`, `${base}-preview.png`);
          shots.set(t.key, t.abs);
        }
        if (pageCount && shots.size >= pageCount) break;
      }
      await page.mouse.wheel(0, 550);
      await page.waitForTimeout(1100);
    }
    console.log(JSON.stringify({ designId: ID, pageCount, shots: shots.size, outDir }));
  } finally {
    await page.close().catch(() => {});
    await b.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
