#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

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

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relPosix(fromFile, toFile) {
  return path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
}

function isImage(file) {
  return /\.(png|jpg|jpeg|webp)$/i.test(file);
}

function pageSortKey(file) {
  const m = file.match(/page-(\d+)/i);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function qualityRank(file) {
  const lower = file.toLowerCase();
  if (lower.includes('-exact')) return 0;
  if (lower.includes('-preview')) return 1;
  if (lower.includes('-thumbnail')) return 2;
  return 3;
}

function buildHtml(title, images) {
  const items = images
    .map(
      (img, i) => `<section class="slide" id="slide-${i + 1}">
  <img src="${esc(img.src)}" alt="Slide ${i + 1}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">
</section>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#111;display:grid;justify-content:center;gap:20px;padding:18px}
    .slide{width:min(640px,calc(100vw - 24px));margin:0 auto}
    .slide img{display:block;width:100%;height:auto;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35)}
  </style>
</head>
<body>
${items}
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.images || !args.output) {
    throw new Error(
      'Usage: node scripts/canva/render-image-clone-html.mjs --images <images-dir> --output <html-file> [--title <title>]'
    );
  }

  const imagesDir = path.resolve(args.images);
  const outFile = path.resolve(args.output);
  const title = args.title || 'Canva Template Clone (Exact Image Capture)';

  const imageFiles = fs
    .readdirSync(imagesDir)
    .filter(isImage)
    .sort(
      (a, b) =>
        pageSortKey(a) - pageSortKey(b) ||
        qualityRank(a) - qualityRank(b) ||
        a.localeCompare(b, 'en')
    );

  if (!imageFiles.length) {
    throw new Error(`No image files found in: ${imagesDir}`);
  }

  // Keep one image per page number; prefer exact, then preview, then thumbnail.
  const byPage = new Map();
  for (const f of imageFiles) {
    const key = pageSortKey(f);
    if (!Number.isFinite(key) || key === Number.MAX_SAFE_INTEGER) continue;
    if (!byPage.has(key)) byPage.set(key, f);
  }

  const files = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, f]) => f);

  const images = files.map((f) => {
    const abs = path.join(imagesDir, f);
    return { file: f, src: `./${relPosix(outFile, abs)}` };
  });

  fs.writeFileSync(outFile, buildHtml(title, images), 'utf8');

  console.log(
    JSON.stringify(
      {
        imagesDir,
        output: outFile,
        slides: images.length,
        files: files,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
