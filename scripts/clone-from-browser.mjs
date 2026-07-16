#!/usr/bin/env node
/**
 * One-command browser clone: capture a Canva editor over CDP → run the clone pipeline.
 *
 * Prereq: a debuggable Chrome logged into Canva on port 9222 (see README / clone agent).
 *
 * Modes (pick one):
 *   --search "<query>"   navigate the debug browser to Canva's template gallery for <query>
 *                        and LIST numbered tiles (with an EN/NON-EN flag) — pick good ones,
 *                        then clone them with --tiles. No template URL needed.
 *   --list               list tiles on the currently open /s/templates search tab
 *   --design-id <ID>     attach to an already-open /design/<ID>/edit tab
 *   --url <editorUrl>    open that editor URL in the debug browser, then capture
 *   --tile <N>           on an open /s/templates search tab, click the Nth "Preview," tile,
 *                        press "Customize this template", capture the editor it opens
 *   --tiles <A,B,C>      batch: several tile indices in one run
 *   --limit <n>          discovery: how many tiles to list (default 24)
 *
 * Options:
 *   --port <n>           CDP port (default 9222)
 *   --force              clone even if designs/<id>/ already exists
 *   --action <a>         agent-canva-clone action (default run)
 *   --no-clone           capture only, skip the pipeline
 *
 * Capture reads the inline window['bootstrap'] JSON, which carries the FULL document
 * (all pages) independent of scroll — so no per-slide scrolling is needed for extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const WS = path.resolve(path.dirname(process.argv[1] || '.'), '..');

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

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || 9222);
const CDP = `http://localhost:${PORT}`;
const DO_CLONE = args['no-clone'] !== 'true';
const ACTION = String(args.action || 'run');
const FORCE = args.force === 'true';

const DID_RE = /\/design\/([A-Za-z0-9_-]+)\//;
const ENGLISH_ONLY = args['english-only'] === 'true' || args.english === 'true';
const MIN_PAGES = Number(args['min-pages'] || 2); // only keep multi-slide decks by default
const MAX_IMAGES = args['max-images'] != null ? Number(args['max-images']) : 6; // photo cap (RASTER count); keeps decks fast+clean to generate. Pass a big number to disable.
const log = (...m) => console.log(...m);

// Cheap language gate on a template title: reject accented/non-Latin letters and common
// non-English function words. English Canva titles are plain ASCII (e.g. "Pink Modern
// Photo Diary Instagram Post"); "Tarjeta plegable ... con ilustración" trips both checks.
const NON_EN_WORDS = /\b(de|la|el|los|las|un|una|con|para|del|y|tarjeta|plegable|doble|cara|fondo|du|le|les|des|et|pour|avec|und|mit|für|der|die|das|com|para|dia|und|için)\b/i;
function isEnglishTitle(title) {
  const t = String(title || '').replace(/^Preview,\s*/i, '').replace(/,\s*template\s*$/i, '');
  if (/[^\x00-\x7F]/.test(t)) return false; // any non-ASCII letter (á é í ó ú ñ ü …)
  if (NON_EN_WORDS.test(t)) return false;
  return true;
}

function alreadyCloned(id) {
  return fs.existsSync(path.join(WS, 'designs', id, 'extract', 'template-data.json'));
}

function pageCountOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WS, 'designs', id, 'extract', 'template-data.json'), 'utf8'));
    return j.pageCount || (j.pages || []).length || 0;
  } catch {
    return 0;
  }
}

// Count content photos (RASTER media) — a strong proxy for how photo-heavy a template is.
// High counts (scrapbook/collage) generate slowly (one image-gen per slot) and score badly
// (text-on-photo contrast fails); typographic decks (0-few) generate fast and clean.
function imageCountOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WS, 'designs', id, 'extract', 'template-data.json'), 'utf8'));
    return (j.media || []).filter((m) => m.type === 'RASTER').length;
  } catch {
    return 0;
  }
}

// Discard a clone we don't want to keep (e.g. single-slide): remove its design folder and its
// dashboard-store entry. The dedupe-index hash is left in place so the same template isn't
// re-cloned on a later run.
function rollback(id) {
  fs.rmSync(path.join(WS, 'designs', id), { recursive: true, force: true });
  const storePath = path.join(WS, 'dashboard-store.json');
  try {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (Array.isArray(store.entries)) {
      store.entries = store.entries.filter((e) => e.designId !== id);
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
    }
  } catch {}
}

async function findEditor(ctx, id) {
  for (const p of ctx.pages()) {
    const m = p.url().match(DID_RE);
    if (m && (!id || m[1] === id)) return { page: p, id: m[1] };
  }
  return null;
}

/** Click the Nth "Preview," tile on the search tab, then "Customize this template". */
async function newEditorSince(ctx, before) {
  // An editor tab that was NOT open before this tile click (by page-object identity).
  for (const p of ctx.pages()) {
    if (before.has(p)) continue;
    const m = p.url().match(DID_RE);
    if (m) return { page: p, id: m[1] };
  }
  return null;
}

async function dismissModals(page) {
  // Close any open preview lightbox / dialog so the grid is interactable again.
  for (let i = 0; i < 3; i++) {
    const open = await page.locator('[role="dialog"]').count().catch(() => 0);
    if (!open) break;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
}

// Open the editor for a gallery tile. A gallery tile links to a template landing page
// (/templates/<TID>-slug), which carries the "Customize this template" create link
// (/design?create&template=<TID>...) → a fresh editor at /design/<newId>/edit. `tile` is a
// discovered {index,title,pages,english,href} record.
async function openFromTile(ctx, tile) {
  const n = tile.index;
  log(`tile ${n}: ${tile.title.slice(0, 60)}${tile.pages ? ` (${tile.pages}p)` : ''}`);
  if (ENGLISH_ONLY && !tile.english) {
    const err = new Error(`non-English title, skipped: ${tile.title.slice(0, 50)}`);
    err.softSkip = true;
    throw err;
  }
  if (!tile.href) throw new Error(`tile ${n} has no template link`);
  const landing = new URL(tile.href, 'https://www.canva.com').href;
  const search = ctx.pages().find((p) => /canva\.com\/templates\//.test(p.url())) || (await ctx.newPage());
  await search.goto(landing, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await search.waitForTimeout(2000);
  const createUrl = await search.evaluate(() => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => {
      const h = x.getAttribute('href') || '';
      return /\/design\?create/.test(h) && /template=/.test(h);
    });
    return a ? new URL(a.getAttribute('href'), location.origin).href : null;
  });
  if (!createUrl) throw new Error(`tile ${n}: no "Customize this template" link on the landing page.`);
  const page = await ctx.newPage();
  await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Creating from a template redirects to /design/<newId>/edit — wait for that id.
  for (let i = 0; i < 20 && !DID_RE.test(page.url()); i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(2500);
  const id = (page.url().match(DID_RE) || [])[1];
  if (!id) throw new Error('Create-from-template did not land on /design/<id>/edit.');
  return { page, id, _closeAfter: true };
}

const hasBootstrap = (page) =>
  page.evaluate(() =>
    Array.from(document.scripts || []).some((s) => (s.textContent || '').includes("window['bootstrap'] = JSON.parse("))
  );

/**
 * Grab the editor DOM into designs/<id>/capture/.
 * Anti-suspicion: the editor we opened via a real click already carries the bootstrap doc,
 * so we capture in place. We reload AT MOST ONCE, and only if bootstrap is missing — never
 * reload a design we already have. One human-style navigation, zero redundant reloads.
 */
async function capture(page, id) {
  await page.bringToFront();
  let ok = await hasBootstrap(page);
  if (!ok) {
    // Fallback only: bootstrap not present yet (slow/partial load) → one reload.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    for (let i = 0; i < 25 && !ok; i++) {
      ok = await hasBootstrap(page);
      if (!ok) await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
  } else {
    await page.waitForTimeout(1200); // let late layers settle; no reload
  }
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const outDir = path.join(WS, 'designs', id, 'capture');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'editor-page.full.html');
  fs.writeFileSync(outPath, html, 'utf8');
  log(`captured ${id}: ${html.length} bytes, bootstrap=${ok}`);
  return outPath;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Screenshot each rendered slide from the STILL-OPEN editor into
 * designs/<id>/extract/assets/pages/, so build-comparison can make the dashboard preview.
 * Done in the same editor session we already opened — no second visit.
 */
async function screenshotSlides(page, id) {
  let pageCount = 0;
  // Derive the expected page aspect ratio from the design's own docSize instead of assuming
  // portrait 1080x1350 (0.8) — square posts (1080x1080, ratio 1.0) and other formats need
  // their own ratio, or the main-page detector below matches nothing.
  let targetRatio = 0.8;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WS, 'designs', id, 'extract', 'template-data.json'), 'utf8'));
    pageCount = j.pageCount || (j.pages || []).length || 0;
    if (j.docSize && j.docSize.A && j.docSize.B) targetRatio = j.docSize.A / j.docSize.B;
  } catch {}
  const outDir = path.join(WS, 'designs', id, 'extract', 'assets', 'pages');
  fs.mkdirSync(outDir, { recursive: true });
  const shots = new Map();
  await page.bringToFront();
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
  const maxPass = (pageCount || 10) + 12;
  for (let pass = 0; pass < maxPass && (!pageCount || shots.size < pageCount); pass++) {
    const tags = await page.evaluate((targetRatio) => {
      const isMain = (e) => {
        const r = e.getBoundingClientRect();
        // Slide aspect derived from the design's own docSize — the tighter 0.02 tolerance rejects
        // the editor's page wrapper (which includes the "Add page title" header bar + toolbar
        // icons); the text guard is a belt-and-suspenders exclusion of that chrome-bearing wrapper.
        return r.width > 420 && r.height > 420 && Math.abs(r.width / r.height - targetRatio) < 0.02 &&
          !/Add page title|^Page \d/.test(e.textContent || '');
      };
      const scroller =
        [...document.querySelectorAll('div')].find((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 400) ||
        document.scrollingElement;
      const sTop = scroller.getBoundingClientRect ? scroller.getBoundingClientRect().top : 0;
      const out = [];
      for (const e of document.querySelectorAll('div,section')) {
        if (!isMain(e)) continue;
        const r = e.getBoundingClientRect();
        const key = `p${Math.round(r.top - sTop + (scroller.scrollTop || 0))}`;
        if (!e.dataset.pgKey) e.dataset.pgKey = key;
        out.push({ key: e.dataset.pgKey, abs: Math.round(r.top - sTop + (scroller.scrollTop || 0)) });
      }
      return out;
    }, targetRatio);
    for (const t of tags.sort((a, b) => a.abs - b.abs)) {
      if (shots.has(t.key)) continue;
      const loc = page.locator(`[data-pg-key="${t.key}"]`).first();
      if (!(await loc.count())) continue;
      const base = path.join(outDir, `page-${pad2(shots.size + 1)}`);
      let ok = true;
      await loc.screenshot({ path: `${base}-thumbnail.png`, timeout: 15000 }).catch(() => (ok = false));
      if (ok && fs.existsSync(`${base}-thumbnail.png`)) {
        fs.copyFileSync(`${base}-thumbnail.png`, `${base}-preview.png`);
        shots.set(t.key, t.abs);
      }
      if (pageCount && shots.size >= pageCount) break;
    }
    await page.mouse.wheel(0, 550);
    await page.waitForTimeout(1000);
  }
  return shots.size;
}

function buildComparison(id) {
  spawnSync(process.execPath, [path.join(WS, 'scripts', 'build-comparison.mjs'), '--design-id', id], { cwd: WS, encoding: 'utf8' });
}

function clone(id, inputHtml) {
  const res = spawnSync(
    process.execPath,
    [path.join(WS, 'scripts', 'agent-canva-clone.mjs'), '--action', ACTION, '--design-id', id, '--input-html', inputHtml],
    { cwd: WS, encoding: 'utf8' }
  );
  const out = (res.stdout || '').trim();
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    log(`clone ${id}: status=${j.status}${j.duplicate ? ' (dup of ' + (j.duplicateOf?.designId || '?') + ')' : ''}`);
    return j;
  } catch {
    log(`clone ${id}: (unparsed)`, out.slice(-300), res.stderr?.slice(-300) || '');
    return { status: 'error', raw: out };
  }
}

async function processEditor(ctx, ed) {
  const id = ed.id;
  if (!id) throw new Error('editor has no design id in URL');
  if (!FORCE && alreadyCloned(id)) {
    log(`skip ${id}: already cloned (use --force to redo)`);
    return { designId: id, status: 'skipped' };
  }
  const inputHtml = await capture(ed.page, id);
  const result = DO_CLONE ? clone(id, inputHtml) : { designId: id, status: 'captured', inputHtml };
  // Post-extract gates (page/image counts are only known after extraction):
  if (DO_CLONE && result.status === 'cloned') {
    // Multi-slide gate.
    if (MIN_PAGES > 1) {
      const pc = pageCountOf(id);
      if (pc < MIN_PAGES) {
        rollback(id);
        log(`skip ${id}: ${pc} slide(s) < min ${MIN_PAGES} — discarded`);
        if (ed._closeAfter) await ed.page.close().catch(() => {});
        return { designId: id, status: 'skipped-single-slide', pages: pc };
      }
    }
    // Photo cap: skip photo-heavy decks so generation stays fast + clean.
    if (Number.isFinite(MAX_IMAGES)) {
      const imgs = imageCountOf(id);
      if (imgs > MAX_IMAGES) {
        rollback(id);
        log(`skip ${id}: ${imgs} photos > max ${MAX_IMAGES} — discarded (photo-heavy)`);
        if (ed._closeAfter) await ed.page.close().catch(() => {});
        return { designId: id, status: 'skipped-photo-heavy', images: imgs };
      }
    }
  }
  // Build the dashboard preview from the still-open editor when we produced a fresh clone.
  if (DO_CLONE && result.status === 'cloned' && args['no-preview'] !== 'true') {
    try {
      const shots = await screenshotSlides(ed.page, id);
      buildComparison(id);
      log(`preview ${id}: ${shots} slide shots + comparison`);
    } catch (e) {
      log(`preview ${id} failed: ${e.message}`);
    }
  }
  if (ed._closeAfter) await ed.page.close().catch(() => {});
  return result;
}

// Find (or open) the Canva template gallery tab for a query.
async function galleryTab(ctx, query) {
  let search = ctx.pages().find((p) => /canva\.com\/templates\//.test(p.url()));
  const want = `https://www.canva.com/templates/?query=${encodeURIComponent(query || 'instagram carousel')}`;
  if (!search) search = await ctx.newPage();
  const cur = search.url();
  const curQ = (cur.match(/[?&]query=([^&]*)/) || [])[1] || '';
  if (query && decodeURIComponent(curQ) !== query) {
    await search.goto(want, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } else if (!/canva\.com\/templates\//.test(cur)) {
    await search.goto(want, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await search.bringToFront();
  await dismissModals(search);
  await search.waitForTimeout(2500);
  return search;
}

// Discovery: browse Canva's template gallery for a query, scroll to load tiles, and return
// them numbered (title, page count, English flag, template landing href) so the caller can
// pick good ones and clone via --tiles. The gallery reliably loads and the aria-labels carry
// the page count ("... template, N pages"), so multi-slide decks are visible up front.
async function discoverTiles(ctx, { query, limit }) {
  const search = await galleryTab(ctx, query);
  const want = Math.max(Number(limit) || 24, 12);
  let raw = [];
  for (let pass = 0; pass < 10; pass++) {
    raw = await search.locator('[aria-label^="Preview"]').evaluateAll((els) =>
      els.map((e) => {
        const a = e.closest('a[href]') || e.querySelector('a[href]');
        return { label: e.getAttribute('aria-label') || '', href: a ? a.getAttribute('href') : null };
      })
    );
    if (raw.length >= want) break;
    await search.mouse.wheel(0, 4000);
    await search.waitForTimeout(1200);
  }
  return raw.slice(0, want).map((t, i) => {
    const pages = (t.label.match(/,\s*(\d+)\s+pages?\b/i) || [])[1];
    const title = t.label
      .replace(/^Preview\s+(free\s+)?/i, '')
      .replace(/\s+template,\s*\d+\s+pages?\s*$/i, '')
      .replace(/\s+template\s*$/i, '')
      .trim();
    return { index: i, title, pages: pages ? Number(pages) : null, english: isEnglishTitle(title), href: t.href };
  });
}

async function main() {
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0];
  // Clean slate: close dead error tabs and any leftover editor tabs from prior runs, and
  // dismiss stale preview dialogs — these are what wedge the grid. Exception: in
  // --design-id mode we're attaching to a specific already-open editor tab, so never
  // close a tab that matches the requested id (or we'd close the very tab we need).
  const keepId = args['design-id'] ? String(args['design-id']) : null;
  for (const p of ctx.pages()) {
    const u = p.url();
    const m = u.match(DID_RE);
    if (keepId && m && m[1] === keepId) continue;
    if (/^chrome-error:/.test(u) || DID_RE.test(u)) await p.close().catch(() => {});
  }
  const searchTab = ctx.pages().find((p) => /\/s\/templates|\/templates\//.test(p.url()));
  if (searchTab) await dismissModals(searchTab);
  const results = [];
  try {
    if (args['design-id']) {
      const ed = await findEditor(ctx, String(args['design-id']));
      if (!ed) throw new Error(`No open editor tab for /design/${args['design-id']}/`);
      results.push(await processEditor(ctx, ed));
    } else if (args.url) {
      const page = await ctx.newPage();
      await page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(4000);
      const id = (page.url().match(DID_RE) || [])[1];
      if (!id) throw new Error('URL did not resolve to /design/<id>/');
      results.push(await processEditor(ctx, { page, id }));
    } else if (args.tile || args.tiles) {
      const idxs = String(args.tiles || args.tile).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
      const query = args.search && args.search !== 'true' ? String(args.search) : '';
      const tiles = await discoverTiles(ctx, { query, limit: Math.max(Number(args.limit) || 24, Math.max(...idxs) + 1) });
      for (const n of idxs) {
        try {
          const t = tiles.find((x) => x.index === n);
          if (!t) throw new Error(`tile ${n} out of range (grid has ${tiles.length})`);
          const ed = await openFromTile(ctx, t);
          results.push(await processEditor(ctx, ed));
        } catch (e) {
          if (e.softSkip) {
            log(`tile ${n} ${e.message}`);
            results.push({ tile: n, status: 'skipped-non-english' });
          } else if (e.skip) {
            log(`tile ${n} skip: ${e.message}`);
            results.push({ tile: n, designId: e.knownId, status: 'skipped' });
          } else {
            log(`tile ${n} failed: ${e.message}`);
            results.push({ tile: n, status: 'error', error: e.message });
          }
        }
      }
    } else if (args.search || args.list) {
      const query = args.search && args.search !== 'true' ? String(args.search) : '';
      const tiles = await discoverTiles(ctx, { query, limit: args.limit });
      log(`\nGALLERY${query ? ` "${query}"` : ''} — ${tiles.length} tiles (pick indices → clone with --tiles):`);
      for (const t of tiles) {
        const pg = t.pages ? `${String(t.pages).padStart(2)}p` : ' ?p';
        log(`  ${String(t.index).padStart(2)}  ${t.english ? '  EN  ' : 'NON-EN'}  ${pg}  ${t.title.slice(0, 68)}`);
      }
      log(`\nNext: node scripts/clone-from-browser.mjs --tiles <a,b,c>${query ? ` --search "${query}"` : ''} --english-only`);
      results.push({ status: 'listed', count: tiles.length });
    } else {
      throw new Error('Pick a mode: --search "<query>" | --list | --design-id | --url | --tile <n> | --tiles a,b,c');
    }
  } finally {
    await b.close();
  }
  // Sync the dashboard so new clones + their previews show up.
  if (DO_CLONE && results.some((r) => r.status === 'cloned')) {
    spawnSync(process.execPath, [path.join(WS, 'scripts', 'agent-canva-clone.mjs'), '--action', 'refresh'], { cwd: WS, encoding: 'utf8' });
  }
  log('\nSUMMARY:', JSON.stringify(results.map((r) => ({ id: r.designId || r.tile, status: r.status })), null, 0));
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
