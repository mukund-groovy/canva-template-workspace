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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safePx(v) {
  const n = Number(v);
  return `${Number.isFinite(n) ? n.toFixed(2) : '0'}px`;
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

function buildFontSupport(templateData) {
  const fontMap = new Map();
  const faces = [];

  for (const entry of arr(templateData?.fonts)) {
    const id = String(entry?.A || '');
    const name = String(entry?.C || id);
    if (!id || !name) continue;
    fontMap.set(id, name);

    for (const st of arr(entry?.D)) {
      const files = arr(st?.files);
      const file =
        files.find((f) => f.format === 'WOFF2') ||
        files.find((f) => f.format === 'WOFF') ||
        files.find((f) => f.format === 'OTF' || f.format === 'TTF');
      if (!file?.url) continue;

      const styleName = String(st.style || 'REGULAR');
      const italic = styleName.includes('ITALIC');
      const baseStyle = styleName.replace('_ITALICS', '').replace('_ITALIC', '');
      const weight = fontStyleToWeight(baseStyle);
      const fmt = String(file.format || 'woff2').toLowerCase();
      faces.push(
        `@font-face{font-family:${JSON.stringify(name)};src:url(${JSON.stringify(
          file.url
        )}) format('${fmt}');font-weight:${weight};font-style:${italic ? 'italic' : 'normal'};font-display:swap;}`
      );
    }
  }

  return { fontMap, faces };
}

function normalizeFontFamily(raw, fontMap) {
  const src = String(raw || '').trim();
  if (!src) return `'sans-serif'`;

  const first = src
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split('_')[0];
  const base = first.split('_')[0];
  const mapped = fontMap.get(base) || fontMap.get(first);
  if (mapped) return `'${mapped.replace(/'/g, "\\'")}',sans-serif`;

  if (first.startsWith('YAF') || first.startsWith('YAC')) return `'Poppins',sans-serif`;
  return `'${first.replace(/'/g, "\\'")}',sans-serif`;
}

function rectContains(a, b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

function cleanTextLayers(textLayers) {
  const layers = arr(textLayers)
    .map((t) => ({
      ...t,
      text: String(t.text || '').replace(/\s+/g, ' ').trim(),
      x: Number(t.x || 0),
      y: Number(t.y || 0),
      w: Number(t.w || 0),
      h: Number(t.h || 0),
      fontSizePx: Number(String(t.fontSize || '0').replace('px', '')) || 0,
      lineHeightPx: Number(String(t.lineHeight || '0').replace('px', '')) || 0,
    }))
    .filter((t) => t.text && t.w > 2 && t.h > 2)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h);

  const out = [];
  for (const t of layers) {
    // Drop wrappers if a more precise child text box already exists.
    const duplicate = out.find(
      (x) =>
        x.text === t.text &&
        Math.abs(x.x - t.x) < 2 &&
        Math.abs(x.y - t.y) < 2 &&
        Math.abs(x.w - t.w) < 2 &&
        Math.abs(x.h - t.h) < 2
    );
    if (duplicate) continue;

    const wrapsSmallerSameText = out.find(
      (x) => x.text === t.text && rectContains(t, x) && t.w * t.h > x.w * x.h * 1.2
    );
    if (wrapsSmallerSameText) continue;

    // If this one is more precise, replace wrapper.
    const wrapped = out.findIndex(
      (x) => x.text === t.text && rectContains(x, t) && x.w * x.h > t.w * t.h * 1.2
    );
    if (wrapped >= 0) out.splice(wrapped, 1);

    out.push(t);
  }

  return out.map((t) => {
    return {
      ...t,
      effectiveFontSize: Math.max(8, Number((t.fontSizePx || 16).toFixed(2))),
    };
  });
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
          norm: normalizeTextForMatch(text),
          x: Number(el?.B || 0) * sx,
          y: Number(el?.A || 0) * sy,
          w: Number(el?.D || 0) * sx,
          h: Number(el?.C || 0) * sy,
          color: merged.color,
          fontFamily: merged['font-family'],
          fontWeight: merged['font-weight'],
          fontStyle: merged['font-style'],
          textTransform: merged['text-transform'],
          fontSize: Number(merged['font-size'] || 0) * sy,
          lineHeightPx:
            Number(merged.leading || 0) > 0 && Number(merged['font-size'] || 0) > 0
              ? (Number(merged.leading) / 1000) * Number(merged['font-size']) * sy
              : 0,
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
    if (!(m.norm.includes(norm) || norm.includes(m.norm))) continue;
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

function renderHtml(domLayers, fontSupport, title, templateTextModelsBySlide) {
  const slides = arr(domLayers?.slides);
  const faces = arr(fontSupport?.faces);
  const fontMap = fontSupport?.fontMap || new Map();
  const familyScaleMap = buildFamilyScaleMap(slides);
  const baseW = Number(slides[0]?.width || 538);
  const baseH = Number(slides[0]?.height || 672);

  const slideBlocks = slides
    .map((slide, i) => {
      const shapes = arr(slide.shapes)
        .map(
          (s) =>
            `<div class="shape" style="left:${safePx(s.x)};top:${safePx(s.y)};width:${safePx(
              s.w
            )};height:${safePx(s.h)};background:${escapeHtml(s.bg || '#000')};border-radius:${escapeHtml(
              s.borderRadius || '0px'
            )};"></div>`
        )
        .join('\n');

      const images = arr(slide.images)
        .map(
          (im) =>
            `<img class="asset" src=${JSON.stringify(im.src)} style="left:${safePx(im.x)};top:${safePx(
              im.y
            )};width:${safePx(im.w)};height:${safePx(im.h)};" alt="">`
        )
        .join('\n');

      const templateModels = arr(templateTextModelsBySlide?.[i]);
      const text = cleanTextLayers(slide.text)
        .map((t, ti) => {
          const metrics = textMetrics(t, familyScaleMap);
          const styleRef = pickTemplateStyleForLayer(t, templateModels);
          const lineHeightPx =
            Number(styleRef?.lineHeightPx || 0) > 0
              ? Number(styleRef.lineHeightPx)
              : t.lineHeightPx > 0
                ? Math.min(Math.max(t.lineHeightPx, metrics.fontSizePx * 0.9), t.h * 1.5)
                : metrics.lineHeightPx;
          const multiline = metrics.multiline;
          const css = [
            `left:${safePx(t.x)}`,
            `top:${safePx(t.y)}`,
            `width:${safePx(t.w)}`,
            multiline ? `height:${safePx(t.h)}` : '',
            `color:${escapeHtml(styleRef?.color || t.color || '#000')}`,
            `font-family:${normalizeFontFamily(styleRef?.fontFamily || t.fontFamily, fontMap)}`,
            `font-size:${safePx(metrics.fontSizePx)}`,
            `font-weight:${escapeHtml(cssWeight(styleRef?.fontWeight, t.fontWeight || '400'))}`,
            `font-style:${escapeHtml(styleRef?.fontStyle || t.fontStyle || 'normal')}`,
            `line-height:${safePx(lineHeightPx)}`,
            `letter-spacing:${escapeHtml(t.letterSpacing || 'normal')}`,
            `text-transform:${escapeHtml(styleRef?.textTransform || t.textTransform || 'none')}`,
          ].join(';');
          return `<div class="txt${multiline ? ' paragraph' : ''}" data-layer="${ti + 1}" contenteditable="true" spellcheck="false" style="${css}">${escapeHtml(
            t.text
          )}</div>`;
        })
        .join('\n');

      return `<section class="slide-wrap" id="slide-${i + 1}">
  <div class="slide" style="background:${escapeHtml(slide.background || '#fff')}">
    ${shapes}
    ${images}
    ${text}
  </div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${faces.join('\n')}
*{box-sizing:border-box}
body{margin:0;background:#0f0f0f;padding:16px;display:grid;gap:22px;justify-content:center;font-family:system-ui,sans-serif}
.slide-wrap{width:min(${baseW}px,calc(100vw - 24px))}
.slide{position:relative;width:100%;aspect-ratio:${baseW}/${baseH};overflow:hidden;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.shape,.asset,.txt{position:absolute}
.asset{object-fit:contain;pointer-events:none}
.txt{white-space:nowrap;outline:none;cursor:text}
.txt.paragraph{white-space:normal}
.txt:focus{outline:1px dashed rgba(0,0,0,.35);background:rgba(255,255,255,.25)}
  </style>
</head>
<body>
${slideBlocks}
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error(
      'Usage: node scripts/canva/render-dom-layers-html.mjs --input <dom-layers.json> --output <template-clone.html> [--template-data <template-data.json>] [--title <title>]'
    );
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const domLayers = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  let templateData = null;
  if (args['template-data']) {
    const tdPath = path.resolve(args['template-data']);
    if (fs.existsSync(tdPath)) templateData = JSON.parse(fs.readFileSync(tdPath, 'utf8'));
  }

  const fontSupport = buildFontSupport(templateData || {});
  const templateTextModelsBySlide = extractTemplateTextModels(templateData || {}, arr(domLayers?.slides));
  const title = args.title || templateData?.title || 'Canva Editable Template Clone';
  const html = renderHtml(domLayers, fontSupport, title, templateTextModelsBySlide);
  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(
    JSON.stringify(
      {
        input: inputPath,
        output: outputPath,
        slides: arr(domLayers?.slides).length,
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
