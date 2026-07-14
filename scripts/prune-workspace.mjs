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

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function collectRunDirs(runsRoot) {
  if (!fs.existsSync(runsRoot)) return [];
  return fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^[0-9]{8}-[0-9]{6}-[0-9]{3}$/.test(name))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => path.join(runsRoot, name));
}

function pruneRunsRoot(runsRoot, keepRuns) {
  const runDirs = collectRunDirs(runsRoot);
  const toDelete = runDirs.slice(keepRuns);
  let reclaimedBytes = 0;
  for (const dir of toDelete) {
    reclaimedBytes += dirSizeBytes(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return {
    runsRoot,
    found: runDirs.length,
    kept: Math.min(keepRuns, runDirs.length),
    removed: toDelete.length,
    reclaimedBytes,
    removedDirs: toDelete,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = args['workspace-root']
    ? path.resolve(args['workspace-root'])
    : path.resolve(path.dirname(process.argv[1] || '.'), '..');
  const keepRuns = toInt(args['keep-runs'], 2);

  const reports = [];
  const designsRoot = path.join(workspaceRoot, 'designs');
  if (fs.existsSync(designsRoot)) {
    for (const d of fs.readdirSync(designsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const runsRoot = path.join(designsRoot, d.name, 'runs');
      reports.push(pruneRunsRoot(runsRoot, keepRuns));
    }
  }

  // Legacy shared runs root from earlier workflow revisions.
  reports.push(pruneRunsRoot(path.join(workspaceRoot, 'runs'), keepRuns));

  const reclaimedBytes = reports.reduce((sum, r) => sum + Number(r.reclaimedBytes || 0), 0);
  const removedRuns = reports.reduce((sum, r) => sum + Number(r.removed || 0), 0);
  const output = {
    workspaceRoot,
    keepRuns,
    removedRuns,
    reclaimedBytes,
    reports,
  };
  console.log(JSON.stringify(output, null, 2));
}

main();
