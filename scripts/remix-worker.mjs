#!/usr/bin/env node
/**
 * remix-worker.mjs — self-driving REMIX generation over the `cloned` queue.
 *
 *   node scripts/remix-worker.mjs                 # every cloned design, one by one
 *   node scripts/remix-worker.mjs --once          # just the next one
 *   node scripts/remix-worker.mjs --design-id <ID>
 *
 * Same deliverable as `template-remix-agent`: study the reference, keep its design language,
 * INVENT the content (own topic, fresh copy, own composition). Ships standalone to
 * output/<3-word-slug>.html + a remix-map.json entry — it never claims a design's
 * archetype-map entry, and the dashboard row flips to success off the remix.
 *
 * This is a thin wrapper, NOT a second engine: it runs generate-worker.mjs --remix, which
 * shares one copy of the machinery (best-of-N, contract/verify/stress/brand gates, bounded
 * repair, occlusion guard, count-lock, vision review). A forked copy would have to be fixed
 * twice for every gate bug — this repo already carries one such fork (two copies of
 * template-author-agent.md, per CLAUDE.md), which is exactly the drift to avoid.
 *
 * Every flag is forwarded, so `--once`, `--design-id`, `--max`, `--gens`, `--min-score`,
 * `--premium-min`, `--provider` all behave as documented for generate-worker.
 *
 * NOTE: the gate score is not a quality signal — it measures structure, not composition.
 * Look at .renders/output/<slug>/slide-NN.png before trusting any deck this ships.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'generate-worker.mjs');
const args = process.argv.slice(2);

// --remix is the whole point of this wrapper; don't pass it twice if the caller already did.
if (!args.includes('--remix')) args.push('--remix');

const child = spawn(process.execPath, [worker, ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
