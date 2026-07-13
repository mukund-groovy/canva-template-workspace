#!/usr/bin/env node
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

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...options,
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function serializeFontScaleOverrides(overrides) {
  const entries = Object.entries(overrides || {}).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}=${Number(v)}`).join(',');
}

function buildFontProfiles() {
  return [
    { id: 'default', fontScaleOverrides: {} },
    { id: 'global-098', fontScaleOverrides: { '*': 0.98 } },
    { id: 'global-102', fontScaleOverrides: { '*': 1.02 } },
    { id: 'global-096', fontScaleOverrides: { '*': 0.96 } },
    { id: 'global-104', fontScaleOverrides: { '*': 1.04 } },
  ];
}

function copyDirRecursive(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(dstPath));
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function makeRunId(date = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function readJsonFileSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function referencePriority(kind) {
  if (kind === 'actual') return 3;
  if (kind === 'preview') return 2;
  if (kind === 'thumbnail') return 1;
  return 0;
}

function parsePageAssetFileName(fileName) {
  const m = String(fileName || '').match(/^page-(\d+)-(actual|preview|thumbnail)\.(png|jpg|jpeg|webp|gif)$/i);
  if (!m) return null;
  return {
    page: Number(m[1]),
    kind: String(m[2]).toLowerCase(),
    ext: String(m[3]).toLowerCase(),
  };
}

function normalizeRefKindFromManifestKind(kind) {
  const raw = String(kind || '').toLowerCase();
  if (raw === 'page-actual') return 'actual';
  if (raw === 'page-preview') return 'preview';
  if (raw === 'page-thumbnail') return 'thumbnail';
  return null;
}

function isFallbackReferenceCandidate(candidate) {
  const lowerContentType = String(candidate?.contentType || '').toLowerCase();
  const lowerDetectedExt = String(candidate?.detectedExt || '').toLowerCase();
  const lowerPathExt = path.extname(String(candidate?.path || '')).replace('.', '').toLowerCase();
  const decodedUrl = decodeURIComponentSafe(candidate?.url).toLowerCase();
  const bytes = Number(candidate?.bytes || 0);
  const kind = String(candidate?.kind || '').toLowerCase();

  if (candidate?.isFallback === true) return true;
  if (lowerContentType.includes('gif') || lowerDetectedExt === 'gif' || lowerPathExt === 'gif') return true;
  if (decodedUrl.includes('default_preview.gif') || decodedUrl.includes('default_thumbnail.gif')) return true;
  if (kind === 'preview' && bytes > 0 && bytes < 5000) return true;

  return false;
}

function assessReferenceResolution({ imagePath, expectedW, expectedH, kind }) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return {
      width: null,
      height: null,
      scale: null,
      ratioDelta: null,
      lowResolution: false,
      reason: null,
    };
  }

  let dims = null;
  try {
    dims = imageSize(imagePath);
  } catch {
    return {
      width: null,
      height: null,
      scale: null,
      ratioDelta: null,
      lowResolution: false,
      reason: null,
    };
  }

  const width = Number(dims?.w || 0);
  const height = Number(dims?.h || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      width: null,
      height: null,
      scale: null,
      ratioDelta: null,
      lowResolution: false,
      reason: null,
    };
  }

  if (!Number.isFinite(expectedW) || !Number.isFinite(expectedH) || expectedW <= 0 || expectedH <= 0) {
    return {
      width,
      height,
      scale: null,
      ratioDelta: null,
      lowResolution: false,
      reason: null,
    };
  }

  const expectedRatio = expectedW / expectedH;
  const actualRatio = width / height;
  const ratioDelta = Math.abs(actualRatio - expectedRatio) / Math.max(expectedRatio, 1e-9);
  const scale = Math.min(width / expectedW, height / expectedH);
  const kindLower = String(kind || '').toLowerCase();

  // Reject references that are too small compared to the design canvas.
  // "actual" refs are expected to be close to canvas size; preview/thumbnail can be smaller.
  const minScale = kindLower === 'actual' ? 0.75 : 0.65;
  const maxRatioDelta = 0.08;
  const lowByScale = scale < minScale;
  const lowByAspect = ratioDelta > maxRatioDelta;
  const lowResolution = lowByScale || lowByAspect;

  let reason = null;
  if (lowResolution) {
    if (lowByScale) {
      reason = `low-scale(${scale.toFixed(3)} < ${minScale.toFixed(2)})`;
    } else if (lowByAspect) {
      reason = `ratio-mismatch(${ratioDelta.toFixed(3)} > ${maxRatioDelta.toFixed(2)})`;
    }
  }

  return {
    width,
    height,
    scale,
    ratioDelta,
    lowResolution,
    reason,
  };
}

function buildReferenceSelection({ pagesDir, expectedPages, expectedW, expectedH, downloadManifest }) {
  const byPage = new Map();
  const addCandidate = (candidate) => {
    if (!candidate) return;
    if (!Number.isFinite(candidate.page) || candidate.page <= 0) return;
    if (!candidate.path || !fs.existsSync(candidate.path)) return;

    const res = assessReferenceResolution({
      imagePath: candidate.path,
      expectedW,
      expectedH,
      kind: candidate.kind,
    });

    const isFallback = Boolean(candidate.isFallback || res.lowResolution);
    const list = byPage.get(candidate.page) || [];
    list.push({
      ...candidate,
      width: res.width,
      height: res.height,
      resolutionScale: res.scale,
      ratioDelta: res.ratioDelta,
      lowResolution: res.lowResolution,
      lowResolutionReason: res.reason,
      isFallback,
      priority: referencePriority(candidate.kind),
    });
    byPage.set(candidate.page, list);
  };

  for (const row of arr(downloadManifest?.downloaded)) {
    const kind = normalizeRefKindFromManifestKind(row?.kind);
    if (!kind) continue;
    const page = Number(row?.page);
    if (!Number.isFinite(page) || page <= 0) continue;
    // Keep reference resolution local to this run's pages dir, so stale absolute
    // paths from copied/moved extracts can't leak references from another folder.
    const rowPath = path.join(pagesDir, path.basename(String(row?.path || '')));
    addCandidate({
      page,
      kind,
      path: rowPath,
      source: String(row?.source || 'manifest'),
      url: row?.url || null,
      contentType: row?.contentType || '',
      detectedExt: row?.detectedExt || null,
      bytes: Number(row?.bytes || 0),
      isFallback: isFallbackReferenceCandidate({
        ...row,
        kind,
        path: rowPath,
      }),
      manifestEntry: row,
    });
  }

  if (fs.existsSync(pagesDir)) {
    for (const file of fs.readdirSync(pagesDir)) {
      const parsed = parsePageAssetFileName(file);
      if (!parsed) continue;
      const candidatePath = path.join(pagesDir, file);
      const size = fs.statSync(candidatePath).size;
      addCandidate({
        page: parsed.page,
        kind: parsed.kind,
        path: candidatePath,
        source: 'filesystem',
        url: null,
        contentType: '',
        detectedExt: parsed.ext,
        bytes: size,
        isFallback: isFallbackReferenceCandidate({
          kind: parsed.kind,
          path: candidatePath,
          detectedExt: parsed.ext,
          contentType: '',
          bytes: size,
        }),
      });
    }
  }

  const maxPageFromCandidates = [...byPage.keys()].reduce((max, p) => Math.max(max, p), 0);
  const totalPages = Math.max(Number(expectedPages || 0), maxPageFromCandidates);
  const references = [];
  const diagnostics = {
    expectedPages: Number(expectedPages || 0),
    discoveredPages: maxPageFromCandidates,
    missingPages: [],
    onlyFallbackPages: [],
    pagesWithoutActual: [],
    lowResolutionPages: [],
    candidateSummary: [],
  };

  for (let page = 1; page <= totalPages; page++) {
    const all = arr(byPage.get(page));
    const valid = all.filter((c) => !c.isFallback);
    valid.sort((a, b) => b.priority - a.priority || String(a.path).localeCompare(String(b.path)));
    const best = valid[0] || null;
    if (!best) {
      if (all.length > 0) diagnostics.onlyFallbackPages.push(page);
      else diagnostics.missingPages.push(page);
    } else if (best.kind !== 'actual') {
      diagnostics.pagesWithoutActual.push(page);
    }
    const chosenLowRes = best && best.lowResolution;
    const onlyLowResAvailable = !best && all.some((c) => c.lowResolution);
    if (chosenLowRes || onlyLowResAvailable) {
      const sourceCandidate = best || all.find((c) => c.lowResolution) || null;
      diagnostics.lowResolutionPages.push({
        page,
        kind: sourceCandidate?.kind || null,
        source: sourceCandidate?.source || null,
        path: sourceCandidate?.path || null,
        width: sourceCandidate?.width ?? null,
        height: sourceCandidate?.height ?? null,
        resolutionScale: sourceCandidate?.resolutionScale ?? null,
        reason: sourceCandidate?.lowResolutionReason || null,
      });
    }

    diagnostics.candidateSummary.push({
      page,
      chosen: best
        ? {
            kind: best.kind,
            path: best.path,
            source: best.source,
            isFallback: best.isFallback,
            width: best.width,
            height: best.height,
            resolutionScale: best.resolutionScale,
            lowResolution: best.lowResolution,
            lowResolutionReason: best.lowResolutionReason,
          }
        : null,
      candidates: all
        .map((c) => ({
          kind: c.kind,
          path: c.path,
          source: c.source,
          isFallback: c.isFallback,
          bytes: c.bytes,
          width: c.width,
          height: c.height,
          resolutionScale: c.resolutionScale,
          lowResolution: c.lowResolution,
          lowResolutionReason: c.lowResolutionReason,
        }))
        .sort((a, b) => referencePriority(b.kind) - referencePriority(a.kind)),
    });

    if (best) {
      references.push({
        page,
        kind: best.kind,
        path: best.path,
        source: best.source,
        isFallback: best.isFallback,
        width: best.width,
        height: best.height,
        resolutionScale: best.resolutionScale,
      });
    }
  }

  return { references, diagnostics };
}

function imageSize(imagePath) {
  const res = run('magick', ['identify', '-ping', '-format', '%w %h', imagePath]);
  if (res.status !== 0) {
    throw new Error(`magick identify failed for ${imagePath}\n${res.stderr || res.stdout}`);
  }
  const [w, h] = res.stdout.trim().split(/\s+/).map((n) => Number(n));
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(`Unable to parse image size for ${imagePath}`);
  }
  return { w, h };
}

function parseNormalizedMetric(metricText, metricName) {
  const match = String(metricText || '').match(/\(([0-9.]+)\)/);
  if (!match) {
    throw new Error(`Unable to parse ${metricName} metric output: ${metricText}`);
  }
  const normalized = Number(match[1]);
  if (!Number.isFinite(normalized)) {
    throw new Error(`Invalid ${metricName} metric value: ${match[1]}`);
  }
  return normalized;
}

function compareVisualMetrics(referencePath, candidatePath, workingDir) {
  const { w, h } = imageSize(referencePath);
  const resizedPath = path.join(workingDir, `${path.basename(candidatePath, '.png')}-resized.png`);

  const resizeRes = run('magick', [candidatePath, '-resize', `${w}x${h}!`, resizedPath]);
  if (resizeRes.status !== 0) {
    throw new Error(`magick resize failed\n${resizeRes.stderr || resizeRes.stdout}`);
  }

  const cmpGlobal = run('magick', ['compare', '-metric', 'RMSE', referencePath, resizedPath, 'null:']);
  const globalRmse = parseNormalizedMetric(`${cmpGlobal.stderr} ${cmpGlobal.stdout}`.trim(), 'global RMSE');

  const refEdge = path.join(workingDir, `${path.basename(referencePath, '.png')}-edge.png`);
  const candEdge = path.join(workingDir, `${path.basename(candidatePath, '.png')}-edge.png`);
  let edgeRmse = globalRmse;
  let edgeAvailable = false;

  const refEdgeRes = run('magick', [
    referencePath,
    '-colorspace',
    'Gray',
    '-canny',
    '0x1+10%+30%',
    refEdge,
  ]);
  const candEdgeRes = run('magick', [
    resizedPath,
    '-colorspace',
    'Gray',
    '-canny',
    '0x1+10%+30%',
    candEdge,
  ]);

  if (refEdgeRes.status === 0 && candEdgeRes.status === 0) {
    const cmpEdge = run('magick', ['compare', '-metric', 'RMSE', refEdge, candEdge, 'null:']);
    edgeRmse = parseNormalizedMetric(`${cmpEdge.stderr} ${cmpEdge.stdout}`.trim(), 'edge RMSE');
    edgeAvailable = true;
  }

  const weightedScore = edgeAvailable ? globalRmse * 0.35 + edgeRmse * 0.65 : globalRmse;
  return {
    globalRmse,
    edgeRmse,
    weightedScore,
    edgeAvailable,
    resizedPath,
  };
}

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome binary not found. Set CHROME_BIN env var.');
}

function screenshotHtml(chromePath, htmlPath, outputPath, width, height) {
  const url = pathToFileURL(htmlPath).toString();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--run-all-compositor-stages-before-draw',
    `--window-size=${Math.max(1, Math.round(width))},${Math.max(1, Math.round(height))}`,
    `--screenshot=${outputPath}`,
    url,
  ];
  const res = run(chromePath, args);
  if (res.status !== 0) {
    throw new Error(`Chrome screenshot failed for ${htmlPath}\n${res.stderr || res.stdout}`);
  }
}

function readTemplateInfo(templateDataPath) {
  const data = JSON.parse(fs.readFileSync(templateDataPath, 'utf8'));
  return {
    pages: arr(data.pages).length,
    docW: Number(data?.docSize?.A || 1080),
    docH: Number(data?.docSize?.B || 1350),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const targetRmseArg = Number(args['target-rmse']);
  const hasTargetRmse = Number.isFinite(targetRmseArg) && targetRmseArg > 0;
  const stopOnTarget = String(args['stop-on-target'] || 'true').toLowerCase() !== 'false';
  const requireComparedPages = String(args['require-compared-pages'] || 'true').toLowerCase() !== 'false';
  const requireActualReferences =
    String(args['require-actual-references'] || 'true').toLowerCase() !== 'false';
  const designId = args['design-id'];
  const root = args.root
    ? path.resolve(args.root)
    : path.resolve(process.cwd(), '.tmp', 'canva-template-json');
  const designDir = args['design-dir']
    ? path.resolve(args['design-dir'])
    : designId
      ? path.join(root, designId)
      : null;

  if (!designDir) {
    throw new Error('Missing --design-id or --design-dir');
  }

  const templateDataPath = args.input
    ? path.resolve(args.input)
    : path.join(designDir, 'template-data.json');
  const assetsRoot = args.assets
    ? path.resolve(args.assets)
    : path.join(designDir, 'assets');
  const finalOutput = args.output
    ? path.resolve(args.output)
    : path.join(designDir, 'template-clone-pure-html.html');

  const runsRoot = args['runs-root']
    ? path.resolve(args['runs-root'])
    : path.resolve(process.cwd(), 'runs', String(designId || path.basename(designDir)), 'runs');
  const runId = String(args['run-id'] || makeRunId(startedAt));
  const runDir = path.join(runsRoot, runId);
  if (fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0) {
    throw new Error(`Run directory already exists and is not empty: ${runDir}`);
  }

  const artifactsDir = path.join(runDir, 'artifacts');
  const candidateDir = path.join(artifactsDir, 'candidates');
  const screenshotDir = path.join(artifactsDir, 'screenshots');
  const finalDir = path.join(runDir, 'final');
  const logsDir = path.join(runDir, 'logs');

  ensureDir(runsRoot);
  ensureDir(runDir);
  ensureDir(artifactsDir);
  ensureDir(candidateDir);
  ensureDir(screenshotDir);
  ensureDir(finalDir);
  ensureDir(logsDir);
  const candidateAssetsRoot = path.join(candidateDir, 'assets');
  copyDirRecursive(assetsRoot, candidateAssetsRoot);

  const { pages, docW, docH } = readTemplateInfo(templateDataPath);
  const pagesDir = path.join(assetsRoot, 'pages');
  const downloadManifest = readJsonFileSafe(path.join(assetsRoot, 'download-manifest.json'), {
    downloaded: [],
    failed: [],
  });
  const { references, diagnostics: referenceDiagnostics } = buildReferenceSelection({
    pagesDir,
    expectedPages: pages,
    expectedW: docW,
    expectedH: docH,
    downloadManifest,
  });
  const hasReferences = references.length > 0;

  const lowResolutionReferencePages = [
    ...new Set(arr(referenceDiagnostics.lowResolutionPages).map((row) => Number(row?.page)).filter(Number.isFinite)),
  ].sort((a, b) => a - b);
  if (requireComparedPages && lowResolutionReferencePages.length > 0) {
    throw new Error(
      `Low-resolution references detected for page(s): ${lowResolutionReferencePages
        .map((p) => `#${p}`)
        .join(', ')}. Expected references near ${docW}x${docH}; regenerate actual page refs before scoring.`
    );
  }

  if (requireComparedPages && !hasReferences) {
    throw new Error(
      `No valid non-fallback reference images were found in ${pagesDir}. Clone must provide page-XX-actual.* references before generation.`
    );
  }
  if (requireComparedPages && references.length < pages) {
    const missing = [
      ...new Set([...arr(referenceDiagnostics.missingPages), ...arr(referenceDiagnostics.onlyFallbackPages)]),
    ];
    throw new Error(
      `Missing valid references for ${missing.length} page(s): ${missing
        .sort((a, b) => a - b)
        .map((p) => `#${p}`)
        .join(', ')}.`
    );
  }
  if (requireActualReferences) {
    const nonActual = references.filter((r) => r.kind !== 'actual').map((r) => r.page);
    if (nonActual.length > 0) {
      throw new Error(
        `Found non-actual references for page(s): ${nonActual
          .sort((a, b) => a - b)
          .map((p) => `#${p}`)
          .join(', ')}. Provide page-XX-actual.* files for strict compare mode.`
      );
    }
  }

  const baseCandidates = [
    { id: 'measured-center', width: 'measured', height: 'measured', vAlign: 'center' },
    { id: 'measured-top', width: 'measured', height: 'measured', vAlign: 'top' },
    { id: 'measuredW-boxH-top', width: 'measured', height: 'box', vAlign: 'top' },
    { id: 'box-top', width: 'box', height: 'box', vAlign: 'top' },
  ];
  const fontProfiles = buildFontProfiles();
  const candidates = [];
  for (const mode of baseCandidates) {
    for (const profile of fontProfiles) {
      candidates.push({
        id: `${mode.id}.${profile.id}`,
        width: mode.width,
        height: mode.height,
        vAlign: mode.vAlign,
        fontScaleOverrides: profile.fontScaleOverrides,
        fontProfile: profile.id,
      });
    }
  }
  const candidatesToRun = hasReferences ? candidates : [candidates[0]];

  const renderScript = path.resolve(process.cwd(), 'scripts', 'canva', 'render-template-json-html.mjs');
  const chromePath = hasReferences ? chromeBinary() : null;
  const runOutput = path.join(finalDir, 'template-clone-pure-html.html');

  const results = [];
  let earlyStop = null;
  for (const candidate of candidatesToRun) {
    const outHtml = path.join(candidateDir, `${candidate.id}.html`);
    const fontScaleOverridesArg = serializeFontScaleOverrides(candidate.fontScaleOverrides);
    const renderArgs = [
      renderScript,
      '--input',
      templateDataPath,
      '--assets',
      candidateAssetsRoot,
      '--output',
      outHtml,
      '--verify',
      'true',
      '--text-width-mode',
      candidate.width,
      '--text-height-mode',
      candidate.height,
      '--text-v-align',
      candidate.vAlign,
    ];
    if (fontScaleOverridesArg) {
      renderArgs.push('--font-scale-overrides', fontScaleOverridesArg);
    }
    const renderRes = run(process.execPath, renderArgs);
    fs.writeFileSync(
      path.join(logsDir, `render-${candidate.id}.log`),
      `${renderRes.stdout}\n${renderRes.stderr}`.trim(),
      'utf8'
    );
    if (renderRes.status !== 0) {
      throw new Error(`Render failed for ${candidate.id}\n${renderRes.stdout}\n${renderRes.stderr}`);
    }
    const renderJson = parseJsonOutput(renderRes.stdout);

    const pageScores = [];
    if (hasReferences) {
      for (const ref of references) {
        const pageHtml = path.join(candidateDir, `${candidate.id}.page-${String(ref.page).padStart(2, '0')}.html`);
        const pagePng = path.join(screenshotDir, `${candidate.id}.page-${String(ref.page).padStart(2, '0')}.png`);

        const pageRenderArgs = [
          renderScript,
          '--input',
          templateDataPath,
          '--assets',
          candidateAssetsRoot,
          '--output',
          pageHtml,
          '--page',
          String(ref.page),
          '--verify',
          'true',
          '--text-width-mode',
          candidate.width,
          '--text-height-mode',
          candidate.height,
          '--text-v-align',
          candidate.vAlign,
        ];
        if (fontScaleOverridesArg) pageRenderArgs.push('--font-scale-overrides', fontScaleOverridesArg);
        const pageRenderRes = run(process.execPath, pageRenderArgs);
        fs.writeFileSync(
          path.join(logsDir, `render-${candidate.id}-page-${String(ref.page).padStart(2, '0')}.log`),
          `${pageRenderRes.stdout}\n${pageRenderRes.stderr}`.trim(),
          'utf8'
        );
        if (pageRenderRes.status !== 0) {
          throw new Error(
            `Page render failed for ${candidate.id} page ${ref.page}\n${pageRenderRes.stdout}\n${pageRenderRes.stderr}`
          );
        }

        screenshotHtml(chromePath, pageHtml, pagePng, docW, docH);
        const metrics = compareVisualMetrics(ref.path, pagePng, screenshotDir);
        pageScores.push({
          page: ref.page,
          referenceKind: ref.kind,
          referenceSource: ref.source,
          referencePath: ref.path,
          rmse: metrics.weightedScore,
          weightedScore: metrics.weightedScore,
          globalRmse: metrics.globalRmse,
          edgeRmse: metrics.edgeRmse,
          edgeAvailable: metrics.edgeAvailable,
        });
      }
    }

    const avgRmse = hasReferences
      ? pageScores.reduce((sum, p) => sum + p.weightedScore, 0) / Math.max(1, pageScores.length)
      : null;
    const avgGlobalRmse = hasReferences
      ? pageScores.reduce((sum, p) => sum + p.globalRmse, 0) / Math.max(1, pageScores.length)
      : null;
    const avgEdgeRmse = hasReferences
      ? pageScores.reduce((sum, p) => sum + p.edgeRmse, 0) / Math.max(1, pageScores.length)
      : null;

    results.push({
      id: candidate.id,
      modes: {
        textWidthMode: candidate.width,
        textHeightMode: candidate.height,
        textVAlign: candidate.vAlign,
        fontProfile: candidate.fontProfile,
        fontScaleOverrides: candidate.fontScaleOverrides,
      },
      outputHtml: outHtml,
      verification: renderJson?.verification || null,
      pageScores,
      avgRmse,
      avgGlobalRmse,
      avgEdgeRmse,
      scoring: {
        hasReferences,
        metric: hasReferences ? 'weighted(0.35*global_rmse + 0.65*edge_rmse)' : 'none',
        comparedPages: pageScores.length,
      },
    });

    if (hasReferences && hasTargetRmse && Number(avgRmse) <= targetRmseArg && stopOnTarget) {
      earlyStop = {
        candidateId: candidate.id,
        avgRmse,
        targetRmse: targetRmseArg,
      };
      break;
    }
  }

  results.sort((a, b) => {
    const aScore = Number.isFinite(Number(a?.avgRmse)) ? Number(a.avgRmse) : Number.POSITIVE_INFINITY;
    const bScore = Number.isFinite(Number(b?.avgRmse)) ? Number(b.avgRmse) : Number.POSITIVE_INFINITY;
    return aScore - bScore;
  });
  const best = results[0];
  if (!best) {
    throw new Error('No candidates were produced by the generator.');
  }
  copyDirRecursive(assetsRoot, path.join(finalDir, 'assets'));
  const finalOutputAssetsDir = path.join(path.dirname(finalOutput), 'assets');
  if (path.resolve(finalOutputAssetsDir) !== path.resolve(path.join(finalDir, 'assets'))) {
    copyDirRecursive(assetsRoot, finalOutputAssetsDir);
  }
  fs.copyFileSync(best.outputHtml, runOutput);
  fs.copyFileSync(best.outputHtml, finalOutput);

  const finishedAt = new Date();
  const report = {
    run: {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      runsRoot,
      runDir,
    },
    createdAt: new Date().toISOString(),
    designDir,
    templateDataPath,
    assetsRoot,
    outputs: {
      runOutput,
      latestOutput: finalOutput,
    },
    pages,
    references: references.map((r) => ({
      page: r.page,
      kind: r.kind,
      source: r.source,
      isFallback: r.isFallback,
      path: r.path,
    })),
    candidates: results,
    best: {
      id: best.id,
      modes: best.modes,
      avgRmse: best.avgRmse,
      avgGlobalRmse: best.avgGlobalRmse,
      avgEdgeRmse: best.avgEdgeRmse,
      outputHtml: runOutput,
    },
    scoring: {
      hasReferences,
      referencesFound: references.length,
      referencesExpected: pages,
      requireComparedPages,
      requireActualReferences,
      metric: hasReferences ? 'weighted(0.35*global_rmse + 0.65*edge_rmse)' : 'none',
      fallbackUsed: !hasReferences,
      fallbackReason: hasReferences ? null : `No reference pages found in ${pagesDir}`,
      referenceDiagnostics,
      referencesUsed: references.map((r) => ({
        page: r.page,
        kind: r.kind,
        source: r.source,
        path: r.path,
      })),
    },
    qualityGate: {
      targetRmse: hasTargetRmse && hasReferences ? targetRmseArg : null,
      met: hasTargetRmse && hasReferences ? best.avgRmse <= targetRmseArg : null,
      stopOnTarget,
      earlyStop,
    },
  };

  const reportPath = path.join(runDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  const latestReportPath = path.join(designDir, 'template-clone-pure-html-autotune-report.json');
  fs.writeFileSync(latestReportPath, JSON.stringify(report, null, 2), 'utf8');

  const latestMeta = {
    runId,
    runDir,
    report: reportPath,
    output: runOutput,
    latestOutput: finalOutput,
    best: report.best,
    finishedAt: finishedAt.toISOString(),
  };
  fs.writeFileSync(path.join(runsRoot, 'latest.json'), JSON.stringify(latestMeta, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(designDir, 'template-clone-pure-html-latest-run.json'),
    JSON.stringify(latestMeta, null, 2),
    'utf8'
  );

  const indexPath = path.join(runsRoot, 'index.json');
  const index = readJsonFileSafe(indexPath, { runs: [] });
  const entry = {
    runId,
    createdAt: finishedAt.toISOString(),
    runDir,
    report: reportPath,
    output: runOutput,
    latestOutput: finalOutput,
    bestId: best.id,
    avgRmse: best.avgRmse,
  };
  const runs = Array.isArray(index?.runs) ? index.runs : [];
  const deduped = [entry, ...runs.filter((r) => String(r?.runId || '') !== runId)].slice(0, 200);
  fs.writeFileSync(indexPath, JSON.stringify({ runs: deduped }, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        runId,
        runDir,
        runOutput,
        latestOutput: finalOutput,
        latestMeta: path.join(runsRoot, 'latest.json'),
        output: finalOutput,
        report: reportPath,
        best: report.best,
        qualityGate: report.qualityGate,
        comparedPages: references.length,
        comparedKinds: [...new Set(references.map((r) => r.kind))],
        requireComparedPages,
        requireActualReferences,
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
