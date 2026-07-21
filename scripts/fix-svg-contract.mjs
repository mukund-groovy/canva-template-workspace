#!/usr/bin/env node
/**
 * fix-svg-contract.mjs — backfill B7: rewrite every output template's SVG decoration to
 * content-gen's REAL paint contract (fill="var(--cg-fill)" / stroke="var(--cg-stroke)",
 * declared on the outer <svg> as an existing ecosystem token — never currentColor, never a
 * literal hex/rgb/hsl, never inline style on an inner node, never an SVG <filter>).
 *
 * See CONTENT_GEN_INTEGRATION_PLAN.md B7 for the full audit this fixes.
 *
 *   node scripts/fix-svg-contract.mjs <template.html>   # one file
 *   node scripts/fix-svg-contract.mjs --all             # every output/*.html
 */
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const target = argv.find((a) => !a.startsWith('--'));

const ROOT_TOKENS = ['--primary', '--secondary', '--accent', '--bg', '--surface', '--text-high', '--text-low', '--border', '--highlight'];
const LITERAL_COLOR_RE = /^\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))\s*$/;

function extractTokenFallbacks(html) {
  // { '#rrggbb' or 'rgba(...)' (normalized, lowercase, no space) -> '--token' }
  const map = new Map();
  for (const tok of ROOT_TOKENS) {
    const m = html.match(new RegExp(`${tok}\\s*:\\s*var\\([^,]+,\\s*([^)]+)\\)`));
    if (m) map.set(m[1].trim().toLowerCase().replace(/\s+/g, ''), tok);
  }
  return map;
}

function resolveAncestorColor($, node, $root) {
  // Walk up from node past the root <svg> (which rarely carries its own class — the CSS rule
  // that actually feeds currentColor is almost always on a WRAPPING div, e.g. ".scribble svg
  // {color:var(--primary)}") all the way to body/html. A previous version stopped exactly at
  // the root svg itself and so never found rules scoped to its own wrapper — the #1 real bug
  // this script hit on its first test run (a purple accent ellipse silently became grey).
  const styleText = $('style').text();
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 20) {
    const $cur = $(cur);
    const cls = ($cur.attr('class') || '').trim().split(/\s+/).filter(Boolean);
    for (const c of cls) {
      const re = new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+svg)?\\s*\\{[^}]*?\\bcolor\\s*:\\s*(var\\(--[a-z-]+[^;)]*\\)|#[0-9a-fA-F]{3,8})`, 'i');
      const m = styleText.match(re);
      if (m) return m[1];
    }
    const next = $cur.parent().get(0);
    if (!next || next.tagName === 'body' || next.tagName === 'html') break;
    cur = next;
  }
  return null;
}

function fixFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(html, { xmlMode: false, decodeEntities: false });
  const fallbacks = extractTokenFallbacks(html);
  const notes = [];

  // cheerio's find('tagName') CSS-selector matching is unreliable for SVG filter-primitive tags
  // (feTurbulence/feGaussianBlur) even though the real DOM tagName is preserved correctly —
  // confirmed directly: el.tagName reads back exactly "feGaussianBlur", but $f.find('feGaussianBlur')
  // (or its lowercase form) matches nothing. Walk children and compare tagName.toLowerCase() instead.
  const childByTag = ($el, tag) => $el.find('*').filter((_i, n) => n.tagName && n.tagName.toLowerCase() === tag);

  // ── 1. Remove grain/noise <filter> (feTurbulence) — no compliant equivalent, drop the layer.
  $('filter').each((_i, f) => {
    const $f = $(f);
    if (!childByTag($f, 'feturbulence').length) return;
    const id = $f.attr('id');
    if (!id) return;
    const refRe = new RegExp(`url\\((#|%23)${id}\\)`);
    $('[filter]').each((_j, el) => {
      if (refRe.test($(el).attr('filter') || '')) { $(el).remove(); notes.push(`removed grain-noise element referencing #${id}`); }
    });
    $f.remove();
    notes.push(`removed <filter id="${id}"> (feTurbulence grain — no compliant CSS equivalent)`);
  });

  // ── 2. Convert feGaussianBlur <filter> to CSS filter:blur(Npx) on the outer <svg>, when the
  // filtered element's own root svg has exactly one filtered node (safe to hoist the blur up).
  $('filter').each((_i, f) => {
    const $f = $(f);
    const feBlur = childByTag($f, 'fegaussianblur');
    if (!feBlur.length || childByTag($f, 'feturbulence').length) return;
    const id = $f.attr('id');
    const stdDevAttr = feBlur.get(0).attribs && (feBlur.get(0).attribs.stdDeviation ?? feBlur.get(0).attribs.stddeviation);
    const stdDev = Math.round(parseFloat(stdDevAttr ?? '10'));
    if (!id) return;
    const refRe = new RegExp(`url\\((#|%23)${id}\\)`);
    const filtered = $('[filter]').filter((_j, el) => refRe.test($(el).attr('filter') || ''));
    if (filtered.length !== 1) { notes.push(`SKIPPED <filter id="${id}"> — ${filtered.length} elements reference it, ambiguous hoist target (manual review needed)`); return; }
    const el = filtered.get(0);
    const $el = $(el);
    let $root = $el.closest('svg');
    if (!$root.length) { notes.push(`SKIPPED <filter id="${id}"> — no ancestor <svg> found`); return; }
    // Walk up to the ROOT svg (not a nested one), since style is only legal there.
    while ($root.parent().closest('svg').length) $root = $root.parent().closest('svg');
    const otherFilterUsers = $root.find('[filter]').filter((_j, e2) => e2 !== el).length;
    if (otherFilterUsers > 0) { notes.push(`SKIPPED <filter id="${id}"> — sibling filtered elements share its root svg, ambiguous hoist (manual review needed)`); return; }
    const prevStyle = ($root.attr('style') || '').replace(/;\s*$/, '');
    $root.attr('style', (prevStyle ? prevStyle + ';' : '') + `filter:blur(${stdDev}px)`);
    $el.removeAttr('filter');
    $f.remove();
    notes.push(`hoisted <filter id="${id}"> (feGaussianBlur ${stdDev}) to CSS filter:blur(${stdDev}px) on its root <svg>`);
  });

  // Anything left over (unhandled shapes) — flag, don't guess.
  $('filter').each((_i, f) => notes.push(`SKIPPED <filter id="${$(f).attr('id') || '(anon)'}"> — unrecognized shape, manual review needed`));

  // ── 3. Per root <svg>: a11y attrs + paint contract.
  $('svg').each((_i, root) => {
    const $root = $(root);
    if ($root.parents('svg').length) return; // only true roots
    if ($root.attr('data-cg-svg') === undefined) return; // not a decor svg we own (shouldn't happen post-C10, but be safe)

    $root.attr('aria-hidden', 'true');
    $root.attr('focusable', 'false');

    let resolvedFill = null, resolvedStroke = null;
    // A literal hex captured off an inline style= must go through the SAME token-fallback
    // mapping as a bare fill/stroke attribute — never kept as a raw literal (that was the #2
    // real bug this script hit: kitchen-herb-garden and 19 others ended up with a literal
    // --cg-fill:#000 because this path bypassed the fallback lookup entirely).
    const toToken = (v) => {
      if (/^var\(--(?!brand-)/i.test(v)) return v;
      const norm = v.trim().toLowerCase().replace(/\s+/g, '');
      const tok = fallbacks.get(norm);
      return tok ? `var(${tok})` : 'var(--text-high)';
    };

    const inner = $root.find('*').filter((_j, n) => n.tagName !== 'svg');
    inner.each((_j, node) => {
      const $n = $(node);
      const styleAttr = $n.attr('style');
      if (styleAttr) {
        const mFill = styleAttr.match(/fill\s*:\s*(var\([^)]+\)|#[0-9a-fA-F]{3,8})/);
        const mStroke = styleAttr.match(/stroke\s*:\s*(var\([^)]+\)|#[0-9a-fA-F]{3,8})/);
        const mColor = styleAttr.match(/color\s*:\s*(var\([^)]+\)|#[0-9a-fA-F]{3,8})/);
        if (mFill) resolvedFill = resolvedFill || toToken(mFill[1]);
        if (mStroke) resolvedStroke = resolvedStroke || toToken(mStroke[1]);
        if (mColor) { const t = toToken(mColor[1]); resolvedFill = resolvedFill || t; resolvedStroke = resolvedStroke || t; }
        $n.removeAttr('style');
      }
    });

    inner.each((_j, node) => {
      const $n = $(node);
      for (const [attr, get, set] of [['fill', () => resolvedFill, (v) => { resolvedFill = v; }], ['stroke', () => resolvedStroke, (v) => { resolvedStroke = v; }]]) {
        const val = $n.attr(attr);
        if (val === undefined || val === 'none') continue;
        if (/currentColor/i.test(val)) {
          if (!get()) {
            const anc = resolveAncestorColor($, node, $root);
            set(anc || 'var(--text-high)');
          }
        } else if (LITERAL_COLOR_RE.test(val)) {
          const norm = val.trim().toLowerCase().replace(/\s+/g, '');
          const tok = fallbacks.get(norm);
          if (!get()) set(tok ? `var(${tok})` : 'var(--text-high)');
        } else if (/^var\(--(?!brand-)/i.test(val)) {
          if (!get()) set(val); // already an ecosystem token — keep it as the resolved role value
        }
      }
    });

    if (!resolvedFill && !resolvedStroke) return; // no colored geometry inside — nothing to declare
    resolvedFill = resolvedFill || resolvedStroke;
    resolvedStroke = resolvedStroke || resolvedFill;

    const prevStyle = ($root.attr('style') || '').replace(/;\s*$/, '');
    const cgVars = `--cg-fill:${resolvedFill};--cg-stroke:${resolvedStroke}`;
    $root.attr('style', (prevStyle ? prevStyle + ';' : '') + cgVars);

    inner.each((_j, node) => {
      const $n = $(node);
      const f = $n.attr('fill');
      if (f !== undefined && f !== 'none') $n.attr('fill', 'var(--cg-fill)');
      const s = $n.attr('stroke');
      if (s !== undefined && s !== 'none') $n.attr('stroke', 'var(--cg-stroke)');
    });
  });

  const out = $.html();
  fs.writeFileSync(file, out);
  return notes;
}

function main() {
  const files = ALL
    ? fs.readdirSync(path.join(WORKSPACE, 'output')).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => path.join(WORKSPACE, 'output', f))
    : [path.resolve(target)];
  let touched = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.log(`skip ${file}: not found`); continue; }
    const html = fs.readFileSync(file, 'utf8');
    if (!/<svg/i.test(html)) continue; // nothing to do
    const notes = fixFile(file);
    touched++;
    console.log(`${path.basename(file)}:`);
    for (const n of notes) console.log(`  ${n}`);
    if (!notes.length) console.log('  (a11y + paint attrs normalized, no filter/blur changes needed)');
  }
  console.log(`\n${touched} file(s) processed.`);
}
main();
