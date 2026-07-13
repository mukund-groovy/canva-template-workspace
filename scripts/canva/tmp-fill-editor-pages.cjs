const fs = require('fs');
const path = require('path');
const vm = require('vm');

const designId = process.argv[2] || process.env.CANVA_DESIGN_ID || '';
const workspaceRoot =
  process.argv[3] ||
  process.env.CANVA_WORKSPACE_ROOT ||
  'C:/Users/Groovy/Projects/content-gen/canva-template-workspace';

if (!designId) {
  console.error(
    'Usage: node canva-template-workspace/scripts/canva/tmp-fill-editor-pages.cjs <DESIGN_ID> [WORKSPACE_ROOT]'
  );
  process.exit(1);
}
const captureDir = path.join(workspaceRoot, 'designs', designId, 'capture');
const bootstrapPath = path.join(captureDir, 'bootstrap-script.full.js');
const outDir = path.join(captureDir, 'assets', 'pages', 'editor-capture');
fs.mkdirSync(outDir, { recursive: true });

function findBootstrapStatement(html) {
  const marker = "window['bootstrap'] = JSON.parse('";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('Could not find window bootstrap marker in HTML dump.');
  const from = start + marker.length;
  let closeQuote = -1;
  let escaped = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === "'") { closeQuote = i; break; }
  }
  if (closeQuote < 0) throw new Error('Could not find end of bootstrap JSON.parse statement.');
  let j = closeQuote + 1;
  while (j < html.length && /\s/.test(html[j])) j++;
  if (html[j] !== ')') throw new Error('Bootstrap JSON.parse closing parenthesis not found.');
  j++;
  while (j < html.length && /\s/.test(html[j])) j++;
  if (html[j] === ';') j++;
  return html.slice(start, j);
}

function extractBootstrap(html) {
  const statement = findBootstrapStatement(html);
  const sandbox = { window: {}, JSON };
  vm.runInNewContext(statement, sandbox);
  if (!sandbox.window.bootstrap) throw new Error('Bootstrap object was not assigned.');
  return sandbox.window.bootstrap;
}

function collectDocumentImageUrls(bootstrap) {
  const found = [];
  function walk(value) {
    if (!value) return;
    if (typeof value === 'string') {
      if (value.includes('media.canva.com/v2/document-image/')) found.push(value);
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
    try { page = Number(new URL(u).searchParams.get('page') || 0); } catch { page = 0; }
    if (!page) continue;
    const row = byPage.get(page) || { page, preview: null, thumbnail: null };
    if (u.includes('/type:C/')) row.preview = u;
    if (u.includes('/type:B/')) row.thumbnail = u;
    byPage.set(page, row);
  }
  return [...byPage.values()].sort((a,b)=>a.page-b.page);
}

function existingPage(page) {
  const p = String(page).padStart(2,'0');
  const cand = [
    path.join(outDir, `page-${p}-editor.png`),
    path.join(outDir, `page-${p}-editor.jpg`),
    path.join(outDir, `page-${p}-editor.webp`),
  ];
  return cand.find((x) => fs.existsSync(x));
}

function isGif(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
}

function extFromContentType(ct) {
  const c = String(ct || '').toLowerCase();
  if (c.includes('png')) return 'png';
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg';
  if (c.includes('webp')) return 'webp';
  return 'png';
}

function withPage(url, page) {
  try {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    return u.toString();
  } catch {
    return url;
  }
}

function thumbToPreview(url) {
  return String(url)
    .replace('/type:B/', '/type:C/')
    .replace('/height:250/', '/height:1000/')
    .replace('/width:200', '/width:800');
}

(async () => {
  if (!fs.existsSync(bootstrapPath)) throw new Error(`Missing bootstrap: ${bootstrapPath}`);
  const script = fs.readFileSync(bootstrapPath, 'utf8');
  const bootstrap = extractBootstrap(script);
  const rows = collectDocumentImageUrls(bootstrap);
  const page1 = rows.find(r => r.page === 1);

  const results = [];
  for (const row of rows) {
    const page = Number(row.page);
    if (!Number.isFinite(page) || page <= 0) continue;
    const already = existingPage(page);
    if (already) {
      results.push({ page, ok: true, source: 'existing', path: already });
      continue;
    }

    const candidateUrls = [];
    if (row.preview) candidateUrls.push({ source: 'row.preview', url: row.preview });
    if (row.thumbnail) {
      candidateUrls.push({ source: 'row.thumbnail->preview', url: thumbToPreview(row.thumbnail) });
      candidateUrls.push({ source: 'row.thumbnail', url: row.thumbnail });
    }
    if (page1?.preview) candidateUrls.push({ source: 'page1.preview(page=N)', url: withPage(page1.preview, page) });

    let saved = null;
    let errors = [];

    for (const c of candidateUrls) {
      try {
        const res = await fetch(c.url, { redirect: 'follow' });
        if (!res.ok) {
          errors.push(`${c.source}: http-${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = String(res.headers.get('content-type') || '').toLowerCase();
        if (isGif(buf) || ct.includes('gif') || buf.length < 5000) {
          errors.push(`${c.source}: fallback-or-small bytes=${buf.length} ct=${ct}`);
          continue;
        }
        const ext = extFromContentType(ct);
        const p = String(page).padStart(2, '0');
        const outPath = path.join(outDir, `page-${p}-editor.${ext}`);
        fs.writeFileSync(outPath, buf);
        saved = { page, ok: true, source: c.source, path: outPath, bytes: buf.length, contentType: ct };
        break;
      } catch (e) {
        errors.push(`${c.source}: ${String(e.message || e)}`);
      }
    }

    if (!saved) {
      saved = { page, ok: false, errors };
    }
    results.push(saved);
  }

  const summaryPath = path.join(captureDir, 'editor-page-fill-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ designId, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ summaryPath, results }, null, 2));
})();
