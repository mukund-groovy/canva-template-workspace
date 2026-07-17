#!/usr/bin/env node
/**
 * remix-queue-status.mjs — "where were we" for the remix-all-cloned-designs batch.
 *
 * remix-queue.json only records the FIXED scope (which design ids this batch covers, decided
 * once at the start) — never progress. Progress is derived live from remix-map.json (what's
 * actually shipped) and dashboard-store.json (what's mid-flight right now), so this can never
 * go stale or drift out of sync with a duplicated "done" list.
 *
 *   node scripts/remix-queue-status.mjs
 */
import fs from 'fs';
import path from 'path';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, p), 'utf8')); } catch { return d; } };

const q = readJson('remix-queue.json', null);
if (!q) { console.error('No remix-queue.json — no batch in progress.'); process.exit(1); }

const remixMap = readJson('remix-map.json', {});
const store = readJson('dashboard-store.json', { entries: [] });
const entryById = new Map(store.entries.map((e) => [e.designId, e]));
const remixedIds = new Set(Object.values(remixMap).map(String));

const done = [];
const inProgress = [];
const pending = [];

for (const id of q.queue) {
  if (remixedIds.has(id)) {
    const slugs = Object.entries(remixMap).filter(([, v]) => String(v) === id).map(([k]) => k);
    done.push({ id, slugs });
    continue;
  }
  const e = entryById.get(id);
  if (e && e.status === 'generating') inProgress.push({ id, stage: e.genStage || '', updatedAt: e.updatedAt });
  else pending.push(id);
}

console.log(`\nremix batch started ${q.startedAt} — ${q.queue.length} designs in scope\n`);
console.log(`DONE (${done.length}):`);
for (const d of done) console.log(`  ${d.id}  ->  ${d.slugs.join(', ')}`);
console.log(`\nIN PROGRESS (${inProgress.length}):`);
for (const p of inProgress) console.log(`  ${p.id}  [${p.stage}]  updated ${p.updatedAt}`);
console.log(`\nPENDING (${pending.length}):`);
for (const id of pending) console.log(`  ${id}`);

console.log(`\nNEXT UP: ${pending[0] || inProgress[0]?.id || '(none — batch complete)'}\n`);
