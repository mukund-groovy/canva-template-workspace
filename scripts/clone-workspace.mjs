#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let currentProgressFile = null;

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

function copyDirReplace(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function runNode(scriptPath, args = [], cwd = process.cwd()) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJsonSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
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

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function hasReferencePages(pagesDir) {
  if (!fs.existsSync(pagesDir)) return false;
  const files = fs.readdirSync(pagesDir);
  return files.some((f) => /^page-\d+-(preview|thumbnail)\.png$/i.test(f));
}

function writeRunPointers(runsRoot, record) {
  ensureDir(runsRoot);
  const latestPath = path.join(runsRoot, 'latest.json');
  const indexPath = path.join(runsRoot, 'index.json');
  writeJson(latestPath, record);

  const index = readJsonSafe(indexPath, { runs: [] }) || { runs: [] };
  const runs = Array.isArray(index.runs) ? index.runs : [];
  const entry = {
    runId: record.runId,
    createdAt: record.createdAt,
    runDir: record.runDir,
    report: record.report,
    output: record.output || null,
    source: record.source || null,
    duplicate: Boolean(record.duplicate),
  };
  const deduped = [entry, ...runs.filter((r) => String(r?.runId || '') !== String(record.runId || ''))].slice(
    0,
    200
  );
  writeJson(indexPath, { runs: deduped });
}

function emitProgress(progressFile, stage, payload = {}) {
  if (!progressFile) return;
  const body = {
    stage,
    at: new Date().toISOString(),
    ...payload,
  };
  writeJson(progressFile, body);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const designId = args['design-id'];
  const inputHtml = args['input-html'];
  const dedupeMode = String(args['dedupe-mode'] || 'skip').toLowerCase();
  const progressFile = args['progress-file'] ? path.resolve(args['progress-file']) : null;
  currentProgressFile = progressFile;
  const targetRmseArg = Number(args['target-rmse']);
  const hasTargetRmse = Number.isFinite(targetRmseArg) && targetRmseArg > 0;
  const stopOnTarget = String(args['stop-on-target'] || 'true').toLowerCase() !== 'false';

  if (!designId) {
    throw new Error('Missing required --design-id');
  }
  if (!inputHtml) {
    throw new Error('Missing required --input-html (captured Canva editor-page.full.html)');
  }

  // Standalone: workspace is the parent of this scripts/ dir (cwd-independent).
  const workspaceRoot = args['workspace-root']
    ? path.resolve(args['workspace-root'])
    : path.resolve(path.dirname(process.argv[1] || '.'), '..');
  const repoRoot = path.resolve(workspaceRoot, '..');

  const designRoot = path.join(workspaceRoot, 'designs', designId);
  const captureDir = path.join(designRoot, 'capture');
  const extractDir = path.join(designRoot, 'extract');
  const finalDir = path.join(designRoot, 'final');
  const runsRoot = path.join(designRoot, 'runs');
  const sharedDedupeIndexPath = path.join(workspaceRoot, 'index', 'template-dedupe-index.json');
  const localIndexDir = path.join(designRoot, 'index');
  const localDedupeIndexSnapshotPath = path.join(localIndexDir, 'template-dedupe-index.json');
  const summaryPath = path.join(designRoot, 'workspace-summary.json');

  ensureDir(captureDir);
  ensureDir(extractDir);
  ensureDir(finalDir);
  ensureDir(localIndexDir);
  ensureDir(path.join(workspaceRoot, 'index'));
  ensureDir(runsRoot);

  const inputHtmlPath = path.resolve(inputHtml);
  assertFile(inputHtmlPath, 'Input HTML');

  const capturedHtmlPath = path.join(captureDir, 'editor-page.full.html');
  fs.copyFileSync(inputHtmlPath, capturedHtmlPath);

  const cloneScript = path.join(workspaceRoot, 'scripts', 'canva', 'clone-canva-template.mjs');
  const bestScript = path.join(workspaceRoot, 'scripts', 'canva', 'generate-best-pure-clone.mjs');
  const renderScript = path.join(workspaceRoot, 'scripts', 'canva', 'render-template-json-html.mjs');
  assertFile(cloneScript, 'Clone script');
  assertFile(bestScript, 'Best-clone script');
  assertFile(renderScript, 'Render script');

  const startedAt = new Date().toISOString();
  emitProgress(progressFile, 'cloning', { designId, startedAt });
  const cloneArgs = (inputPath) => [
    '--input',
    inputPath,
    '--output',
    extractDir,
    '--design-id',
    designId,
      '--dedupe-mode',
      dedupeMode,
      '--dedupe-index',
      sharedDedupeIndexPath,
    ];

  let cloneInputUsed = capturedHtmlPath;
  let cloneRes = runNode(cloneScript, cloneArgs(cloneInputUsed), workspaceRoot);
  let cloneJson = parseJsonOutput(cloneRes.stdout);

  if (cloneRes.status !== 0 || !cloneJson) {
    const sourceDir = path.dirname(inputHtmlPath);
    const reconstructed = path.join(sourceDir, 'editor-page.reconstructed.html');
    if (fs.existsSync(reconstructed)) {
      const reconstructedCapture = path.join(captureDir, 'editor-page.reconstructed.html');
      fs.copyFileSync(reconstructed, reconstructedCapture);
      cloneInputUsed = reconstructedCapture;
      cloneRes = runNode(cloneScript, cloneArgs(cloneInputUsed), workspaceRoot);
      cloneJson = parseJsonOutput(cloneRes.stdout);
    }
  }

  if (cloneRes.status !== 0 || !cloneJson) {
    throw new Error(`Clone step failed.\nSTDOUT:\n${cloneRes.stdout}\nSTDERR:\n${cloneRes.stderr}`);
  }
  emitProgress(progressFile, cloneJson.duplicate ? 'duplicate' : 'cloned', {
    designId,
    duplicate: Boolean(cloneJson.duplicate),
    duplicateOf: cloneJson.duplicateOf || null,
  });

  if (fs.existsSync(sharedDedupeIndexPath)) {
    fs.copyFileSync(sharedDedupeIndexPath, localDedupeIndexSnapshotPath);
  }

  const finalOutputPath = path.join(finalDir, 'template-clone-pure-html.html');
  let bestJson = null;
  let runTracking = null;

  if (!cloneJson.duplicate) {
    emitProgress(progressFile, 'generating', { designId });
    const referencePagesDir = path.join(extractDir, 'assets', 'pages');
    if (hasReferencePages(referencePagesDir)) {
      const bestArgs = [
        '--design-dir',
        extractDir,
        '--runs-root',
        runsRoot,
        '--output',
        finalOutputPath,
      ];
      if (hasTargetRmse) {
        bestArgs.push('--target-rmse', String(targetRmseArg));
        bestArgs.push('--stop-on-target', String(stopOnTarget));
      }
      const bestRes = runNode(
        bestScript,
        bestArgs,
        workspaceRoot
      );
      bestJson = parseJsonOutput(bestRes.stdout);
      if (bestRes.status !== 0 || !bestJson) {
        throw new Error(`Best-clone step failed.\nSTDOUT:\n${bestRes.stdout}\nSTDERR:\n${bestRes.stderr}`);
      }
      if (bestJson?.runId && bestJson?.runDir) {
        runTracking = {
          runId: bestJson.runId,
          runDir: bestJson.runDir,
          report: bestJson.report || null,
          output: bestJson.runOutput || bestJson.output || finalOutputPath,
          createdAt: new Date().toISOString(),
          source: 'generate-best-pure-clone',
          duplicate: false,
        };
      }
    } else {
      const templateDataPath = path.join(extractDir, 'template-data.json');
      const renderRes = runNode(
        renderScript,
        [
          '--input',
          templateDataPath,
          '--assets',
          path.join(extractDir, 'assets'),
          '--output',
          finalOutputPath,
          '--verify',
          'true',
          '--text-width-mode',
          'box',
          '--text-height-mode',
          'box',
          '--text-v-align',
          'top',
        ],
        workspaceRoot
      );
      const renderJson = parseJsonOutput(renderRes.stdout);
      if (renderRes.status !== 0 || !renderJson) {
        throw new Error(`Fallback render step failed.\nSTDOUT:\n${renderRes.stdout}\nSTDERR:\n${renderRes.stderr}`);
      }
      bestJson = {
        mode: 'fallback-no-reference-pages',
        output: finalOutputPath,
        render: renderJson,
      };

      const runId = makeRunId();
      const runDir = path.join(runsRoot, runId);
      const runFinalDir = path.join(runDir, 'final');
      const runLogsDir = path.join(runDir, 'logs');
      ensureDir(runFinalDir);
      ensureDir(runLogsDir);
      const runOutput = path.join(runFinalDir, 'template-clone-pure-html.html');
      fs.copyFileSync(finalOutputPath, runOutput);
      const reportPath = path.join(runDir, 'report.json');
      writeJson(reportPath, {
        run: {
          runId,
          createdAt: new Date().toISOString(),
          source: 'fallback-no-reference-pages',
        },
        designId,
        duplicate: false,
        output: runOutput,
        render: renderJson,
      });
      runTracking = {
        runId,
        runDir,
        report: reportPath,
        output: runOutput,
        createdAt: new Date().toISOString(),
        source: 'fallback-no-reference-pages',
        duplicate: false,
      };
      writeRunPointers(runsRoot, runTracking);
    }
  } else {
    const runId = makeRunId();
    const runDir = path.join(runsRoot, runId);
    ensureDir(runDir);
    const reportPath = path.join(runDir, 'report.json');
    writeJson(reportPath, {
      run: {
        runId,
        createdAt: new Date().toISOString(),
        source: 'duplicate-skip',
      },
      designId,
      duplicate: true,
      duplicateOf: cloneJson.duplicateOf || null,
      output: null,
    });
    runTracking = {
      runId,
      runDir,
      report: reportPath,
      output: null,
      createdAt: new Date().toISOString(),
      source: 'duplicate-skip',
      duplicate: true,
    };
    writeRunPointers(runsRoot, runTracking);
  }

  const summary = {
    designId,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceRoot,
    paths: {
      designRoot,
      captureDir,
      extractDir,
      finalDir,
      runsRoot,
      dedupeIndexPath: sharedDedupeIndexPath,
      localDedupeIndexSnapshotPath,
      cloneInputUsed,
    },
    clone: cloneJson,
    best: bestJson,
    quality: {
      targetRmse: hasTargetRmse ? targetRmseArg : null,
      stopOnTarget,
      gate: bestJson?.qualityGate || null,
    },
    runTracking,
    final: {
      duplicate: Boolean(cloneJson.duplicate),
      output: cloneJson.duplicate ? null : finalOutputPath,
      duplicateOf: cloneJson.duplicateOf || null,
    },
  };

  writeJson(summaryPath, summary);

  // Ensure final HTML paths have local assets beside them so file:// rendering works.
  const extractAssetsDir = path.join(extractDir, 'assets');
  if (!cloneJson.duplicate && fs.existsSync(extractAssetsDir)) {
    copyDirReplace(extractAssetsDir, path.join(finalDir, 'assets'));
    if (runTracking?.output) {
      copyDirReplace(extractAssetsDir, path.join(path.dirname(runTracking.output), 'assets'));
    }
  }
  emitProgress(progressFile, cloneJson.duplicate ? 'duplicate' : 'success', {
    designId,
    output: summary.final.output,
    duplicate: Boolean(cloneJson.duplicate),
    duplicateOf: summary.final.duplicateOf || null,
    finishedAt: summary.finishedAt,
  });

  console.log(
    JSON.stringify(
      {
        designId,
        duplicate: summary.final.duplicate,
        output: summary.final.output,
        duplicateOf: summary.final.duplicateOf,
        summary: summaryPath,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  emitProgress(currentProgressFile, 'failed', {
    error: err?.stack || String(err),
  });
  console.error(err?.stack || String(err));
  process.exit(1);
}
