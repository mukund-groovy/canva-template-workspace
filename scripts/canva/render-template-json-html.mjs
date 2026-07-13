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

function px(v) {
  return `${Number(v || 0).toFixed(3)}px`;
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function cssSingleQuoted(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function normalizeHex(value) {
  if (!value || typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) {
    s = `#${s
      .slice(1)
      .split('')
      .map((ch) => ch + ch)
      .join('')}`;
  }
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function hexToRgba(hex, alpha = 1) {
  const h = normalizeHex(hex);
  if (!h) return null;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function replaceAllCaseInsensitive(text, search, replacement) {
  if (!search) return text;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

function fixMojibake(text) {
  return String(text || '')
    .replace(/\u00e2\u20ac\u2122/g, 'â€™')
    .replace(/\u00e2\u20ac\u02dc/g, 'Ëœ')
    .replace(/\u00e2\u20ac\u0153/g, 'â€œ')
    .replace(/\u00e2\u20ac\u009d/g, 'â€')
    .replace(/\u00e2\u20ac\u201c/g, 'â€“')
    .replace(/\u00e2\u20ac\u201d/g, 'â€”')
    .replace(/Ã¢â‚¬â„¢/g, 'â€™')
    .replace(/Ã¢â‚¬Ëœ/g, 'â€˜')
    .replace(/Ã¢â‚¬Å“/g, 'â€œ')
    .replace(/Ã¢â‚¬/g, 'â€')
    .replace(/Ã¢â‚¬â€œ/g, 'â€“')
    .replace(/Ã¢â‚¬â€/g, 'â€”');
}

function mergeStyle(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'B')) {
      out[k] = v.B;
    } else if (v && typeof v === 'object' && Object.keys(v).length === 0) {
      delete out[k];
    }
  }
  return out;
}

function toSegments(textRuns, text) {
  const runs = arr(textRuns);
  let cursor = 0;
  let style = {};
  const segs = [];

  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    if (r['A?'] === 'A') {
      style = mergeStyle(style, r.A || {});
      continue;
    }
    if (r['A?'] === 'B') {
      const n = Number(r.A || 0);
      if (n <= 0) continue;
      segs.push({ text: String(text || '').slice(cursor, cursor + n), style: { ...style } });
      cursor += n;
    }
  }

  if (cursor < String(text || '').length) {
    segs.push({ text: String(text || '').slice(cursor), style: { ...style } });
  }

  return segs.length ? segs : [{ text: String(text || ''), style: {} }];
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

function parseFontWeight(value) {
  if (value == null || value === '') return null;
  const raw = String(value).toLowerCase().trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const map = {
    thin: 100,
    extralight: 200,
    'extra-light': 200,
    light: 300,
    regular: 400,
    normal: 400,
    medium: 500,
    semibold: 600,
    'semi-bold': 600,
    bold: 700,
    ultrabold: 800,
    'ultra-bold': 800,
    heavy: 900,
    black: 900,
  };
  return map[raw] || null;
}

function parseFontScaleOverrides(raw) {
  const out = {};
  if (!raw) return out;
  const parts = String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [idRaw, valueRaw] = part.split('=').map((x) => String(x || '').trim());
    if (!idRaw || !valueRaw) continue;
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value <= 0) continue;
    out[idRaw] = value;
  }
  return out;
}

function cssForStyle(style, fontNameById, fontScaleById = {}) {
  const out = [];
  const ff = style['font-family'] ? String(style['font-family']) : '';
  const fontId = ff ? ff.split(',')[0] : '';
  const fontScale = fontScaleById[fontId] || fontScaleById['*'] || 1;

  if (style.color) out.push(`color:${style.color}`);

  if (style['font-size']) {
    out.push(`font-size:${(Number(style['font-size']) * fontScale).toFixed(3)}px`);
  }

  if (ff) {
    const id = fontId;
    const family = fontNameById[id] || id || 'sans-serif';
    out.push(`font-family:${cssSingleQuoted(family)},sans-serif`);
    if (id === 'YAFcfq7XuZE') out.push('font-stretch:condensed');
  }

  if (style['font-weight']) {
    const w = parseFontWeight(style['font-weight']);
    if (w) out.push(`font-weight:${w}`);
  }

  if (style['font-style']) out.push(`font-style:${String(style['font-style']).toLowerCase()}`);
  if (style['text-transform']) out.push(`text-transform:${String(style['text-transform']).toLowerCase()}`);
  if (style['text-align']) out.push(`text-align:${String(style['text-align']).toLowerCase()}`);

  if (style.leading) {
    const lh = Number(style.leading) / 1000;
    if (Number.isFinite(lh) && lh > 0) out.push(`line-height:${lh}`);
  }

  if (style.tracking) {
    const ls = Number(style.tracking) / 1000;
    if (Number.isFinite(ls) && ls !== 0) out.push(`letter-spacing:${ls}em`);
  }

  return out.join(';');
}

function findLocalMediaFile(assetsRoot, mediaId) {
  const dir = path.join(assetsRoot, 'media', safeName(mediaId));
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();

  const rank = [
    /^s3-1\.svg$/i,
    /^s2-1\.svg$/i,
    /^s-1\.svg$/i,
    /^s3\.(png|jpg|jpeg|webp)$/i,
    /^s2\.(png|jpg|jpeg|webp)$/i,
    /^s\.(png|jpg|jpeg|webp)$/i,
    /^ss_s3\.(png|jpg|jpeg|webp)$/i,
    /^ss_s2\.(png|jpg|jpeg|webp)$/i,
    /^ss_s\.(png|jpg|jpeg|webp)$/i,
    /^t\.(png|jpg|jpeg|webp)$/i,
  ];

  for (const re of rank) {
    const hit = files.find((f) => re.test(f));
    if (hit) return path.join('assets', 'media', safeName(mediaId), hit).replace(/\\/g, '/');
  }

  if (files.length) {
    return path.join('assets', 'media', safeName(mediaId), files[0]).replace(/\\/g, '/');
  }

  return null;
}

function chooseRemoteMediaUrl(mediaEntry) {
  const files = arr(mediaEntry?.files);
  if (!files.length) return null;

  const byQuality = [
    'SCREEN_3X',
    'SCREEN_2X',
    'SCREEN',
    'THUMBNAIL',
  ];

  for (const q of byQuality) {
    const preferredSvg = files.find((f) => f.quality === q && String(f.mimeType || '').includes('svg'));
    if (preferredSvg?.url) return preferredSvg.url;
    const preferredRaster = files.find((f) => f.quality === q);
    if (preferredRaster?.url) return preferredRaster.url;
  }

  return files[0]?.url || null;
}

function readFontManifest(assetsRoot) {
  const filePath = path.join(assetsRoot, 'fonts', 'font-manifest.json');
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = arr(parsed?.fonts);
    const map = new Map();
    for (const entry of entries) {
      const fontId = String(entry?.fontId || '').trim();
      const style = String(entry?.style || 'REGULAR').trim().toUpperCase();
      const relPath = String(entry?.path || '').trim();
      if (!fontId || !style || !relPath) continue;
      map.set(`${fontId}::${style}`, {
        path: relPath.replace(/\\/g, '/'),
        format: String(entry?.format || path.extname(relPath).replace('.', '') || 'woff2').toLowerCase(),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function fontFormatForCss(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'ttf' || f === 'truetype') return 'truetype';
  if (f === 'otf' || f === 'opentype') return 'opentype';
  if (f === 'woff2') return 'woff2';
  if (f === 'woff') return 'woff';
  return 'woff2';
}

function buildRecolorPairs(recolorMap) {
  return Object.entries(recolorMap || {})
    .map(([from, to]) => [normalizeHex(from), normalizeHex(to)])
    .filter(([from, to]) => from && to);
}

function normalizeSvgMarkup(svgRaw, recolorPairs) {
  let svg = String(svgRaw || '')
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .trim();

  if (!svg) return '';

  for (const [from, to] of recolorPairs) {
    svg = replaceAllCaseInsensitive(svg, from, to);
  }

  const primary = recolorPairs[0]?.[1] || null;
  if (primary) {
    svg = svg.replace(/fill=(['"])inherit\1/gi, `fill="${primary}"`);
    svg = svg.replace(/stroke=(['"])inherit\1/gi, `stroke="${primary}"`);
    svg = svg.replace(/currentColor/gi, primary);
  }

  return svg;
}

function buildTextShadowCss(el) {
  const effects = arr(el?.j?.A);
  const shadow = effects.find((fx) => fx?.A === 'shadow')?.B;
  if (!shadow) return null;

  const angleDeg = Number(shadow.angle || 0);
  const offset = Number(shadow.offset || 0);
  const blur = Math.max(0, Number(shadow.blur || 0));
  const transparency = Number(shadow.transparency ?? 0);
  const alpha = Number.isFinite(transparency) ? 1 - Math.max(0, Math.min(1, transparency)) : 1;
  const color = hexToRgba(shadow.color || '#000000', alpha) || `rgba(0,0,0,${alpha.toFixed(3)})`;
  const rad = (angleDeg * Math.PI) / 180;
  const x = Math.cos(rad) * offset;
  const y = Math.sin(rad) * offset;
  return `${x.toFixed(3)}px ${y.toFixed(3)}px ${blur.toFixed(3)}px ${color}`;
}

function verifyRenderedHtml(html, expectedPages) {
  const errors = [];
  const warnings = [];

  const banned = [
    /assets\/pages\//i,
    /page-\d+-(preview|thumbnail)\.png/i,
    /document-image/i,
  ];

  for (const re of banned) {
    if (re.test(html)) {
      errors.push(`Banned fallback reference detected: ${String(re)}`);
    }
  }

  const slideCount = (html.match(/<section class="slide-wrap"/g) || []).length;
  if (slideCount !== expectedPages) {
    errors.push(`Slide count mismatch. expected=${expectedPages} actual=${slideCount}`);
  }

  const textCount = (html.match(/class="el text"/g) || []).length;
  if (textCount === 0) {
    errors.push('No text elements rendered.');
  }

  const mediaCount = (html.match(/class="el media/g) || []).length;
  if (mediaCount === 0) {
    warnings.push('No media elements rendered.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    slideCount,
    textCount,
    mediaCount,
  };
}

function buildHtml(templateData, assetsRoot, options = {}) {
  const pages = arr(templateData.pages);
  const docW = Number(templateData?.docSize?.A || 1080);
  const docH = Number(templateData?.docSize?.B || 1350);
  const textWidthMode = String(options.textWidthMode || 'measured').toLowerCase();
  const textHeightMode = String(options.textHeightMode || 'measured').toLowerCase();
  const textVAlign = String(options.textVAlign || 'center').toLowerCase();
  const trimTextTrailingNewline = options.trimTextTrailingNewline !== false;
  const defaultFontScaleById = {};
  const fontScaleById = { ...defaultFontScaleById, ...(options.fontScaleById || {}) };
  const requestedPageIndex =
    options.pageIndex != null && Number.isFinite(Number(options.pageIndex))
      ? Number(options.pageIndex)
      : null;
  const pagesToRender =
    requestedPageIndex != null && requestedPageIndex >= 0 && requestedPageIndex < pages.length
      ? [pages[requestedPageIndex]]
      : pages;
  const pageStart = requestedPageIndex != null ? requestedPageIndex : 0;
  const singlePageMode = pagesToRender.length === 1;
  const fontEntries = arr(templateData.fonts);
  const mediaEntries = arr(templateData.media);
  const mediaMap = new Map(mediaEntries.map((m) => [m.id, m]));
  const localFontByIdAndStyle = readFontManifest(assetsRoot);
  const svgCache = new Map();

  const getLeft = (el) => (Number.isFinite(Number(el?.B)) ? Number(el.B) : 0);
  const getTop = (el) => (Number.isFinite(Number(el?.A)) ? Number(el.A) : 0);
  const getWidth = (el) => (Number.isFinite(Number(el?.D)) ? Number(el.D) : 0);
  const getHeight = (el) => (Number.isFinite(Number(el?.C)) ? Number(el.C) : 0);

  function resolveMedia(mediaId) {
    if (!mediaId) return null;
    const localRel = findLocalMediaFile(assetsRoot, mediaId);
    if (localRel) {
      return {
        src: `./${localRel}`,
        localRel,
        localAbs: path.join(path.dirname(assetsRoot), localRel),
      };
    }
    const remote = chooseRemoteMediaUrl(mediaMap.get(mediaId));
    if (remote) {
      return { src: remote, localRel: null, localAbs: null };
    }
    return null;
  }

  function loadInlineSvg(localAbs, recolorPairs) {
    if (!localAbs || !fs.existsSync(localAbs)) return null;
    const key = `${localAbs}|${JSON.stringify(recolorPairs)}`;
    if (svgCache.has(key)) return svgCache.get(key);
    const raw = fs.readFileSync(localAbs, 'utf8');
    const normalized = normalizeSvgMarkup(raw, recolorPairs);
    svgCache.set(key, normalized);
    return normalized;
  }

  const usedFontIds = new Set();
  for (const pg of pages) {
    for (const el of arr(pg.E)) {
      const allRuns = [...arr(el?.a?.B), ...arr(el?.f?.[0]?.A?.B)];
      for (const r of allRuns) {
        if (r && r['A?'] === 'A' && r.A && r.A['font-family'] && r.A['font-family'].B) {
          usedFontIds.add(String(r.A['font-family'].B).split(',')[0]);
        }
      }
    }
  }

  const fontNameById = {};
  const fontFaceBlocks = [];
  for (const id of usedFontIds) {
    const entry = fontEntries.find((f) => f.A === id);
    if (!entry) continue;
    const cssFamily = `canva_${safeName(id)}`;
    fontNameById[id] = cssFamily;
    for (const st of arr(entry.D)) {
      const files = arr(st.files);
      const file =
        files.find((f) => f.format === 'WOFF2') ||
        files.find((f) => f.format === 'WOFF') ||
        files.find((f) => f.format === 'OTF' || f.format === 'TTF');
      if (!file || !file.url) continue;
      const styleName = String(st.style || 'REGULAR');
      const isItalic = styleName.includes('ITALIC');
      const baseStyle = styleName.replace('_ITALICS', '').replace('_ITALIC', '');
      const weight = fontStyleToWeight(baseStyle);
      const localFont = localFontByIdAndStyle.get(`${id}::${styleName.toUpperCase()}`);
      const srcPath = localFont ? `./${localFont.path}` : file.url;
      const fmt = fontFormatForCss(localFont?.format || file.format || 'woff2');
      fontFaceBlocks.push(
        `@font-face{font-family:${JSON.stringify(cssFamily)};src:url(${JSON.stringify(
          srcPath
        )}) format('${fmt}');font-weight:${weight};font-style:${isItalic ? 'italic' : 'normal'};font-display:swap;}`
      );
    }
  }

  function renderText(el) {
    let text = fixMojibake(
      arr(el?.a?.A)
        .map((x) => x.A || '')
        .join('')
    );
    if (trimTextTrailingNewline) text = text.replace(/\n+$/g, '');
    const segs = toSegments(el?.a?.B, text);
    const first = segs[0]?.style || {};
    const align = String(first['text-align'] || 'left').toLowerCase();
    const boxLeft = getLeft(el);
    const boxTop = getTop(el);
    const boxWidth = getWidth(el);
    const boxHeight = getHeight(el);
    const measuredWidth = Number(el?.e);
    const measuredHeight = Number(el?.f);
    const useMeasuredWidth =
      textWidthMode === 'measured' &&
      Number.isFinite(measuredWidth) &&
      measuredWidth > 0 &&
      boxWidth > 0;
    const useMeasuredHeight =
      textHeightMode === 'measured' &&
      Number.isFinite(measuredHeight) &&
      measuredHeight > 0 &&
      boxHeight > 0;
    const width = useMeasuredWidth ? measuredWidth : boxWidth;
    const height = useMeasuredHeight ? measuredHeight : boxHeight;
    let left = boxLeft;
    let top = boxTop;
    if (useMeasuredWidth) {
      if (align === 'center') {
        left += (boxWidth - width) / 2;
      } else if (align === 'right' || align === 'end') {
        left += boxWidth - width;
      }
    }
    const canVerticalAlignMeasured = useMeasuredHeight && measuredHeight <= boxHeight;
    if (canVerticalAlignMeasured && textVAlign === 'center') {
      top += (boxHeight - height) / 2;
    } else if (canVerticalAlignMeasured && textVAlign === 'bottom') {
      top += boxHeight - height;
    }
    const alignCss = cssForStyle(
      {
        'text-align': align,
        leading: first.leading,
        'text-transform': first['text-transform'],
      },
      fontNameById,
      fontScaleById
    );
    const textShadow = buildTextShadowCss(el);
    const container = [
      'position:absolute',
      `left:${px(left)}`,
      `top:${px(top)}`,
      `width:${px(width)}`,
      `height:${px(height)}`,
      'white-space:pre-wrap',
      'overflow:visible',
      'word-break:normal',
      'overflow-wrap:normal',
      'text-rendering:geometricPrecision',
      alignCss,
      textShadow ? `text-shadow:${textShadow}` : '',
    ]
      .filter(Boolean)
      .join(';');

    const inner = segs
      .map((s) => {
        const css = cssForStyle(s.style, fontNameById, fontScaleById);
        return `<span style="${css}">${escapeHtml(s.text)}</span>`;
      })
      .join('');

    return `<div class="el text" style="${container}">${inner}</div>`;
  }

  function renderShape(el) {
    const shape = arr(el.b)[0] || {};
    const pathD = shape.A || '';
    const fill = shape.B || {};
    const stroke = shape.C || {};

    const common = [
      'position:absolute',
      `left:${px(getLeft(el))}`,
      `top:${px(getTop(el))}`,
      `width:${px(getWidth(el))}`,
      `height:${px(getHeight(el))}`,
    ];

    const isRect = pathD === 'M0 0H64V64H0z';
    const isCircle = pathD.startsWith('M32 0A32 32');

    if (fill?.A === true && fill?.B?.A?.A) {
      const mediaId = fill.B.A.A;
      const media = resolveMedia(mediaId);
      const src = media?.src || '';
      return `<div class="el shape media-fill" style="${common.join(';')};background-image:url(${cssSingleQuoted(
        src
      )});background-size:cover;background-position:center;border-radius:${isCircle ? '50%' : '0'};"></div>`;
    }

    if (isRect || isCircle) {
      const style = [...common, `background:${fill.C || 'transparent'}`];
      if (stroke.B) {
        style.push(`border:${Number(stroke.A || 1)}px solid ${stroke.B}`);
      }
      if (isCircle) style.push('border-radius:50%');
      return `<div class="el shape" style="${style.join(';')}"></div>`;
    }

    const vbW = Number(el?.a?.D || 64);
    const vbH = Number(el?.a?.C || 64);
    return `<svg class="el shape-svg" style="${common.join(
      ';'
    )}" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none"><path d="${escapeHtml(
      pathD
    )}" fill="${escapeHtml(fill.C || 'transparent')}" stroke="${escapeHtml(
      stroke.B || 'none'
    )}" stroke-width="${Number(stroke.A || 0)}"></path></svg>`;
  }

  function renderLine(el) {
    const color = String(el?.d || 'transparent');
    const opacity = el?.f === false ? 0 : 1;
    return `<div class="el line" style="position:absolute;left:${px(getLeft(el))};top:${px(
      getTop(el)
    )};width:${px(getWidth(el))};height:${px(getHeight(el))};background:${escapeHtml(
      color
    )};opacity:${opacity};"></div>`;
  }

  function renderImage(el) {
    const mediaId = el?.a?.B?.A?.A;
    const media = resolveMedia(mediaId);
    const src = media?.src || '';
    const recolorPairs = buildRecolorPairs(el?.a?.B?.C);
    const localIsSvg = Boolean(media?.localAbs && /\.svg$/i.test(media.localAbs));

    if (localIsSvg) {
      const svgMarkup = loadInlineSvg(media.localAbs, recolorPairs);
      if (svgMarkup) {
        return `<div class="el media svg" style="position:absolute;left:${px(getLeft(el))};top:${px(
          getTop(el)
        )};width:${px(getWidth(el))};height:${px(getHeight(el))};">${svgMarkup}</div>`;
      }
    }

    return `<img class="el media img" src=${JSON.stringify(src)} style="position:absolute;left:${px(
      getLeft(el)
    )};top:${px(getTop(el))};width:${px(getWidth(el))};height:${px(
      getHeight(el)
    )};" alt="">`;
  }

  function renderPageBackground(page) {
    const bgColor = page?.D?.C || '#ffffff';
    const bgLayer = page?.D?.B || null;
    const out = [
      `<div class="page-bg-color" style="position:absolute;inset:0;background:${bgColor};"></div>`,
    ];

    const mediaId = bgLayer?.A?.A;
    if (!mediaId) return out.join('\n');

    const rect = bgLayer?.B || {};
    const top = Number.isFinite(Number(rect?.A)) ? Number(rect.A) : 0;
    const left = Number.isFinite(Number(rect?.B)) ? Number(rect.B) : 0;
    const width = Number.isFinite(Number(rect?.D)) ? Number(rect.D) : docW;
    const height = Number.isFinite(Number(rect?.C)) ? Number(rect.C) : docH;
    const media = resolveMedia(mediaId);

    if (!media?.src) return out.join('\n');

    const recolorPairs = buildRecolorPairs(bgLayer?.C);
    const localIsSvg = Boolean(media.localAbs && /\.svg$/i.test(media.localAbs));

    if (localIsSvg) {
      const svgMarkup = loadInlineSvg(media.localAbs, recolorPairs);
      if (svgMarkup) {
        out.push(
          `<div class="page-bg-media svg" style="position:absolute;left:${px(left)};top:${px(
            top
          )};width:${px(width)};height:${px(height)};">${svgMarkup}</div>`
        );
        return out.join('\n');
      }
    }

    out.push(
      `<img class="page-bg-media img" src=${JSON.stringify(media.src)} style="position:absolute;left:${px(
        left
      )};top:${px(top)};width:${px(width)};height:${px(height)};" alt="">`
    );
    return out.join('\n');
  }

  function renderElement(el) {
    const t = el['A?'];
    if (t === 'K') return renderText(el);
    if (t === 'J') return renderShape(el);
    if (t === 'I') return renderImage(el);
    if (t === 'U') return renderLine(el);
    return '';
  }

  const slides = pagesToRender
    .map((pg, i) => {
      const pageNumber = pageStart + i + 1;
      const bg = pg?.D?.C || '#ffffff';
      const bgLayers = renderPageBackground(pg);
      const items = arr(pg.E).map(renderElement).join('\n');
      return `<section class="slide-wrap" id="slide-${pageNumber}">
  <div class="slide" style="background:${bg}">
    <div class="slide-canvas">
      ${bgLayers}
      ${items}
    </div>
  </div>
</section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(templateData?.title || 'Canva Template Clone')}</title>
<style>
${fontFaceBlocks.join('\n')}
*{box-sizing:border-box}
body{margin:0;background:${singlePageMode ? '#fff' : '#ececec'};color:#111;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
.main{padding:${singlePageMode ? '0' : '24px'};display:grid;gap:${singlePageMode ? '0' : '28px'};justify-content:center}
.slide-wrap{width:${singlePageMode ? `${docW}px` : `min(${docW}px,calc(100vw - 32px))`}}
.slide{position:relative;width:100%;aspect-ratio:${docW}/${docH};overflow:hidden;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.12)}
.slide-canvas{position:absolute;inset:0;overflow:hidden}
.slide-canvas > .el,.slide-canvas > .page-bg-media{position:absolute}
.slide-canvas .text{font-kerning:normal}
.slide-canvas .text span{display:inline}
.slide-canvas svg{width:100%;height:100%;display:block}
${singlePageMode ? '' : '@media (max-width:840px){.main{padding:12px}.slide-wrap{width:calc(100vw - 24px)}}'}
</style>
</head>
<body>
  <main class="main">${slides}</main>
</body>
</html>`;

  return {
    html,
    verification: verifyRenderedHtml(html, pagesToRender.length),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const output = args.output;
  const assets = args.assets;
  const verify = String(args.verify || '').toLowerCase() === 'true';
  const pageArg = Number(args.page);
  const pageIndex = Number.isFinite(pageArg) && pageArg >= 1 ? pageArg - 1 : null;
  const textWidthMode = String(args['text-width-mode'] || 'measured').toLowerCase();
  const textHeightMode = String(args['text-height-mode'] || 'measured').toLowerCase();
  const textVAlign = String(args['text-v-align'] || 'center').toLowerCase();
  const trimTextTrailingNewline = String(args['trim-trailing-newline'] || 'true').toLowerCase() !== 'false';
  const fontScaleById = parseFontScaleOverrides(args['font-scale-overrides']);

  if (!input) {
    throw new Error(
      'Missing --input.\nUsage: node scripts/canva/render-template-json-html.mjs --input <template-data.json> [--output <template-clone.html>] [--assets <assets-root>] [--verify true] [--page <1-based>] [--text-width-mode measured|box] [--text-height-mode measured|box] [--text-v-align top|center|bottom] [--font-scale-overrides \"YAFcfq7XuZE=0.75,YAD86m_J1ck=0.75\"]'
    );
  }

  const inputPath = path.resolve(input);
  const outPath = output ? path.resolve(output) : path.join(path.dirname(inputPath), 'template-clone.html');
  const assetsRoot = assets ? path.resolve(assets) : path.join(path.dirname(inputPath), 'assets');

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { html, verification } = buildHtml(data, assetsRoot, {
    textWidthMode,
    textHeightMode,
    textVAlign,
    trimTextTrailingNewline,
    fontScaleById,
    pageIndex,
  });
  fs.writeFileSync(outPath, html, 'utf8');

  const summary = {
    input: inputPath,
    output: outPath,
    assetsRoot,
    pages: arr(data.pages).length,
    renderedPage: pageIndex != null ? pageIndex + 1 : null,
    modes: {
      textWidthMode,
      textHeightMode,
      textVAlign,
      trimTextTrailingNewline,
      fontScaleById,
    },
    verification,
  };

  if (verify && !verification.ok) {
    console.error(JSON.stringify(summary, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
