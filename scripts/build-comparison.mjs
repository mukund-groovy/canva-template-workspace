#!/usr/bin/env node
/**
 * Build a self-contained "Original vs Generated + Brand structure" comparison
 * HTML for one design, written to designs/<id>/comparison.html.
 *
 *   node canva-template-workspace/scripts/build-comparison.mjs --design-id <ID>
 *     [--archetype <slug>]        # carousel archetype in backend/database/carousels/<slug>.html
 *     [--workspace-root <path>]   # default ./canva-template-workspace
 *
 * "Generated" side prefers the mapped brand ARCHETYPE (recolorable, our own
 * template) and adds a brand-palette strip. If no archetype is mapped for the
 * design, it falls back to the pixel-clone's per-page screenshots.
 *
 * Requires: Chrome (CHROME_BIN or standard Windows paths) + ImageMagick (`magick`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function readJsonSafe(f, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome binary not found. Set CHROME_BIN.');
}

function screenshot(chromePath, htmlPath, outPath, width, height) {
  const res = run(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--run-all-compositor-stages-before-draw',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    `--screenshot=${outPath}`,
    pathToFileURL(htmlPath).toString(),
  ]);
  if (res.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`Chrome screenshot failed for ${htmlPath}\n${res.stderr || res.stdout}`);
  }
}

function magickCrop(src, outPath, w, h, x, y) {
  const res = run('magick', [src, '-crop', `${w}x${h}+${x}+${y}`, '+repage', outPath]);
  if (res.status !== 0) throw new Error(`magick crop failed\n${res.stderr || res.stdout}`);
}

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function firstExisting(paths) {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

// ── original reference slides ────────────────────────────────────────────────
function collectOriginals(extractDir, pageCount) {
  const pagesDir = path.join(extractDir, 'assets', 'pages');
  const out = [];
  for (let i = 1; i <= pageCount; i++) {
    const s = String(i).padStart(2, '0');
    const ref = firstExisting([
      path.join(pagesDir, `page-${s}-preview.png`),
      path.join(pagesDir, `page-${s}-thumbnail.png`),
    ]);
    out.push(ref);
  }
  return out;
}

// ── generated: archetype render (preferred) ──────────────────────────────────
const BRAND_SKINS = [
  { key: 'default', label: 'Default', vars: '' },
  { key: 'teal', label: 'Teal brand', vars: '--brand-primary:#0e7490;--brand-secondary:#155e75;--brand-accent:#06b6d4;--brand-on-accent:#04222a;' },
  { key: 'green', label: 'Green brand', vars: '--brand-primary:#1f7a3d;--brand-secondary:#14532d;--brand-accent:#22c55e;--brand-on-accent:#04220f;' },
  { key: 'indigo', label: 'Indigo brand', vars: '--brand-primary:#4338ca;--brand-secondary:#3730a3;--brand-accent:#6366f1;--brand-on-accent:#f5f3ff;' },
];

function columnize(archetypeHtml) {
  // Force the horizontal .ig-carousel into a vertical column so a tall screenshot
  // captures every slide, then slice. We APPEND an override rule rather than
  // string-replacing the existing declaration: templates write `.ig-carousel{`
  // (no space), `.ig-carousel {`, `.ig-carousel  {`, etc., and an exact-match
  // replace silently no-ops — leaving the carousel horizontal so only slide 1 is
  // captured and slides 2..N crop out blank. An appended `!important` rule wins by
  // cascade regardless of the original formatting.
  const override =
    '<style id="_cmp-columnize">' +
    '.ig-carousel{display:flex !important;flex-direction:column !important;' +
    'width:1080px !important;max-width:1080px !important;}' +
    '.ig-carousel > *{flex:0 0 auto !important;}' +
    '</style>';
  if (/<\/head>/i.test(archetypeHtml)) return archetypeHtml.replace(/<\/head>/i, `${override}</head>`);
  if (/<body[^>]*>/i.test(archetypeHtml)) return archetypeHtml.replace(/(<body[^>]*>)/i, `$1${override}`);
  return override + archetypeHtml;
}

async function renderArchetype(archetypeFile, workDir) {
  // Playwright chromium (a workspace dep) renders the column and clips each slide
  // region directly — no system Chrome + ImageMagick handoff, which broke on hosts
  // without `magick` on PATH. Same output: 1080x1350 per slide, one cover per skin.
  const { chromium } = await import('playwright');
  const html = fs.readFileSync(archetypeFile, 'utf8');
  // Count slides by the per-slide marker `data-cg-slide-type` (exactly one per
  // slide) — robust to <section>/<div> tag choice and to child elements that also
  // carry "slide" in their class (which over-counted a class-based match).
  const slideCount =
    (html.match(/data-cg-slide-type/gi) || []).length ||
    (html.match(/<section[^>]*\bclass="[^"]*\bslide\b/gi) || []).length ||
    5;
  const col = columnize(html);
  const colFile = path.join(workDir, 'arch-col.html');
  fs.writeFileSync(colFile, col);

  // Reuse the installed system Chrome (chromeBinary) so we don't require a separate
  // `npx playwright install` browser download on every host.
  const browser = await chromium.launch({ executablePath: chromeBinary() });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  try {
    // full column render → clip per slide
    await page.setViewportSize({ width: 1080, height: 1350 * slideCount });
    await page.goto(pathToFileURL(colFile).toString(), { waitUntil: 'networkidle' });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
    const slides = [];
    for (let i = 0; i < slideCount; i++) {
      const out = path.join(workDir, `arch-${i + 1}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: i * 1350, width: 1080, height: 1350 } });
      slides.push(out);
    }

    // brand variants: cover only, one per skin
    const brands = [];
    for (const skin of BRAND_SKINS) {
      const doc = skin.vars ? col.replace('</head>', `<style>:root{${skin.vars}}</style></head>`) : col;
      const f = path.join(workDir, `brand-${skin.key}.html`);
      fs.writeFileSync(f, doc);
      await page.setViewportSize({ width: 1080, height: 1350 });
      await page.goto(pathToFileURL(f).toString(), { waitUntil: 'networkidle' });
      await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
      const png = path.join(workDir, `cover-${skin.key}.png`);
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
      brands.push({ label: skin.label, png });
    }
    return { slideCount, slides, brands };
  } finally {
    await browser.close();
  }
}

// ── generated: clone fallback ────────────────────────────────────────────────
function collectCloneShots(designRoot, extractDir, pageCount) {
  const report = readJsonSafe(path.join(extractDir, 'template-clone-pure-html-autotune-report.json'));
  const latest = readJsonSafe(path.join(extractDir, 'template-clone-pure-html-latest-run.json'));
  const bestId = report?.best?.id;
  const runDir = latest?.runDir || report?.run?.runDir;
  if (!bestId || !runDir) return null;
  const shotsDir = path.join(runDir, 'artifacts', 'screenshots');
  const out = [];
  for (let i = 1; i <= pageCount; i++) {
    const s = String(i).padStart(2, '0');
    const f = path.join(shotsDir, `${bestId}.page-${s}.png`);
    out.push(fs.existsSync(f) ? f : null);
  }
  return out.some(Boolean) ? out : null;
}

// ── HTML assembly ────────────────────────────────────────────────────────────
function buildHtml({ designId, title, originals, replica, variant, brands, archetypeSlug, liveSrc }) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Columns present, in order: Original → Exact replica (clone) → Generated (archetype).
  const cols = [{ key: 'original', label: 'Original', sub: 'Canva design', imgs: originals }];
  if (replica && replica.some(Boolean)) {
    cols.push({ key: 'replica', label: 'Exact replica', sub: 'our HTML clone', imgs: replica });
  }
  if (variant && variant.length) {
    // LIVE, not a screenshot: point an iframe at the real output/<slug>.html and crop it to
    // this slide. You then compare the original against the ACTUAL template — always current,
    // selectable, inspectable — instead of a stale render baked in at build time.
    cols.push({
      key: 'variant',
      label: 'Generated',
      sub: liveSrc ? 'our live HTML' : 'brand archetype',
      imgs: variant,
      live: liveSrc || null,
    });
  }

  const n = Math.max(...cols.map((c) => c.imgs.length));
  let rows = '';
  for (let i = 0; i < n; i++) {
    const cells = cols
      .map((c) => {
        const f = c.imgs[i];
        let inner;
        if (c.live) {
          // One iframe on the real file, cropped to slide i. The deck is a horizontal strip of
          // 1080px slides, so the wrapper clips and JS shifts/scales it — no CSS injection, no
          // duplicated markup, and the file stays the single source of truth.
          inner =
            `<div class="liveWrap" data-i="${i}">` +
            `<iframe class="live" src="${esc(c.live)}" scrolling="no" loading="lazy" tabindex="-1"></iframe>` +
            `</div>`;
        } else {
          inner = f ? `<img src="${dataUri(f)}"/>` : '<div class="miss">—</div>';
        }
        return `<figure>${inner}<figcaption>${esc(c.label)}<span>${esc(c.sub)}</span></figcaption></figure>`;
      })
      .join('');
    rows += `<section class="row"><div class="rh"><span class="pno">Slide ${i + 1}</span></div>
    <div class="pair cols-${cols.length}">${cells}</div></section>`;
  }

  let brandSection = '';
  if (variant && variant.length && brands && brands.length) {
    const cards = brands
      .map((b) => `<figure class="bc"><img src="${dataUri(b.png)}"/><figcaption>${esc(b.label)}</figcaption></figure>`)
      .join('');
    brandSection = `<h2>2 · Brand structure — the variant under any brand palette</h2>
    <p class="sub">Only the accent roles re-skin; the fixed canvas + ink stay legible under every brand.</p>
    <div class="brands">${cards}</div>
    <div class="roles"><b>Brand roles:</b> <code>--brand-primary</code><code>--brand-secondary</code><code>--brand-accent</code><code>--brand-on-accent</code> — accents only. Canvas &amp; ink are fixed literals (never re-skinned).</div>`;
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(designId)} — Original vs Replica vs Variant</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#14110c;color:#f7f2ea;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1320px;margin:0 auto;padding:30px 20px 70px}
h1{font-size:25px;margin:0 0 4px}
h2{font-size:19px;margin:44px 0 6px;padding-top:22px;border-top:1px solid #302b21}
.sub{color:#b9b2a6;font-size:14px;margin:0 0 8px}
.legend{display:flex;gap:12px 22px;flex-wrap:wrap;margin:14px 0 8px;font-size:13px;color:#cfc7ba}
.legend b{color:#ff8210}
.row{margin:26px 0 0}.rh{margin:0 0 10px}.pno{font-weight:800;font-size:16px}
.pair{display:grid;gap:16px}
.pair.cols-1{grid-template-columns:1fr}
.pair.cols-2{grid-template-columns:1fr 1fr}
.pair.cols-3{grid-template-columns:1fr 1fr 1fr}
figure{margin:0}
figure img,.miss{width:100%;display:block;border-radius:10px;border:1px solid #3a3428;background:#fff;aspect-ratio:4/5;object-fit:contain}
/* live template view: clip the 1080x1350 slide out of the deck strip and scale it to the column */
.liveWrap{position:relative;width:100%;aspect-ratio:4/5;overflow:hidden;border-radius:10px;border:1px solid #3a3428;background:#fff}
.liveWrap iframe.live{position:absolute;top:0;left:0;border:0;width:100000px;height:1350px;transform-origin:top left;pointer-events:none}
.miss{display:flex;align-items:center;justify-content:center;background:#201c15;color:#7c7568;font-size:14px}
figcaption{margin-top:8px;font-size:12.5px;color:#e7dfd3;text-align:center;letter-spacing:.04em;text-transform:uppercase;font-weight:700}
figcaption span{display:block;font-weight:400;letter-spacing:.02em;text-transform:none;color:#9b9488;margin-top:2px}
.brands{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:14px}
.bc img{aspect-ratio:4/5;object-fit:contain}
.roles{margin:12px 0 0;padding:14px 16px;background:#201c15;border:1px solid #342f25;border-radius:10px;font-size:13.5px;color:#cfc7ba}
code{color:#ff8210;background:#2c261d;padding:2px 7px;border-radius:5px;margin-right:6px}
@media(max-width:820px){.pair.cols-3,.pair.cols-2{grid-template-columns:1fr}.brands{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<h1>${esc(designId)}${title ? ' — <span style="color:#ff8210">' + esc(title) + '</span>' : ''}</h1>
<div class="legend">
  <span><b>Original</b> = the Canva design</span>
  <span><b>Exact replica</b> = faithful clone in our HTML (reuses Canva assets)</span>
  <span><b>Variant</b> = brand archetype${archetypeSlug ? ' <code>' + esc(archetypeSlug) + '.html</code>' : ''} — our own template, brand-recolorable</span>
</div>
<h2>1 · Original &rarr; Exact replica &rarr; Variant</h2>
${rows}
${brandSection}
</div>
<script>
  // Scale each live iframe so slide i fills its column. transform-origin is top-left, so the
  // horizontal shift must be scaled too. Re-run on resize; the columns are fluid.
  function fitLive(){
    document.querySelectorAll('.liveWrap').forEach(function(w){
      var f = w.querySelector('iframe.live'); if(!f) return;
      var s = w.clientWidth / 1080;
      var i = Number(w.dataset.i || 0);
      f.style.transform = 'scale(' + s + ')';
      f.style.left = (-i * 1080 * s) + 'px';
    });
  }
  addEventListener('resize', fitLive);
  addEventListener('load', fitLive);
  fitLive();
</script>
</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const designId = args['design-id'];
  if (!designId) throw new Error('Missing --design-id');
  const workspaceRoot = args['workspace-root']
    ? path.resolve(args['workspace-root'])
    : path.resolve(path.dirname(process.argv[1] || '.'), '..'); // scripts/ -> workspace
  const repoRoot = path.resolve(workspaceRoot, '..');
  // Final templates live in the workspace's output/ folder (standalone); legacy
  // fallback to content-gen carousels if output/ is absent.
  const outputDir = fs.existsSync(path.join(workspaceRoot, 'output'))
    ? path.join(workspaceRoot, 'output')
    : path.resolve(repoRoot, 'backend', 'database', 'carousels');
  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const extractDir = path.join(designRoot, 'extract');
  const templateData = readJsonSafe(path.join(extractDir, 'template-data.json'));
  if (!templateData) throw new Error(`No extracted template-data.json for ${designId}. Clone first.`);
  const pageCount = Array.isArray(templateData.pages) ? templateData.pages.length : 5;

  // resolve archetype slug: explicit flag, else archetype-map.json
  const map = readJsonSafe(path.join(workspaceRoot, 'archetype-map.json'), {}) || {};
  const archetypeSlug = args.archetype && args.archetype !== 'true' ? args.archetype : map[designId] || null;
  const archetypeFile = archetypeSlug
    ? path.join(outputDir, `${archetypeSlug}.html`)
    : null;

  const workDir = path.join(designRoot, '.comparison-work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const originals = collectOriginals(extractDir, pageCount);

  // Exact replica = pixel-clone screenshots (present once the design has been generated).
  const replica = collectCloneShots(designRoot, extractDir, pageCount);

  // Variant = brand archetype render (present when a slug is mapped for the design).
  let variant = null;
  let brands = null;
  if (archetypeFile && fs.existsSync(archetypeFile)) {
    const r = await renderArchetype(archetypeFile, workDir);
    variant = r.slides;
    brands = r.brands;
  }

  const hasOriginals = originals && originals.some(Boolean);
  if (!replica && !variant && !hasOriginals) {
    throw new Error(
      `Nothing to compare for ${designId}: no original slide references, no clone screenshots, and no mapped archetype.`
    );
  }
  // An un-authored clone still shows its full slide filmstrip from the captured
  // page references, so the dashboard preview isn't stuck on the cover alone.
  const mode = variant && replica ? 'full' : variant ? 'archetype' : replica ? 'clone' : 'original';

  const outPath = path.join(designRoot, 'comparison.html');
  // Relative so the comparison keeps working if the workspace moves. Forward slashes: this is a
  // URL in an iframe src, not a filesystem path (Windows backslashes would break it).
  const liveSrc =
    archetypeFile && fs.existsSync(archetypeFile)
      ? path.relative(path.dirname(outPath), archetypeFile).split(path.sep).join('/')
      : null;
  const html = buildHtml({
    designId,
    title: templateData.title || '',
    originals,
    replica,
    variant,
    brands,
    liveSrc,
    archetypeSlug,
  });
  fs.writeFileSync(outPath, html);

  // Persist the default-palette archetype cover as the dashboard thumbnail.
  if (variant) {
    const coverSrc = path.join(workDir, 'cover-default.png');
    if (fs.existsSync(coverSrc)) {
      try {
        fs.copyFileSync(coverSrc, path.join(designRoot, 'archetype-cover.png'));
      } catch {
        // non-fatal: dashboard falls back to the original page-1 reference.
      }
    }
  }

  fs.rmSync(workDir, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        designId,
        output: outPath,
        mode,
        archetypeSlug: archetypeSlug || null,
        hasReplica: Boolean(replica && replica.some(Boolean)),
        hasVariant: Boolean(variant && variant.length),
        slides: (variant || replica || originals).length,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
