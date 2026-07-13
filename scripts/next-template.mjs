#!/usr/bin/env node
/**
 * Work queue for archetype authoring.
 *
 * A design is DONE when archetype-map.json maps it to a slug AND that
 * backend/database/carousels/<slug>.html actually exists. Everything else is
 * PENDING. The queue is ordered newest-clone-first, so `next` always hands you
 * the most recently cloned design that has no template yet.
 *
 *   node canva-template-workspace/scripts/next-template.mjs            # next design
 *   node canva-template-workspace/scripts/next-template.mjs --list     # whole queue
 *   node canva-template-workspace/scripts/next-template.mjs --json     # machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has('--json');
const LIST = args.has('--list');

const workspaceRoot = path.resolve(process.cwd(), 'canva-template-workspace');
const designsRoot = path.join(workspaceRoot, 'designs');
const carouselsRoot = path.resolve(process.cwd(), 'backend/database/carousels');
const mapPath = path.join(workspaceRoot, 'archetype-map.json');

const readJson = (p, fb = {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
};

const map = readJson(mapPath);
const designs = fs
  .readdirSync(designsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .filter((d) => fs.existsSync(path.join(designsRoot, d.name, 'extract')))
  .map((d) => d.name);

function inspect(id) {
  const root = path.join(designsRoot, id);
  const summary = readJson(path.join(root, 'workspace-summary.json'));
  const td = readJson(path.join(root, 'extract', 'template-data.json'), null);
  const pagesDir = path.join(root, 'extract', 'assets', 'pages');

  const thumbs = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((f) => f.endsWith('-thumbnail.png'))
    : [];

  const slug = map[id] && !String(map[id]).startsWith('_') ? map[id] : null;
  const html = slug ? path.join(carouselsRoot, `${slug}.html`) : null;
  const done = Boolean(html && fs.existsSync(html));

  // clone time: prefer the run summary, else folder mtime
  let clonedAt = summary?.finishedAt || summary?.startedAt || null;
  if (!clonedAt) { try { clonedAt = fs.statSync(root).mtime.toISOString(); } catch {} }

  const blockers = [];
  if (!td) blockers.push('no template-data.json');
  if (!thumbs.length) blockers.push('no page thumbnails');

  return {
    designId: id,
    done,
    slug,
    clonedAt,
    title: td?.title || '(unknown)',
    pages: td?.pageCount ?? thumbs.length,
    fonts: (td?.fonts || []).map((f) => f.C),
    thumbnails: thumbs.length,
    intake: {
      templateData: path.join(root, 'extract', 'template-data.json'),
      pages: pagesDir,
    },
    blockers,
  };
}

const all = designs.map(inspect);
const pending = all
  .filter((d) => !d.done)
  .sort((a, b) => String(b.clonedAt || '').localeCompare(String(a.clonedAt || '')));
const done = all.filter((d) => d.done);

if (AS_JSON) {
  console.log(JSON.stringify({ next: pending[0] || null, pending, done }, null, 2));
  process.exit(0);
}

if (LIST) {
  console.log(`QUEUE — ${pending.length} pending, ${done.length} done\n`);
  pending.forEach((d, i) => {
    const flag = d.blockers.length ? `  ⚠ ${d.blockers.join(', ')}` : '';
    console.log(`${String(i + 1).padStart(2)}. ${d.designId}  ${String(d.pages).padStart(2)}p  ${d.clonedAt?.slice(0, 19) || '?'}${flag}`);
    console.log(`    ${d.title.slice(0, 76)}`);
  });
  if (done.length) {
    console.log('\nDONE');
    for (const d of done) console.log(`  ✓ ${d.designId} → ${d.slug}`);
  }
  process.exit(0);
}

const next = pending[0];
if (!next) { console.log('Queue empty — every cloned design has a template.'); process.exit(0); }

console.log(`NEXT: ${next.designId}`);
console.log(`  title   ${next.title}`);
console.log(`  pages   ${next.pages}   cloned ${next.clonedAt?.slice(0, 19)}`);
console.log(`  fonts   ${next.fonts.join(', ') || '(none)'}`);
console.log(`  data    ${next.intake.templateData}`);
console.log(`  thumbs  ${next.intake.pages}  (${next.thumbnails} pages)`);
if (next.blockers.length) console.log(`  ⚠ BLOCKED: ${next.blockers.join(', ')}`);
console.log(`\n  ${pending.length - 1} more after this.`);
console.log('  When authored: write backend/database/carousels/<slug>.html, add');
console.log(`  "${next.designId}": "<slug>" to archetype-map.json, then re-run.`);
