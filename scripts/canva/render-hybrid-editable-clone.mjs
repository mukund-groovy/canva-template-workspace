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

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safePx(v, fallback = 0) {
  const n = Number(v);
  return `${Number.isFinite(n) ? n.toFixed(2) : Number(fallback).toFixed(2)}px`;
}

function parsePx(v, fallback = 0) {
  const n = Number(String(v ?? '').replace('px', '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function relPosix(fromFile, toFile) {
  return `./${path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/')}`;
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
  return map[style] || 400;
}

function cssWeight(value, fallback = '400') {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (/^\d+$/.test(raw)) return raw;
  const map = {
    thin: '100',
    extralight: '200',
    'extra-light': '200',
    light: '300',
    regular: '400',
    normal: '400',
    medium: '500',
    semibold: '600',
    'semi-bold': '600',
    bold: '700',
    ultrabold: '800',
    'ultra-bold': '800',
    heavy: '900',
    black: '900',
  };
  return map[raw] || fallback;
}

function normalizeTextForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function templateColor(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  return s;
}

function buildFontSupport(templateData) {
  const fontMap = new Map();
  const faces = [];
  const dedupe = new Set();

  for (const entry of arr(templateData?.fonts)) {
    const id = String(entry?.A || '');
    const family = String(entry?.C || id);
    if (!id || !family) continue;
    fontMap.set(id, family);

    for (const styleEntry of arr(entry?.D)) {
      const files = arr(styleEntry?.files);
      const file =
        files.find((f) => f.format === 'WOFF2') ||
        files.find((f) => f.format === 'WOFF') ||
        files.find((f) => f.format === 'OTF' || f.format === 'TTF' || f.format === 'OTF_CFF');
      if (!file?.url) continue;

      const rawStyle = String(styleEntry.style || 'REGULAR');
      const italic = rawStyle.includes('ITALIC');
      const baseStyle = rawStyle.replace('_ITALICS', '').replace('_ITALIC', '');
      const weight = fontStyleToWeight(baseStyle);
      const format = String(file.format || 'woff2').toLowerCase().replace('otf_cff', 'opentype');
      const key = `${family}|${weight}|${italic}|${file.url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      faces.push(
        `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(
          file.url
        )}) format('${format}');font-style:${italic ? 'italic' : 'normal'};font-weight:${weight};font-display:swap;}`
      );
    }
  }

  return { fontMap, faces };
}

function normalizeFontFamily(raw, fontMap) {
  const src = String(raw || '').trim();
  if (!src) return `'sans-serif'`;
  const token = src
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split('_')[0];
  const base = token.split('_')[0];
  const mapped = fontMap.get(base) || fontMap.get(token);
  if (mapped) return `'${mapped.replace(/'/g, "\\'")}',sans-serif`;
  return `'${token.replace(/'/g, "\\'")}',sans-serif`;
}

function chooseImageFiles(imagesDir) {
  const all = fs
    .readdirSync(imagesDir)
    .filter(isImage)
    .sort(
      (a, b) =>
        pageSortKey(a) - pageSortKey(b) ||
        qualityRank(a) - qualityRank(b) ||
        a.localeCompare(b, 'en')
    );

  const byPage = new Map();
  for (const file of all) {
    const page = pageSortKey(file);
    if (!Number.isFinite(page) || page === Number.MAX_SAFE_INTEGER) continue;
    if (!byPage.has(page)) byPage.set(page, file);
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, file]) => ({ page, file }));
}

function cleanTextLayers(textLayers) {
  return arr(textLayers)
    .map((t) => ({
      ...t,
      text: String(t.text || '').trim(),
      x: Number(t.x || 0),
      y: Number(t.y || 0),
      w: Number(t.w || 0),
      h: Number(t.h || 0),
      fontSizePx: parsePx(t.fontSize, 0),
      lineHeightPx: parsePx(t.lineHeight, 0),
    }))
    .filter((t) => t.text && t.w > 1 && t.h > 1)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function familyToken(fontFamily) {
  const src = String(fontFamily || '')
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');
  return src.split('_')[0] || src || 'default';
}

function buildFamilyScaleMap(slides) {
  const byFamily = new Map();
  for (const slide of arr(slides)) {
    for (const t of cleanTextLayers(slide?.text)) {
      if (!t.fontSizePx || t.fontSizePx <= 0 || t.h <= 0) continue;
      const ratio = t.h / t.fontSizePx;
      if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 5) continue;
      const key = familyToken(t.fontFamily);
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(ratio);
    }
  }

  const out = new Map();
  for (const [key, values] of byFamily.entries()) {
    const sorted = values.slice().sort((a, b) => a - b);
    const sampleCount = Math.max(1, Math.floor(sorted.length * 0.25));
    const sample = sorted.slice(0, sampleCount);
    const minRatio = sample[0] || 0.45;
    out.set(key, Math.max(0.28, Math.min(minRatio, 1.2)));
  }
  return out;
}

function textMetrics(layer, familyScaleMap) {
  const rawFs = layer.fontSizePx || 0;
  const rawLh = layer.lineHeightPx || 0;
  const familyScale = familyScaleMap.get(familyToken(layer.fontFamily)) || 0.45;
  const lineHeightRatio =
    rawFs > 0 && rawLh > 0
      ? Math.max(0.82, Math.min(rawLh / rawFs, 1.85))
      : 1.05;
  const ratio = rawFs > 0 ? layer.h / rawFs : 1;
  const estimatedLines = Math.max(1, Math.min(12, Math.round(ratio / familyScale) || 1));

  let fontSizePx = rawFs > 0 ? layer.h / estimatedLines / lineHeightRatio : layer.h * 0.9;
  fontSizePx = Math.max(6, Math.min(fontSizePx, layer.h * 0.98, rawFs || Number.MAX_SAFE_INTEGER));

  const lineHeightPx = Math.max(
    fontSizePx * 0.9,
    Math.min(fontSizePx * lineHeightRatio, fontSizePx * 1.8)
  );
  const multiline = estimatedLines > 1;

  return {
    fontSizePx,
    lineHeightPx,
    multiline,
  };
}

function extractTemplateTextModels(templateData, slides) {
  const pages = arr(templateData?.pages);
  const docW = Number(templateData?.docSize?.A || 1080);
  const docH = Number(templateData?.docSize?.B || 1350);

  return pages.map((page, idx) => {
    const slide = slides[idx] || {};
    const sx = Number(slide.width || 1) / docW;
    const sy = Number(slide.height || 1) / docH;

    return arr(page?.E)
      .filter((el) => el?.['A?'] === 'K')
      .map((el) => {
        const text = arr(el?.a?.A)
          .map((x) => x?.A || '')
          .join('')
          .replace(/\n+/g, ' ')
          .trim();

        const runs = arr(el?.a?.B).filter((r) => r?.['A?'] === 'A').map((r) => r?.A || {});
        const merged = {};
        for (const run of runs) {
          for (const [k, v] of Object.entries(run)) {
            if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'B')) {
              merged[k] = v.B;
            } else if (v != null && (typeof v === 'string' || typeof v === 'number')) {
              merged[k] = v;
            }
          }
        }

        return {
          text,
          norm: normalizeTextForMatch(text),
          x: Number(el?.A || 0) * sx,
          y: Number(el?.B || 0) * sy,
          w: Number(el?.D || 0) * sx,
          h: Number(el?.C || 0) * sy,
          color: merged.color,
          fontFamily: merged['font-family'],
          fontWeight: merged['font-weight'],
          fontStyle: merged['font-style'],
          textTransform: merged['text-transform'],
          letterSpacing: merged.tracking,
          fontSize: Number(merged['font-size'] || 0) * sy,
          lineHeightRatio:
            Number(merged.leading || 0) > 0 ? Number(merged.leading) / 1000 : null,
        };
      })
      .filter((x) => x.norm);
  });
}

function pickTemplateStyleForLayer(layer, models) {
  const norm = normalizeTextForMatch(layer.text);
  if (!norm || !arr(models).length) return null;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const cx = layer.x + layer.w / 2;
  const cy = layer.y + layer.h / 2;

  for (const m of models) {
    if (!m?.norm) continue;
    const textCompatible = m.norm.includes(norm) || norm.includes(m.norm);
    if (!textCompatible) continue;

    const mcx = m.x + m.w / 2;
    const mcy = m.y + m.h / 2;
    const dist = Math.hypot(cx - mcx, cy - mcy);
    const sizeDelta = Math.abs(layer.w - m.w) + Math.abs(layer.h - m.h);
    const score = dist + sizeDelta * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }

  return best;
}

function renderHtml(opts) {
  const {
    images,
    outputPath,
    domLayers,
    templateData,
    title,
    startInEditMode = false,
  } = opts;
  const slides = arr(domLayers?.slides);
  const { fontMap, faces } = buildFontSupport(templateData || {});
  const familyScaleMap = buildFamilyScaleMap(slides);
  const templateTextModelsBySlide = extractTemplateTextModels(templateData || {}, slides);
  const docW = Number(slides[0]?.width || 492.8);
  const docH = Number(slides[0]?.height || 616);

  const blocks = images
    .map((entry, idx) => {
      const slide = slides[idx] || {};
      const textLayers = cleanTextLayers(slide.text);
      const templateModels = templateTextModelsBySlide[idx] || [];
      const layerHtml = textLayers
        .map((t, textIdx) => {
          const styleRef = pickTemplateStyleForLayer(t, templateModels);
          const m = textMetrics(t, familyScaleMap);
          const style = [
            `left:${safePx(t.x)}`,
            `top:${safePx(t.y)}`,
            `width:${safePx(t.w)}`,
            `height:${safePx(t.h)}`,
            `color:${esc(templateColor(styleRef?.color, t.color || '#000'))}`,
            `font-family:${normalizeFontFamily(styleRef?.fontFamily || t.fontFamily, fontMap)}`,
            `font-size:${safePx(m.fontSizePx)}`,
            `line-height:${safePx(m.lineHeightPx)}`,
            `font-style:${esc(styleRef?.fontStyle || t.fontStyle || 'normal')}`,
            `font-weight:${esc(cssWeight(styleRef?.fontWeight, t.fontWeight || '400'))}`,
            `letter-spacing:${esc(t.letterSpacing || 'normal')}`,
            `text-transform:${esc(styleRef?.textTransform || t.textTransform || 'none')}`,
            m.multiline ? 'white-space:normal' : 'white-space:nowrap',
          ].join(';');

          return `<div class="txt" data-slide="${idx + 1}" data-layer="${textIdx + 1}" contenteditable="true" spellcheck="false" style="${style}">${esc(
            t.text
          )}</div>`;
        })
        .join('\n');

      return `<section class="slide-wrap" id="slide-${entry.page}">
  <div class="slide">
    <img class="base" src="${esc(relPosix(outputPath, entry.absPath))}" alt="Slide ${entry.page}">
    <div class="overlay">${layerHtml}</div>
  </div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>
${faces.join('\n')}
*{box-sizing:border-box}
body{margin:0;background:#0b0b0b;padding:14px;display:grid;justify-content:center;gap:14px;font-family:system-ui,sans-serif}
.toolbar{position:sticky;top:0;z-index:10;display:flex;gap:10px;justify-content:center}
.btn{appearance:none;border:1px solid #3a3a3a;background:#121212;color:#f5f5f5;font:600 13px/1 system-ui,sans-serif;padding:10px 14px;border-radius:9px;cursor:pointer}
.meta{color:#c4c4c4;font:12px/1.1 system-ui,sans-serif;display:grid;place-items:center}
.slide-wrap{width:min(${docW}px,calc(100vw - 20px))}
.slide{position:relative;width:100%;aspect-ratio:${docW}/${docH};overflow:hidden;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.base{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.overlay{position:absolute;inset:0;pointer-events:none}
.txt{position:absolute;opacity:0;pointer-events:none;outline:none;overflow-wrap:anywhere}
body.edit-mode .txt{opacity:1;pointer-events:auto;background:rgba(255,255,255,.92)}
body.edit-mode .txt:focus{outline:1px dashed rgba(0,0,0,.45)}
@media (max-width:860px){body{padding:10px}.slide-wrap{width:calc(100vw - 14px)}}
  </style>
</head>
<body class="${startInEditMode ? 'edit-mode' : ''}">
  <header class="toolbar">
    <button id="toggleEdit" class="btn" type="button">${startInEditMode ? 'Hide Edit Overlay' : 'Show Edit Overlay'}</button>
    <div class="meta">Exact clone view by default. Toggle edit mode to modify text.</div>
  </header>
  ${blocks}
<script>
(() => {
  const btn = document.getElementById('toggleEdit');
  const setLabel = () => {
    const active = document.body.classList.contains('edit-mode');
    btn.textContent = active ? 'Hide Edit Overlay' : 'Show Edit Overlay';
  };
  btn.addEventListener('click', () => {
    document.body.classList.toggle('edit-mode');
    setLabel();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key && e.key.toLowerCase() === 'e') {
      document.body.classList.toggle('edit-mode');
      setLabel();
    }
  });
  setLabel();
})();
</script>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.images || !args.dom || !args.output) {
    throw new Error(
      'Usage: node scripts/canva/render-hybrid-editable-clone.mjs --images <images-dir> --dom <dom-layers.json> --output <template-clone.html> [--template-data <template-data.json>] [--title <title>] [--edit-mode true]'
    );
  }

  const imagesDir = path.resolve(args.images);
  const domPath = path.resolve(args.dom);
  const outputPath = path.resolve(args.output);

  if (!fs.existsSync(imagesDir)) throw new Error(`Images dir not found: ${imagesDir}`);
  if (!fs.existsSync(domPath)) throw new Error(`DOM layers file not found: ${domPath}`);

  const imageRows = chooseImageFiles(imagesDir);
  if (!imageRows.length) throw new Error(`No page images found in ${imagesDir}`);

  const images = imageRows.map(({ page, file }) => ({
    page,
    file,
    absPath: path.join(imagesDir, file),
  }));
  const domLayers = JSON.parse(fs.readFileSync(domPath, 'utf8'));

  let templateData = {};
  if (args['template-data']) {
    const tPath = path.resolve(args['template-data']);
    if (fs.existsSync(tPath)) templateData = JSON.parse(fs.readFileSync(tPath, 'utf8'));
  }

  const title =
    args.title || templateData?.title || `Canva Template Clone (${path.basename(imagesDir)})`;
  const html = renderHtml({
    images,
    outputPath,
    domLayers,
    templateData,
    title,
    startInEditMode: String(args['edit-mode'] || '').toLowerCase() === 'true',
  });
  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(
    JSON.stringify(
      {
        output: outputPath,
        slides: images.length,
        domSlides: arr(domLayers?.slides).length,
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
