#!/usr/bin/env node
/**
 * fix-token-derivation.mjs — repair B1-class violations: a required ecosystem token that does
 * not derive from the --brand-* variable content-gen's validator expects.
 *
 * content-gen's validateColorTokens.ts (checkBrandDerivation) does not just check the 9 tokens
 * EXIST — it checks each one derives from its mapped --brand-* var. A token wired to a var the
 * brand skin never injects (e.g. --brand-highlight, --brand-text-low) silently never re-brands:
 * it always renders its hardcoded fallback, whatever palette is applied.
 *
 * This rewrites each required token to `var(<correct-brand-var>, <its existing fallback>)`,
 * preserving the literal fallback exactly — so nothing changes visually, the token just becomes
 * brand-swappable.
 *
 *   node scripts/fix-token-derivation.mjs --all
 *   node scripts/fix-token-derivation.mjs <template.html>
 *   node scripts/fix-token-derivation.mjs --all --dry
 */
import fs from 'fs';
import path from 'path';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT = path.join(WORKSPACE, 'output');
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const DRY = argv.includes('--dry');
const target = argv.find((a) => !a.startsWith('--'));

// Copied from validateColorTokens.ts's TOKEN_BRAND_MAP. First entry is what we WRITE; any entry
// is ACCEPTED (so a template already using --brand-text for --text-high is left alone).
const MAP = {
  '--primary': ['--brand-primary'],
  '--secondary': ['--brand-secondary'],
  '--accent': ['--brand-accent'],
  '--bg': ['--brand-bg'],
  '--surface': ['--brand-surface', '--brand-bg-alt'],
  '--text-high': ['--brand-ink', '--brand-text'],
  '--text-low': ['--brand-text-muted'],
  '--border': ['--brand-border'],
  '--highlight': ['--brand-accent'],
};

/** Innermost literal fallback of a possibly-nested var() chain, or the value itself if plain. */
function innermostFallback(value) {
  let v = value.trim();
  // var(--x, var(--y, #fff)) -> #fff ; var(--x, #fff) -> #fff ; #fff -> #fff
  for (let guard = 0; guard < 8; guard++) {
    const m = v.match(/^var\(\s*--[a-z0-9-]+\s*,\s*([\s\S]+)\)\s*$/i);
    if (!m) break;
    v = m[1].trim();
  }
  return v;
}

function fixFile(file) {
  let html = fs.readFileSync(file, 'utf8');
  const notes = [];

  for (const [token, accepted] of Object.entries(MAP)) {
    // Match this token's declaration inside a :root/.ig-carousel block (first occurrence wins —
    // that is the one the validator reads).
    const re = new RegExp(`(${token}\\s*:\\s*)([^;]+)(;)`);
    const m = html.match(re);
    if (!m) continue;
    const value = m[2].trim();
    if (accepted.some((b) => value.includes(`var(${b}`))) continue; // already correct

    const fallback = innermostFallback(value);
    const want = `var(${accepted[0]},${fallback})`;
    html = html.replace(re, `$1${want}$3`);
    notes.push(`${token}: ${value}  ->  ${want}`);
  }

  if (notes.length && !DRY) fs.writeFileSync(file, html);
  return notes;
}

function main() {
  const files = ALL
    ? fs.readdirSync(OUTPUT).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => path.join(OUTPUT, f))
    : [path.resolve(target || '')];
  let touched = 0, total = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.log(`skip ${file}: not found`); continue; }
    const notes = fixFile(file);
    if (!notes.length) continue;
    touched++; total += notes.length;
    console.log(`${path.basename(file)}:`);
    for (const n of notes) console.log(`  ${n}`);
  }
  console.log(`\n${touched} template(s), ${total} token(s) repaired.${DRY ? ' (--dry: nothing written)' : ''}`);
}
main();
