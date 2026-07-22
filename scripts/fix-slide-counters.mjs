#!/usr/bin/env node
/**
 * fix-slide-counters.mjs — make baked page-counter denominators agree with the real slide count.
 *
 * content-gen's enforceUniversalCarouselTemplateContract HARD-REJECTS a template whose baked
 * counter denominator disagrees with its slide count ("Template has baked slide-count
 * denominator(s) [3] that disagree with the actual slide count (5)"). A deck whose counters were
 * written before slides were added is therefore unseedable — and our own gate never checked it.
 *
 * DETECTION IS COPIED VERBATIM from carouselTemplateContract.ts so this fixes exactly what they
 * reject and nothing else. Note their numerator must be ZERO-PADDED (`0\d+`) — that is deliberate,
 * to avoid matching prose like "Systems / 2025" or a semantic "Tip 1 of 5" (which counts tips, not
 * slides, and is legitimately allowed to differ from the slide count). A broader regex corrupts
 * those; this one leaves them alone.
 *
 * Only the DENOMINATOR is rewritten. Numerators are left as authored — content-gen's own
 * enforceCounterIntegrity normalises those at generation time, and rewriting them here would
 * fight that.
 *
 *   node scripts/fix-slide-counters.mjs --all [--dry]
 *   node scripts/fix-slide-counters.mjs <template.html>
 */
import fs from 'fs';
import path from 'path';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT = path.join(WORKSPACE, 'output');
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const DRY = argv.includes('--dry');
const target = argv.find((a) => !a.startsWith('--'));

// verbatim from carouselTemplateContract.ts
const SLIDE_CLASS_RE = /class\s*=\s*["'][^"']*\bslide(?=[\s"']|--)[^"']*["']/gi;
const BAKED_WHOLE_COUNTER_RE = />(0\d+)(\s*(?:\/|of|—|–)\s*)(\d{1,3})</gi;
const BAKED_SPLIT_TOTAL_RE = />\s*(?:\/|of|—|–)\s*0*(\d{1,3})\s*</gi;

function fixFile(file) {
  let html = fs.readFileSync(file, 'utf8');
  if (/class="si-page"/.test(html)) return { singleImage: true, changes: [] };

  const slideCount = (html.match(SLIDE_CLASS_RE) || []).length;
  if (slideCount < 2) return { tooFewSlides: true, slideCount, changes: [] };

  const changes = [];

  html = html.replace(BAKED_WHOLE_COUNTER_RE, (m, num, sep, den) => {
    if (Number(den) === slideCount) return m;
    const padded = den.length > 1 && den.startsWith('0')
      ? String(slideCount).padStart(den.length, '0')
      : String(slideCount);
    changes.push(`"${num}${sep}${den}" -> "${num}${sep}${padded}"`);
    return `>${num}${sep}${padded}<`;
  });

  html = html.replace(BAKED_SPLIT_TOTAL_RE, (m, den) => {
    if (Number(den) === slideCount) return m;
    const inner = m.slice(1, -1);
    const padded = /0\d/.test(inner) ? String(slideCount).padStart(2, '0') : String(slideCount);
    const next = inner.replace(/0*\d{1,3}\s*$/, padded);
    changes.push(`split total "${inner.trim()}" -> "${next.trim()}"`);
    return `>${next}<`;
  });

  if (changes.length && !DRY) fs.writeFileSync(file, html);
  return { slideCount, changes };
}

const files = ALL
  ? fs.readdirSync(OUTPUT).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => path.join(OUTPUT, f))
  : [path.resolve(target || '')];

let touched = 0, total = 0;
const invalid = [];
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`skip ${file}: not found`); continue; }
  const r = fixFile(file);
  if (r.singleImage) continue;
  if (r.tooFewSlides) { invalid.push(`${path.basename(file)} (${r.slideCount} slide)`); continue; }
  if (!r.changes.length) continue;
  touched++; total += r.changes.length;
  console.log(`${path.basename(file)} (${r.slideCount} slides):`);
  for (const c of r.changes) console.log(`  ${c}`);
}
console.log(`\n${touched} template(s), ${total} denominator(s) corrected.${DRY ? ' (--dry)' : ''}`);
if (invalid.length) {
  console.log(`\nSTRUCTURALLY INVALID as carousels (need >=2 slides — content-gen's parser rejects these):`);
  for (const s of invalid) console.log(`  ${s}`);
}
