#!/usr/bin/env node
/**
 * cdp-capture.mjs — attach to an already-running Chrome (--remote-debugging-port),
 * find the open Canva design editor tab, RELOAD it and save the raw server HTML
 * response (which still embeds the full `window['bootstrap']` design spec) to
 * .tmp/canva-template-json/<DESIGN_ID>/editor-page.full.html for the clone pipeline.
 *
 * NOTE: reading document.documentElement.outerHTML does NOT work — the browser
 * consumes/clears the huge inline bootstrap script after parse, so the design spec
 * is gone from the live DOM. The raw HTTP response body is the only place it lives.
 *
 *   node scripts/cdp-capture.mjs <DESIGN_ID> [--port 9222] [--wait 9000]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const designId = process.argv[2];
const portIdx = process.argv.indexOf('--port');
const waitIdx = process.argv.indexOf('--wait');
const port = portIdx > -1 ? process.argv[portIdx + 1] : '9222';
const waitMs = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 9000;
if (!designId) { console.error('usage: cdp-capture.mjs <DESIGN_ID> [--port 9222] [--wait 9000]'); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (p.url().includes(`/design/${designId}/`)) { page = p; break; }
  }
  if (page) break;
}
if (!page) { console.error(`No open tab for design ${designId}`); await browser.close(); process.exit(1); }

const outDir = path.resolve('.tmp', 'canva-template-json', designId);
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, 'editor-page.full.html');

let saved = false;
let bytes = 0;
page.on('response', async (r) => {
  const u = r.url();
  if (saved) return;
  if (u.includes(`/design/${designId}/`) && u.endsWith('/edit')) {
    try {
      const t = await r.text();
      if (t.includes("window['bootstrap'] = JSON.parse(")) {
        await fs.writeFile(outPath, t, 'utf8');
        saved = true;
        bytes = t.length;
      }
    } catch { /* ignore */ }
  }
});

await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(waitMs);
await browser.close();

if (!saved) {
  console.error('Did not capture edit HTML with bootstrap marker. Design may not have finished loading.');
  process.exit(1);
}
console.log(JSON.stringify({ designId, outPath, htmlBytes: bytes }, null, 2));
