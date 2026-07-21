#!/usr/bin/env node
/**
 * externalize-images.mjs — B2: move baked base64 photos out of the template HTML into real
 * files on disk, and point the <img src> at a relative path instead.
 *
 *   output/assets/images/<template-slug>/<name>.png
 *   <img data-image="true" src="assets/images/<template-slug>/slide-03.png" ...>
 *
 * WHY: a baked `data:image/png;base64,…` photo made some templates 16-21 MB (345 MB across
 * output/). content-gen stores template HTML in a Postgres `html_content @db.Text` column —
 * which accepts it — but its own HTTP create/update path caps at 10 MB (express.json), so an
 * inlined template can be seeded yet never edited through the admin API. Its own 40 seeded
 * templates carry zero base64: every content photo is a plain URL. This aligns us with that.
 *
 * Naming is DERIVED, not arbitrary: a photo is named for the slide it lives on (`slide-03.png`),
 * since the contract already allows at most one content photo per slide — so the slide number
 * is both unique and meaningful. Single-image templates get `page-01.png`. A photo that sits
 * outside any slide (shouldn't happen) falls back to `slot-NN.png`.
 *
 * Brand-logo <img data-brand-logo> images are deliberately LEFT INLINE: they are a few hundred
 * bytes of URL-encoded SVG (not base64), and content-gen swaps them for the real brand logo at
 * generation time anyway.
 *
 *   node scripts/externalize-images.mjs --all          # every output/*.html
 *   node scripts/externalize-images.mjs <template.html>
 *   node scripts/externalize-images.mjs --all --dry    # report only, write nothing
 */
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT = path.join(WORKSPACE, 'output');
const ASSETS_REL = 'assets/images'; // relative to output/, so the src resolves as-is in a browser

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const DRY = argv.includes('--dry');
const target = argv.find((a) => !a.startsWith('--'));

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function externalize(file) {
  const slug = path.basename(file).replace(/\.html?$/i, '');
  let html = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(html, { xmlMode: false, decodeEntities: false });

  // Index the slides/pages once so each photo can be named for the unit it sits on.
  const slides = $('.slide').toArray();
  const siPages = $('.si-page').toArray();

  const jobs = [];
  let slotFallback = 0;

  $('img').each((_i, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    const m = src.match(/^data:(image\/[a-z+]+);base64,/i);
    if (!m) return; // not a baked raster (brand-logo SVG data-URIs are not base64 — left alone)
    const mime = m[1].toLowerCase();
    const ext = EXT_BY_MIME[mime] || 'png';

    // Name from the slide/page this photo belongs to — meaningful and unique, since the
    // contract permits at most one content photo per slide.
    let name;
    const slideEl = $img.closest('.slide').get(0);
    const pageEl = $img.closest('.si-page').get(0);
    if (slideEl) {
      const idx = slides.indexOf(slideEl);
      name = `slide-${String(idx + 1).padStart(2, '0')}`;
    } else if (pageEl) {
      const idx = siPages.indexOf(pageEl);
      name = `page-${String(idx + 1).padStart(2, '0')}`;
    } else {
      name = `slot-${String(++slotFallback).padStart(2, '0')}`;
    }

    jobs.push({ src, mime, ext, name });
  });

  if (!jobs.length) return null;

  // Two photos on the same slide would collide on name — disambiguate with a -b/-c suffix
  // rather than silently overwriting one with the other.
  const seen = new Map();
  for (const j of jobs) {
    const n = (seen.get(j.name) || 0) + 1;
    seen.set(j.name, n);
    j.file = n === 1 ? `${j.name}.${j.ext}` : `${j.name}-${String.fromCharCode(96 + n)}.${j.ext}`;
  }

  const dir = path.join(OUTPUT, 'assets', 'images', slug);
  let bytesOut = 0;
  const beforeSize = Buffer.byteLength(html, 'utf8');

  if (!DRY) fs.mkdirSync(dir, { recursive: true });

  for (const j of jobs) {
    const b64 = j.src.slice(j.src.indexOf(';base64,') + 8);
    const buf = Buffer.from(b64, 'base64');
    bytesOut += buf.length;
    if (!DRY) fs.writeFileSync(path.join(dir, j.file), buf);
    // Exact string replace of the full data-URI — safer than re-serializing the whole document
    // through cheerio (a data URI is long and unique, so this can't collide with anything else).
    html = html.split(j.src).join(`${ASSETS_REL}/${slug}/${j.file}`);
  }

  if (!DRY) fs.writeFileSync(file, html);
  const afterSize = Buffer.byteLength(html, 'utf8');

  return { slug, count: jobs.length, files: jobs.map((j) => j.file), beforeSize, afterSize, bytesOut };
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function main() {
  const files = ALL
    ? fs.readdirSync(OUTPUT).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => path.join(OUTPUT, f))
    : [path.resolve(target || '')];

  let touched = 0, totalBefore = 0, totalAfter = 0, totalImgs = 0, totalPng = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.log(`skip ${file}: not found`); continue; }
    const r = externalize(file);
    if (!r) continue;
    touched++; totalImgs += r.count; totalBefore += r.beforeSize; totalAfter += r.afterSize; totalPng += r.bytesOut;
    console.log(`${r.slug}: ${r.count} image(s) -> assets/images/${r.slug}/  [${mb(r.beforeSize)} -> ${kb(r.afterSize)}]`);
    console.log(`  ${r.files.join(', ')}`);
  }
  console.log(`\n${touched} template(s), ${totalImgs} image(s) externalized.`);
  console.log(`HTML: ${mb(totalBefore)} -> ${mb(totalAfter)}   (PNG files on disk: ${mb(totalPng)})`);
  if (DRY) console.log('--dry: nothing written.');
}
main();
