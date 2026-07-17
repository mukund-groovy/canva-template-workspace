#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// Cross-process mutex, same pattern as agent-canva-clone.mjs's withLock — the shared dedupe
// index is a read-modify-write file, and several clone agents run this script concurrently
// (different chats cloning different designs at once). Without a lock, two processes reading
// the index before either writes silently lose one's entry (last writer wins) — the dedupe
// index then forgets a design existed, and a real future duplicate can slip past findDuplicates.
function withFileLock(lockPath, fn) {
  const STALE_MS = 20000;
  const WAIT_MS = 15000;
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > WAIT_MS) throw new Error(`timed out waiting for lock: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function hashSha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeNumber(v, precision = 3) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** precision;
  return Math.round(n * p) / p;
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableSerialize(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableSerialize(x)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(value[k])}`).join(',')}}`;
}

function normalizeRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      if (r['A?'] === 'B') return { t: 'B', n: Number(r.A || 0) };
      if (r['A?'] !== 'A' || !r.A || typeof r.A !== 'object') return null;
      const style = {};
      for (const [k, v] of Object.entries(r.A)) {
        if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'B')) {
          style[k] = v.B;
        } else if (v && typeof v === 'object' && Object.keys(v).length === 0) {
          style[k] = null;
        }
      }
      return { t: 'A', s: style };
    })
    .filter(Boolean);
}

function normalizeRecolorMap(map) {
  if (!map || typeof map !== 'object') return null;
  const entries = Object.entries(map)
    .map(([from, to]) => [String(from), String(to)])
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries : null;
}

function normalizeElementForSignature(el, mode = 'exact') {
  const type = el?.['A?'] || 'X';
  const base = {
    t: type,
    x: normalizeNumber(el?.A),
    y: normalizeNumber(el?.B),
    h: normalizeNumber(el?.C),
    w: normalizeNumber(el?.D),
  };

  if (type === 'K') {
    const rawText = (Array.isArray(el?.a?.A) ? el.a.A : []).map((x) => x?.A || '').join('');
    const text = normalizeText(rawText);
    const runs = normalizeRuns(el?.a?.B);
    base.role = el?.N || null;
    base.align = el?.h || null;
    base.textLen = text.length;
    base.runs = runs;
    if (mode === 'exact') base.text = text;
    return base;
  }

  if (type === 'I') {
    const mediaRef = el?.a?.B?.A?.A || null;
    const recolor = normalizeRecolorMap(el?.a?.B?.C);
    base.media = mode === 'exact' ? mediaRef : null;
    base.recolor = recolor;
    return base;
  }

  if (type === 'J') {
    const shape = (Array.isArray(el?.b) ? el.b : [])[0] || {};
    base.path = shape?.A || null;
    base.fill = shape?.B?.C || null;
    base.stroke = shape?.C?.B || null;
    base.strokeW = normalizeNumber(shape?.C?.A || 0);
    if (mode === 'exact') base.fillMedia = shape?.B?.B?.A?.A || null;
    return base;
  }

  if (type === 'U') {
    base.color = el?.d || null;
    base.visible = el?.f !== false;
    return base;
  }

  return base;
}

function buildPageSignature(page, mode = 'exact') {
  const bg = page?.D || {};
  return {
    bgColor: bg?.C || null,
    bgMedia: mode === 'exact' ? bg?.B?.A?.A || null : null,
    bgRect: {
      x: normalizeNumber(bg?.B?.B?.A),
      y: normalizeNumber(bg?.B?.B?.B),
      h: normalizeNumber(bg?.B?.B?.C),
      w: normalizeNumber(bg?.B?.B?.D),
    },
    elements: (Array.isArray(page?.E) ? page.E : []).map((el) => normalizeElementForSignature(el, mode)),
  };
}

function buildTemplateSignature(templateData) {
  const pages = Array.isArray(templateData?.pages) ? templateData.pages : [];
  const exactObject = {
    docSize: {
      h: normalizeNumber(templateData?.docSize?.B),
      w: normalizeNumber(templateData?.docSize?.A),
    },
    pageCount: Number(templateData?.pageCount || pages.length),
    pages: pages.map((p) => buildPageSignature(p, 'exact')),
  };
  const layoutObject = {
    docSize: exactObject.docSize,
    pageCount: exactObject.pageCount,
    pages: pages.map((p) => buildPageSignature(p, 'layout')),
  };
  const exactSerialized = stableSerialize(exactObject);
  const layoutSerialized = stableSerialize(layoutObject);
  return {
    algorithm: 'sha256',
    exactHash: hashSha256(exactSerialized),
    layoutHash: hashSha256(layoutSerialized),
    exactSerializedLength: exactSerialized.length,
    layoutSerializedLength: layoutSerialized.length,
  };
}

function updateDedupeIndex(indexPath, entry) {
  const lockPath = `${indexPath}.lock`;
  return withFileLock(lockPath, () => {
    // Re-read FRESH under the lock — the caller's `currentIndex` (read earlier, before cloning
    // ran) may already be stale if another process updated the index in the meantime.
    const current = readJson(indexPath, { entries: [] }) || { entries: [] };
    const entries = Array.isArray(current.entries) ? current.entries : [];
    const withoutCurrentDesign = entries.filter((e) => String(e?.designId || '') !== String(entry.designId || ''));
    const nextEntry = {
      ...entry,
      updatedAt: new Date().toISOString(),
    };
    const merged = [nextEntry, ...withoutCurrentDesign].slice(0, 1000);
    const payload = {
      updatedAt: new Date().toISOString(),
      entries: merged,
    };
    ensureDir(path.dirname(indexPath));
    writeJson(indexPath, payload);
    return payload;
  });
}

function findDuplicates(index, signature, designId) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  return entries.filter((e) => {
    if (!e) return false;
    if (String(e.designId || '') === String(designId || '')) return false;
    return e.exactHash === signature.exactHash || e.layoutHash === signature.layoutHash;
  });
}

function findBootstrapStatement(html) {
  const marker = "window['bootstrap'] = JSON.parse('";
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error('Could not find window bootstrap marker in HTML dump.');
  }

  const from = start + marker.length;
  let closeQuote = -1;
  let escaped = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      closeQuote = i;
      break;
    }
  }
  if (closeQuote < 0) {
    throw new Error('Could not find end of bootstrap JSON.parse statement.');
  }

  let j = closeQuote + 1;
  while (j < html.length && /\s/.test(html[j])) j++;
  if (html[j] !== ')') {
    throw new Error('Bootstrap JSON.parse closing parenthesis not found.');
  }
  j++;
  while (j < html.length && /\s/.test(html[j])) j++;
  if (html[j] === ';') j++;

  return html.slice(start, j);
}

function extractBootstrap(html) {
  const statement = findBootstrapStatement(html);
  const sandbox = { window: {}, JSON };
  vm.runInNewContext(statement, sandbox);
  if (!sandbox.window.bootstrap) {
    throw new Error('Bootstrap object was not assigned while evaluating statement.');
  }
  return sandbox.window.bootstrap;
}

function collectDocumentImageUrls(bootstrap) {
  const found = [];

  function walk(value) {
    if (!value) return;
    if (typeof value === 'string') {
      if (value.includes('media.canva.com/v2/document-image/')) {
        found.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  }

  walk(bootstrap);

  const unique = [...new Set(found)];

  const byPage = new Map();
  for (const u of unique) {
    let page = 0;
    try {
      page = Number(new URL(u).searchParams.get('page') || 0);
    } catch {
      page = 0;
    }
    if (!page) continue;
    const row = byPage.get(page) || { page, preview: null, thumbnail: null };
    if (u.includes('/type:C/')) row.preview = u;
    if (u.includes('/type:B/')) row.thumbnail = u;
    byPage.set(page, row);
  }

  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extForContentType(ct) {
  const s = String(ct || '').toLowerCase();
  if (s.includes('png')) return 'png';
  if (s.includes('jpeg') || s.includes('jpg')) return 'jpg';
  if (s.includes('webp')) return 'webp';
  if (s.includes('gif')) return 'gif';
  if (s.includes('svg')) return 'svg';
  if (s.includes('woff2')) return 'woff2';
  if (s.includes('woff')) return 'woff';
  if (s.includes('otf')) return 'otf';
  if (s.includes('ttf')) return 'ttf';
  return 'bin';
}

function extForFontFormat(format) {
  const f = String(format || '').toUpperCase();
  if (f === 'WOFF2') return 'woff2';
  if (f === 'WOFF') return 'woff';
  if (f === 'OTF') return 'otf';
  if (f === 'TTF') return 'ttf';
  return 'woff2';
}

function detectExtFromBuffer(buffer, contentType = '') {
  const ctExt = extForContentType(contentType);
  if (ctExt !== 'bin') return ctExt;

  if (!buffer || buffer.length < 12) return null;
  const b = buffer;

  // PNG
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'jpg';
  }

  // WEBP: RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'webp';
  }

  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'gif';
  }

  const head = buffer.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.includes('<svg')) return 'svg';
  return null;
}

function normalizeDownloadedPath(outPath, detectedExt) {
  if (!detectedExt) return outPath;
  const currentExt = path.extname(outPath).replace('.', '').toLowerCase();
  if (!currentExt || currentExt === detectedExt.toLowerCase()) return outPath;
  const normalized = `${outPath.slice(0, -path.extname(outPath).length)}.${detectedExt}`;
  fs.renameSync(outPath, normalized);
  return normalized;
}

function fontStyleToWeight(style) {
  const map = {
    THIN: 100,
    EXTRA_LIGHT: 200,
    LIGHT: 300,
    REGULAR: 400,
    MEDIUM: 500,
    SEMI_BOLD: 600,
    BOLD: 700,
    ULTRA_BOLD: 800,
    HEAVY: 900,
  };
  return map[String(style || '').toUpperCase()] || 400;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function isFallbackPageAsset({ kind, url, contentType, detectedExt, bytes, path: filePath }) {
  const lowerContentType = String(contentType || '').toLowerCase();
  const lowerDetectedExt = String(detectedExt || '').toLowerCase();
  const lowerPathExt = path.extname(String(filePath || '')).replace('.', '').toLowerCase();
  const decodedUrl = decodeURIComponentSafe(url).toLowerCase();
  const isGif =
    lowerContentType.includes('gif') || lowerDetectedExt === 'gif' || lowerPathExt === 'gif';

  if (isGif) return true;
  if (decodedUrl.includes('default_preview.gif') || decodedUrl.includes('default_thumbnail.gif')) return true;

  // Some stale preview responses are tiny fallback assets.
  if (kind === 'page-preview' && Number(bytes || 0) > 0 && Number(bytes || 0) < 5000) return true;

  return false;
}

function collectEditorCapturePages(outDir) {
  const designRoot = path.resolve(outDir, '..');
  const candidateDirs = [
    path.join(outDir, 'assets', 'pages', 'editor-capture'),
    path.join(designRoot, 'capture', 'assets', 'pages', 'editor-capture'),
    path.join(designRoot, 'capture', 'editor-capture'),
  ];

  const byPage = new Map();
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^page-(\d+)(?:-(?:editor|actual|preview|thumbnail))?\.(png|jpg|jpeg|webp)$/i);
      if (!m) continue;
      const page = Number(m[1]);
      if (!Number.isFinite(page) || page <= 0) continue;
      const sourcePath = path.join(dir, entry.name);
      const stat = fs.statSync(sourcePath);
      const ext = path.extname(entry.name).replace('.', '').toLowerCase();
      const current = byPage.get(page);
      if (!current || stat.size > current.bytes) {
        byPage.set(page, {
          page,
          sourcePath,
          sourceDir: dir,
          fileName: entry.name,
          ext,
          bytes: stat.size,
        });
      }
    }
  }

  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

function upsertManifestEntry(manifest, nextEntry, matchFn) {
  const list = Array.isArray(manifest?.downloaded) ? manifest.downloaded : [];
  const idx = list.findIndex((e) => matchFn(e));
  if (idx >= 0) {
    list[idx] = nextEntry;
  } else {
    list.push(nextEntry);
  }
}

function promoteEditorCapturePages({ outDir, manifest, expectedPages }) {
  const pagesDir = path.join(outDir, 'assets', 'pages');
  const captures = collectEditorCapturePages(outDir);
  const promoted = [];

  for (const row of captures) {
    if (Number.isFinite(expectedPages) && expectedPages > 0 && row.page > expectedPages) continue;
    const page = String(row.page).padStart(2, '0');
    const ext = row.ext || 'png';
    const actualPath = path.join(pagesDir, `page-${page}-actual.${ext}`);
    if (path.resolve(row.sourcePath) !== path.resolve(actualPath)) {
      fs.copyFileSync(row.sourcePath, actualPath);
    }
    const actualBytes = fs.statSync(actualPath).size;
    const actualEntry = {
      kind: 'page-actual',
      page: row.page,
      url: null,
      source: 'editor-capture',
      sourcePath: row.sourcePath,
      path: actualPath,
      bytes: actualBytes,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      detectedExt: ext,
      isFallback: false,
      fallbackReason: null,
    };
    upsertManifestEntry(
      manifest,
      actualEntry,
      (e) => e?.kind === 'page-actual' && Number(e?.page) === row.page
    );

    const existingPreview = (manifest.downloaded || []).filter(
      (e) => e?.kind === 'page-preview' && Number(e?.page) === row.page
    );
    const hasValidPreview = existingPreview.some((e) => !e?.isFallback && fs.existsSync(String(e?.path || '')));
    if (!hasValidPreview) {
      const previewPath = path.join(pagesDir, `page-${page}-preview.${ext}`);
      if (path.resolve(previewPath) !== path.resolve(actualPath)) {
        fs.copyFileSync(actualPath, previewPath);
      }
      const previewBytes = fs.statSync(previewPath).size;
      const previewEntry = {
        kind: 'page-preview',
        page: row.page,
        url: null,
        source: 'promoted-actual',
        sourcePath: actualPath,
        path: previewPath,
        bytes: previewBytes,
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        detectedExt: ext,
        isFallback: false,
        fallbackReason: null,
      };
      upsertManifestEntry(
        manifest,
        previewEntry,
        (e) =>
          e?.kind === 'page-preview' &&
          Number(e?.page) === row.page &&
          String(e?.source || '') === 'promoted-actual'
      );
    }

    promoted.push({
      page: row.page,
      sourcePath: row.sourcePath,
      actualPath,
    });
  }

  return promoted;
}

async function downloadUrl(url, outPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  const data = Buffer.from(ab);
  fs.writeFileSync(outPath, data);
  const contentType = res.headers.get('content-type') || '';
  return {
    bytes: data.length,
    contentType,
    detectedExt: detectExtFromBuffer(data, contentType),
  };
}

async function downloadWithRetry(url, outPath, tries = 3) {
  let lastError = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadUrl(url, outPath);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function buildImageCloneHtml(slides) {
  const nav = slides.map((s) => `<a href="#slide-${s.page}">${s.page}</a>`).join('');
  const body = slides
    .map(
      (s) => `<section class="slide-wrap" id="slide-${s.page}">
  <div class="slide" aria-label="Slide ${s.page}">
    <img src="${s.src}" alt="Template slide ${s.page}" loading="lazy" decoding="async" />
  </div>
  <div class="caption">Slide ${s.page}</div>
</section>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Canva Template Clone</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0b0b;color:#f5f5f5;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;display:grid;grid-template-columns:88px 1fr;min-height:100vh}
.rail{position:sticky;top:0;height:100vh;padding:18px 10px;border-right:1px solid #1f1f1f;background:#101010;display:flex;flex-direction:column;gap:10px;align-items:center}
.rail a{width:34px;height:34px;border-radius:50%;border:1px solid #333;color:#ddd;text-decoration:none;display:grid;place-items:center;font-size:13px;background:#181818}
.main{padding:22px;display:grid;gap:30px;justify-content:center}
.slide-wrap{width:min(1080px,calc(100vw - 150px))}
.slide{width:100%;aspect-ratio:4/5;background:#111;border:1px solid #222;box-shadow:0 22px 50px rgba(0,0,0,.45);overflow:hidden}
.slide img{width:100%;height:100%;object-fit:cover;display:block}
.caption{margin-top:8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#a9a9a9}
@media (max-width:840px){body{grid-template-columns:1fr}.rail{position:sticky;z-index:5;top:0;height:auto;flex-direction:row;justify-content:center;border-right:none;border-bottom:1px solid #1f1f1f}.main{padding:14px}.slide-wrap{width:100%}}
</style>
</head>
<body>
  <nav class="rail" aria-label="Slide navigation">${nav}</nav>
  <main class="main">${body}</main>
</body>
</html>`;
}

function findFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const output = args.output;
  const designIdArg = args['design-id'];
  const dedupeMode = String(args['dedupe-mode'] || 'skip').toLowerCase();
  const dedupeIndexArg = args['dedupe-index'] || '';
  const cloneProfile = String(args['clone-profile'] || 'full').toLowerCase();
  const minimalProfile = cloneProfile === 'minimal' || cloneProfile === 'lean';

  if (!input) {
    throw new Error(
      'Missing --input.\nUsage: node scripts/canva/clone-canva-template.mjs --input <editor-page.full.html> [--output <dir>] [--design-id <id>] [--dedupe-mode skip|continue|off] [--dedupe-index <file>] [--clone-profile full|minimal]'
    );
  }
  if (!['full', 'minimal', 'lean'].includes(cloneProfile)) {
    throw new Error(`Invalid --clone-profile '${cloneProfile}'. Use full or minimal.`);
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const outDir = output ? path.resolve(output) : path.dirname(inputPath);
  ensureDir(outDir);
  ensureDir(path.join(outDir, 'assets', 'pages'));
  if (!minimalProfile) {
    ensureDir(path.join(outDir, 'assets', 'media'));
    ensureDir(path.join(outDir, 'assets', 'fonts'));
  }

  const html = fs.readFileSync(inputPath, 'utf8');
  const bootstrap = extractBootstrap(html);

  const designId =
    designIdArg ||
    bootstrap?.page?.Pm?.E?.id ||
    (bootstrap?.base?.F?.i || []).find((x) => x?.A === 'designId')?.B ||
    'unknown-design';

  const extensionId = bootstrap?.page?.Pm?.E?.acl?.extension || null;
  const title = bootstrap?.page?.Pm?.E?.draft?.content?.D || null;
  const pages = bootstrap?.page?.Pm?.E?.draft?.content?.A || [];
  const media = Array.isArray(bootstrap?.page?.Pm?.N?.D) ? bootstrap.page.Pm.N.D : [];
  const fonts = Array.isArray(bootstrap?.page?.Pm?.N?.C) ? bootstrap.page.Pm.N.C : [];
  const pageCount = pages.length;

  const urlsByPage = collectDocumentImageUrls(bootstrap);

  if (!minimalProfile) {
    writeJson(path.join(outDir, 'bootstrap.json'), bootstrap);
    writeJson(path.join(outDir, 'document-image-urls.json'), urlsByPage);
  }

  const templateData = {
    designId,
    extensionId,
    title,
    docSize: bootstrap?.page?.Pm?.E?.draft?.content?.C || null,
    pageCount: pageCount || urlsByPage.length,
    pages,
    media,
    fonts,
  };
  writeJson(path.join(outDir, 'template-data.json'), templateData);

  const signature = buildTemplateSignature(templateData);
  const signaturePath = path.join(outDir, 'template-signature.json');
  writeJson(signaturePath, {
    ...signature,
    generatedAt: new Date().toISOString(),
    designId,
    pageCount: templateData.pageCount,
    title,
  });

  const dedupeIndexPath = dedupeIndexArg
    ? path.resolve(dedupeIndexArg)
    : path.resolve(outDir, '..', 'template-dedupe-index.json');
  const dedupeEnabled = dedupeMode !== 'off';
  const currentIndex = dedupeEnabled ? readJson(dedupeIndexPath, { entries: [] }) : { entries: [] };
  const duplicates = dedupeEnabled ? findDuplicates(currentIndex, signature, designId) : [];
  const duplicateOf = duplicates[0] || null;

  const dedupeEntry = {
    designId,
    title,
    outDir,
    inputPath,
    pageCount: templateData.pageCount,
    exactHash: signature.exactHash,
    layoutHash: signature.layoutHash,
    signatureAlgorithm: signature.algorithm,
  };
  if (dedupeEnabled) {
    updateDedupeIndex(dedupeIndexPath, dedupeEntry);
  }

  if (duplicateOf && dedupeMode === 'skip') {
    const duplicateMeta = {
      generatedAt: new Date().toISOString(),
      designId,
      duplicateOf,
      signature,
      dedupeMode,
      dedupeIndexPath,
      action: 'skipped-downloads',
    };
    const duplicateMetaPath = path.join(outDir, 'duplicate-template.json');
    writeJson(duplicateMetaPath, duplicateMeta);

    const summary = {
      designId,
      outDir,
      cloneProfile: minimalProfile ? 'minimal' : 'full',
      duplicate: true,
      duplicateOf: {
        designId: duplicateOf.designId,
        outDir: duplicateOf.outDir || null,
        exactHash: duplicateOf.exactHash,
        layoutHash: duplicateOf.layoutHash,
      },
      outputs: {
        templateData: path.join(outDir, 'template-data.json'),
        signature: signaturePath,
        duplicateMeta: duplicateMetaPath,
        dedupeIndex: dedupeIndexPath,
        pages: path.join(outDir, 'assets', 'pages'),
      },
      stats: {
        pagesDetected: templateData.pageCount,
        slidesInHtmlClone: 0,
        downloaded: 0,
        failed: 0,
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    designId,
    extensionId,
    inputPath,
    outDir,
    downloaded: [],
    failed: [],
  };
  const fontManifest = {
    generatedAt: new Date().toISOString(),
    designId,
    fonts: [],
  };

  for (const row of urlsByPage) {
    const page = String(row.page).padStart(2, '0');
    if (row.preview) {
      const out = path.join(outDir, 'assets', 'pages', `page-${page}-preview.png`);
      try {
        const meta = await downloadWithRetry(row.preview, out);
        const actualPath = normalizeDownloadedPath(out, meta.detectedExt);
        const isFallback = isFallbackPageAsset({
          kind: 'page-preview',
          url: row.preview,
          path: actualPath,
          bytes: meta.bytes,
          contentType: meta.contentType,
          detectedExt: meta.detectedExt,
        });
        manifest.downloaded.push({
          kind: 'page-preview',
          page: row.page,
          url: row.preview,
          source: 'document-image',
          path: actualPath,
          isFallback,
          fallbackReason: isFallback ? 'document-image-fallback' : null,
          ...meta,
        });
      } catch (err) {
        manifest.failed.push({ kind: 'page-preview', page: row.page, url: row.preview, error: String(err) });
      }
    }
    if (row.thumbnail) {
      const out = path.join(outDir, 'assets', 'pages', `page-${page}-thumbnail.png`);
      try {
        const meta = await downloadWithRetry(row.thumbnail, out);
        const actualPath = normalizeDownloadedPath(out, meta.detectedExt);
        const isFallback = isFallbackPageAsset({
          kind: 'page-thumbnail',
          url: row.thumbnail,
          path: actualPath,
          bytes: meta.bytes,
          contentType: meta.contentType,
          detectedExt: meta.detectedExt,
        });
        manifest.downloaded.push({
          kind: 'page-thumbnail',
          page: row.page,
          url: row.thumbnail,
          source: 'document-image',
          path: actualPath,
          isFallback,
          fallbackReason: isFallback ? 'document-image-fallback' : null,
          ...meta,
        });
      } catch (err) {
        manifest.failed.push({
          kind: 'page-thumbnail',
          page: row.page,
          url: row.thumbnail,
          error: String(err),
        });
      }
    }
  }

  const promotedActualPages = promoteEditorCapturePages({
    outDir,
    manifest,
    expectedPages: Number(templateData.pageCount || urlsByPage.length || 0),
  });

  if (!minimalProfile) {
    for (const entry of media) {
      const mediaId = entry?.id || 'unknown-media';
      const files = Array.isArray(entry?.files) ? entry.files : [];
      const mediaDir = path.join(outDir, 'assets', 'media', safeName(mediaId));
      ensureDir(mediaDir);
      for (const file of files) {
        const url = file?.url;
        if (!url) continue;
        const ext = extForContentType(file?.mimeType || '');
        const fallbackName = `${safeName(mediaId)}.${ext}`;
        const fileName = safeName(path.basename(new URL(url).pathname || fallbackName) || fallbackName);
        const outPath = path.join(mediaDir, fileName);
        try {
          const meta = await downloadWithRetry(url, outPath);
          const actualPath = normalizeDownloadedPath(outPath, meta.detectedExt);
          manifest.downloaded.push({
            kind: 'media-file',
            mediaId,
            mediaType: entry?.type || null,
            url,
            path: actualPath,
            ...meta,
          });
        } catch (err) {
          manifest.failed.push({ kind: 'media-file', mediaId, url, error: String(err) });
        }
      }
    }

    for (const font of fonts) {
      const fontId = String(font?.A || '').trim();
      if (!fontId) continue;
      const fontName = String(font?.C || fontId);
      const fontDir = path.join(outDir, 'assets', 'fonts', safeName(fontId));
      ensureDir(fontDir);
      const styles = Array.isArray(font?.D) ? font.D : [];

      for (const style of styles) {
        const styleName = String(style?.style || 'REGULAR');
        const files = Array.isArray(style?.files) ? style.files : [];
        const preferredFile =
          files.find((f) => f?.format === 'WOFF2') ||
          files.find((f) => f?.format === 'WOFF') ||
          files.find((f) => f?.format === 'OTF') ||
          files.find((f) => f?.format === 'TTF');
        const url = preferredFile?.url;
        if (!url) continue;

        const ext = extForFontFormat(preferredFile?.format);
        let fileName = `${safeName(styleName)}.${ext}`;
        try {
          const parsed = new URL(url);
          const base = safeName(path.basename(parsed.pathname || ''));
          if (base) fileName = base;
        } catch {
          // Fall back to a deterministic style-based filename.
        }
        if (!path.extname(fileName)) {
          fileName = `${fileName}.${ext}`;
        }

        const outPath = path.join(fontDir, fileName);
        try {
          const meta = await downloadWithRetry(url, outPath);
          const actualPath = normalizeDownloadedPath(outPath, meta.detectedExt || ext);
          const relativePath = path
            .join('assets', 'fonts', safeName(fontId), path.basename(actualPath))
            .replace(/\\/g, '/');
          const italic = styleName.includes('ITALIC');
          const weight = fontStyleToWeight(styleName.replace('_ITALICS', '').replace('_ITALIC', ''));

          fontManifest.fonts.push({
            fontId,
            fontName,
            style: styleName,
            weight,
            italic,
            format: String(preferredFile?.format || path.extname(actualPath).replace('.', '')).toUpperCase(),
            path: relativePath,
            url,
          });
          manifest.downloaded.push({
            kind: 'font-file',
            fontId,
            fontName,
            style: styleName,
            url,
            path: actualPath,
            ...meta,
          });
        } catch (err) {
          manifest.failed.push({
            kind: 'font-file',
            fontId,
            fontName,
            style: styleName,
            url,
            error: String(err),
          });
        }
      }
    }

    writeJson(path.join(outDir, 'assets', 'fonts', 'font-manifest.json'), fontManifest);
    writeJson(path.join(outDir, 'assets', 'download-manifest.json'), manifest);
  }

  let slides = [];
  if (!minimalProfile) {
    const renderPageCount = pages.length || urlsByPage.length;
    for (let p = 1; p <= renderPageCount; p++) {
      const s = String(p).padStart(2, '0');
      const actualPath = findFirstExisting([
        path.join(outDir, 'assets', 'pages', `page-${s}-actual.png`),
        path.join(outDir, 'assets', 'pages', `page-${s}-actual.webp`),
        path.join(outDir, 'assets', 'pages', `page-${s}-actual.jpg`),
        path.join(outDir, 'assets', 'pages', `page-${s}-actual.jpeg`),
      ]);
      const previewPath = findFirstExisting([
        path.join(outDir, 'assets', 'pages', `page-${s}-preview.png`),
        path.join(outDir, 'assets', 'pages', `page-${s}-preview.webp`),
        path.join(outDir, 'assets', 'pages', `page-${s}-preview.jpg`),
        path.join(outDir, 'assets', 'pages', `page-${s}-preview.jpeg`),
      ]);
      const thumbPath = findFirstExisting([
        path.join(outDir, 'assets', 'pages', `page-${s}-thumbnail.png`),
        path.join(outDir, 'assets', 'pages', `page-${s}-thumbnail.webp`),
        path.join(outDir, 'assets', 'pages', `page-${s}-thumbnail.jpg`),
        path.join(outDir, 'assets', 'pages', `page-${s}-thumbnail.jpeg`),
      ]);
      if (actualPath) {
        slides.push({ page: p, src: `./assets/pages/${path.basename(actualPath)}` });
      } else if (previewPath) {
        slides.push({ page: p, src: `./assets/pages/${path.basename(previewPath)}` });
      } else if (thumbPath) {
        slides.push({ page: p, src: `./assets/pages/${path.basename(thumbPath)}` });
      }
    }

    const htmlClone = buildImageCloneHtml(slides);
    fs.writeFileSync(path.join(outDir, 'template-clone.html'), htmlClone, 'utf8');
  }

  const summary = {
    designId,
    outDir,
    cloneProfile: minimalProfile ? 'minimal' : 'full',
    duplicate: Boolean(duplicateOf),
    duplicateOf: duplicateOf
      ? {
          designId: duplicateOf.designId,
          outDir: duplicateOf.outDir || null,
          exactHash: duplicateOf.exactHash,
          layoutHash: duplicateOf.layoutHash,
        }
      : null,
    outputs: {
      templateData: path.join(outDir, 'template-data.json'),
      signature: signaturePath,
      dedupeIndex: dedupeIndexPath,
      assets: path.join(outDir, 'assets'),
      pages: path.join(outDir, 'assets', 'pages'),
      ...(minimalProfile
        ? {}
        : {
            bootstrap: path.join(outDir, 'bootstrap.json'),
            urls: path.join(outDir, 'document-image-urls.json'),
            htmlClone: path.join(outDir, 'template-clone.html'),
            manifest: path.join(outDir, 'assets', 'download-manifest.json'),
            fontManifest: path.join(outDir, 'assets', 'fonts', 'font-manifest.json'),
          }),
    },
    stats: {
      pagesDetected: templateData.pageCount,
      slidesInHtmlClone: slides.length,
      promotedActualPages: promotedActualPages.length,
      fallbackPageAssets: manifest.downloaded.filter(
        (x) => (x?.kind === 'page-preview' || x?.kind === 'page-thumbnail') && x?.isFallback
      ).length,
      downloaded: manifest.downloaded.length,
      failed: manifest.failed.length,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
