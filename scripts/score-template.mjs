#!/usr/bin/env node
/**
 * score-template.mjs — deterministic quality score /10 for an authored template,
 * derived from the four gate scripts (no pixel-clone/RMSE, which is retired).
 *
 *   node canva-template-workspace/scripts/score-template.mjs <slug|path> [--json]
 *
 * Weights (total 10):
 *   contract  4.0  — check-template-contract.mjs (0 violations required for full)
 *   verify    3.0  — verify-slides.mjs (fonts/overflow/collision/contrast/photo)
 *   stress    1.5  — stress-slots.mjs (worst-case generated text holds)
 *   brand     1.5  — brand-audit.mjs (recolors under brand palettes)
 *
 * Writes the result into canva-template-workspace/template-scores.json (keyed by slug)
 * so the dashboard can render it without re-running the gates.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
if (!arg) { console.error('usage: score-template.mjs <slug|path> [--json]'); process.exit(1); }

// Standalone: workspace is the parent of this scripts/ dir.
const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT = fs.existsSync(path.join(WORKSPACE, 'output'))
  ? path.join(WORKSPACE, 'output')
  : path.resolve(WORKSPACE, '..', 'backend', 'database', 'carousels');
const file = arg.endsWith('.html')
  ? path.resolve(arg)
  : path.join(OUTPUT, `${arg}.html`);
const slug = path.basename(file, '.html');
if (!fs.existsSync(file)) { console.error(`no such template: ${file}`); process.exit(1); }

const S = path.join(WORKSPACE, 'scripts');
function run(cmd) {
  try { return { out: execSync(cmd, { cwd: WORKSPACE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; }
  catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 }; }
}
const num = (re, s, d = 0) => { const m = s.match(re); return m ? Number(m[1]) : d; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── contract (4.0): every violation is a real pipeline-breaking bug ──────────
const c = run(`node ${S}/check-template-contract.mjs "${file}"`);
const cViol = num(/(\d+)\s+violation/i, c.out);
const cWarn = num(/(\d+)\s+warning/i, c.out);
const contract = clamp(4 - cViol * 1.0 - cWarn * 0.15, 0, 4);

// ── verify-slides (3.0): render measurements ─────────────────────────────────
const v = run(`node ${S}/verify-slides.mjs "${file}"`);
const vFail = num(/(\d+)\s+fail/i, v.out);
const vWarn = num(/(\d+)\s+warn/i, v.out);
const verify = clamp(3 - vFail * 1.0 - vWarn * 0.3, 0, 3);

// ── stress-slots (1.5): worst-case generated text ────────────────────────────
const st = run(`node ${S}/stress-slots.mjs "${file}"`);
const stFail = num(/(\d+)\s+failure/i, st.out);
const stress = clamp(1.5 - stFail * 0.5, 0, 1.5);

// ── brand-audit (1.5): recolor strength (deck avg % of pixels that move) ──────
const b = run(`node ${S}/brand-audit.mjs "${file}"`);
const deckAvg = num(/deck\s*avg\s+([\d.]+)%/i, b.out);
const brandPass = /RESULT:\s*PASS/i.test(b.out);
const brand = brandPass ? 1.5 : clamp((deckAvg / 3) * 1.5, 0, 1.5);

const score = Math.round((contract + verify + stress + brand) * 10) / 10;
const breakdown = {
  contract: Math.round(contract * 10) / 10,
  verify: Math.round(verify * 10) / 10,
  stress: Math.round(stress * 10) / 10,
  brand: Math.round(brand * 10) / 10,
  raw: { cViol, cWarn, vFail, vWarn, stFail, deckAvg, brandPass },
};

// persist keyed by slug
const scoresPath = path.join(WORKSPACE, 'template-scores.json');
let store = {};
try { store = JSON.parse(fs.readFileSync(scoresPath, 'utf8')); } catch {}
store[slug] = { score, breakdown };
fs.writeFileSync(scoresPath, JSON.stringify(store, null, 2) + '\n');

if (asJson) { console.log(JSON.stringify({ slug, score, breakdown }, null, 2)); }
else {
  console.log(`\n${slug} — ${score}/10`);
  console.log(`  contract ${breakdown.contract}/4  verify ${breakdown.verify}/3  stress ${breakdown.stress}/1.5  brand ${breakdown.brand}/1.5`);
  console.log(`  (${cViol} viol, ${cWarn} warn | ${vFail} fail ${vWarn} warn | ${stFail} stress-fail | brand ${brandPass ? 'PASS' : deckAvg + '%'})\n`);
}
