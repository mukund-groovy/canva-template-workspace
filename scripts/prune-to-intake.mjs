#!/usr/bin/env node
/**
 * Prune every design folder down to the reference-intake keep-list.
 *
 * The faithful pixel clone is retired: the archetype is authored from the page
 * thumbnails + template-data.json. Everything the clone/scoring stages produced
 * (runs/, final/, Canva's media + fonts) is dead weight — and shipping Canva's
 * assets is the IP problem we removed.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to actually delete.
 *
 *   node scripts/prune-to-intake.mjs                 # report only
 *   node scripts/prune-to-intake.mjs --apply         # delete
 *   node scripts/prune-to-intake.mjs --keep-capture  # retain capture/ + bootstrap.json
 */
import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const KEEP_CAPTURE = args.has('--keep-capture');

const workspaceRoot = path.resolve(process.cwd(), 'canva-template-workspace');
const designsRoot = path.join(workspaceRoot, 'designs');

/** Paths removed from every design, relative to designs/<ID>/ */
const REMOVE = [
  'runs',                                    // pixel-clone candidates + screenshots (the 211 MB)
  'final',                                   // pixel clone + duplicated assets
  'extract/assets/media',                    // Canva's images — never used, IP liability
  'extract/assets/fonts',                    // Canva's font files — licensing
  'extract/bootstrap.json',                  // raw doc JSON; template-data.json is derived
  'extract/template-clone-pure-html-autotune-report.json',
  'extract/template-clone-pure-html-latest-run.json',
  'original-vs-clone.html',                  // regenerable, base64-embedded
];
if (!KEEP_CAPTURE) REMOVE.push('capture'); // transient: parsed into template-data.json

/** Must survive. Anything here missing is reported as a WARNING. */
const KEEP = [
  'extract/template-data.json',
  'extract/template-signature.json',
  'extract/assets/pages',
  'workspace-summary.json',
];

function sizeOf(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += sizeOf(path.join(p, e.name));
  }
  return total;
}

const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(7) + ' MB';

if (!fs.existsSync(designsRoot)) {
  console.error(`No designs/ at ${designsRoot}`);
  process.exit(1);
}

// A design folder is one the pipeline created: it has an extract/ dir. This skips
// stray state dirs (.omc, .progress) that would otherwise be reported as broken designs.
const designs = fs
  .readdirSync(designsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .filter((d) => fs.existsSync(path.join(designsRoot, d.name, 'extract')))
  .map((d) => d.name);

let freedTotal = 0;
let keptTotal = 0;
const warnings = [];

console.log(APPLY ? '=== PRUNE (APPLYING) ===\n' : '=== PRUNE (DRY-RUN — nothing deleted) ===\n');

for (const id of designs) {
  const root = path.join(designsRoot, id);
  const before = sizeOf(root);
  let freed = 0;
  const hits = [];

  for (const rel of REMOVE) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const s = sizeOf(p);
    freed += s;
    hits.push(`${rel} (${(s / 1024 / 1024).toFixed(1)} MB)`);
    if (APPLY) fs.rmSync(p, { recursive: true, force: true });
  }

  for (const rel of KEEP) {
    if (!fs.existsSync(path.join(root, rel))) warnings.push(`${id}: MISSING ${rel}`);
  }
  if (!fs.existsSync(path.join(root, 'extract/document-image-urls.json'))) {
    warnings.push(`${id}: missing extract/document-image-urls.json (cannot refetch page images)`);
  }

  const after = APPLY ? sizeOf(root) : before - freed;
  freedTotal += freed;
  keptTotal += after;

  console.log(`${id}`);
  console.log(`  before ${mb(before)}   after ${mb(after)}   freed ${mb(freed)}`);
  for (const h of hits) console.log(`    - ${h}`);
  if (!hits.length) console.log('    (already lean)');
  console.log('');
}

console.log('────────────────────────────────────');
console.log(`designs      ${designs.length}`);
console.log(`freed        ${mb(freedTotal)}`);
console.log(`remaining    ${mb(keptTotal)}`);

if (warnings.length) {
  console.log('\nWARNINGS');
  for (const w of warnings) console.log(`  ! ${w}`);
}

if (!APPLY) console.log('\nDry-run. Re-run with --apply to delete.');
