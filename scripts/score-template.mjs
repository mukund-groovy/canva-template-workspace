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
// verify-slides' summary line ("  0 fail, 1 warn — renders in ..."). Parse it as a UNIT:
// a bare /(\d+)\s+warn/ matched across newlines and captured the "184" of a preceding
// "stddev 0.184" photo-stats line, scoring a clean deck 0/3 on verify.
const tally = (s) => {
  const m = s.match(/(\d+)[ \t]+fail,[ \t]+(\d+)[ \t]+warn/i);
  return { fail: m ? Number(m[1]) : 0, warn: m ? Number(m[2]) : 0 };
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── contract (4.0): every violation is a real pipeline-breaking bug ──────────
const c = run(`node ${S}/check-template-contract.mjs "${file}"`);
const cViol = num(/(\d+)\s+violation/i, c.out);
const cWarn = num(/(\d+)\s+warning/i, c.out);
const contract = clamp(4 - cViol * 1.0 - cWarn * 0.15, 0, 4);

// ── verify-slides (3.0): render measurements ─────────────────────────────────
const v = run(`node ${S}/verify-slides.mjs "${file}"`);
const { fail: vFail, warn: vWarn } = tally(v.out);
const verify = clamp(3 - vFail * 1.0 - vWarn * 0.3, 0, 3);

// ── stress-slots (1.5): worst-case generated text ────────────────────────────
const st = run(`node ${S}/stress-slots.mjs "${file}"`);
const stFail = num(/(\d+)\s+failure/i, st.out);
const stress = clamp(1.5 - stFail * 0.5, 0, 1.5);

// ── brand-audit (1.5): recolor strength (deck avg % of pixels that move) ──────
const b = run(`node ${S}/brand-audit.mjs "${file}"`);
const deckAvg = num(/deck\s*avg\s+([\d.]+)%/i, b.out);
const brandPass = /RESULT:\s*PASS/i.test(b.out);
// brand-audit already gates PER SLIDE (a starved slide fails the deck) — honour its verdict.
// The old fallback was `clamp((deckAvg/3)*1.5, 0, 1.5)`, which saturates at 3% avg: a deck
// audited FAIL with 3 brand-DEAD slides still scored a full 1.5/1.5 because two strong slides
// lifted the average. A slide the brand can't tint means the template isn't brand-recolorable
// on that slide — that's the product, so there is no partial credit for it.
const starved = (b.out.match(/starved slides:\s*([\d, ]+)/i) || [])[1] || '';
let brand = brandPass ? 1.5 : 0;

// ── brand SAFETY: does the deck survive a real brand, not just the default palette?
// Re-run the render gate skinned with a hostile LIGHT accent and a hostile DARK accent.
// The classic failure is text hardcoded #fff on an accent fill: invisible on yellow.
// Recolouring "strongly" while going unreadable is not a pass, so any fail zeroes brand.
const bLight = run(`node ${S}/verify-slides.mjs "${file}" --brand "#C1502C,#FFE14D"`);
const bDark = run(`node ${S}/verify-slides.mjs "${file}" --brand "#0B3D2E,#1B2A4A"`);
const brandFail = tally(bLight.out).fail + tally(bDark.out).fail;
if (brandFail > 0) brand = 0;

const score = Math.round((contract + verify + stress + brand) * 10) / 10;
const breakdown = {
  contract: Math.round(contract * 10) / 10,
  verify: Math.round(verify * 10) / 10,
  stress: Math.round(stress * 10) / 10,
  brand: Math.round(brand * 10) / 10,
  raw: { cViol, cWarn, vFail, vWarn, stFail, deckAvg, brandPass, brandFail },
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
  console.log(`  (${cViol} viol, ${cWarn} warn | ${vFail} fail ${vWarn} warn | ${stFail} stress-fail | brand ${brandPass ? 'PASS' : deckAvg + '%'})`);
  if (!brandPass) {
    console.log(`  ⚠ brand zeroed: brand-audit FAIL${starved ? ` — slide(s) ${starved.trim()} are brand-DEAD` : ''}.`);
    console.log(`    Those slides do not change at all under a brand palette, so the template is`);
    console.log(`    not brand-recolorable there. Every slide needs a VISIBLE brand-bound device`);
    console.log(`    (scrim/caption panel, rule, numeral, lockup chip) — and never park an accent`);
    console.log(`    fill behind a full-bleed photo, where it can't be seen. Details:`);
    console.log(`    node scripts/brand-audit.mjs "${file}"`);
  }
  if (brandFail > 0) {
    console.log(`  ⚠ brand zeroed: ${brandFail} fail(s) when skinned with a real brand palette — run`);
    console.log(`    node scripts/verify-slides.mjs "${file}" --brand "#C1502C,#FFE14D"`);
    console.log(`    Text hardcoded over a brand fill? route it through var(--on-accent).`);
  }
  console.log('');
}
