/**
 * decode-geometry.mjs — decode Canva's obfuscated template-data.json into an exact,
 * per-slide layout spec: every element's position (x/y), size (w/h), role, and — for text —
 * its verbatim copy, font-size, font-family, and alignment. This is the AUTHORITATIVE layout
 * the author reproduces, so it places elements by exact coordinates instead of eyeballing a
 * flat screenshot (which caused oversized type + overlap on faithful reproduction).
 *
 * Canva schema (decoded empirically):
 *   docSize: { A: 1080, B: 1350 }                       canvas size (element coords live here)
 *   page:    { 'A?':'i', D:{ C:'#ffffff' }, E:[ ... ] } D.C = page background hex, E = elements
 *   element: { 'A?':code, A:x, B:y, D:width, C:height, N:role, _:id, a:payload }
 *     code:  K=text  I=image/fill  J=shape  H=group
 *   text payload a: { A:[{ 'A?':'A', A:'the text' } ...],           <- text runs (concat)
 *                     B:[{ 'A?':'A', A:{ 'font-size':{B:'174.8'},   <- style runs
 *                                        'font-family':{B:'<id>,0'},
 *                                        'text-align':{B:'justify'},
 *                                        'tracking':{B:'-51'} } } ] }
 *   fonts:   [{ A:'<id>', C:'Times New Roman MT Condensed', D:[styles] }]  <- id -> real name
 */
import fs from 'node:fs';

const TYPE = { K: 'text', I: 'image', J: 'shape', H: 'group' };

function fontMap(td) {
  const m = {};
  for (const f of td.fonts || []) if (f && f.A) m[f.A] = f.C || f.A;
  return m;
}

// Concatenate a text element's runs into its verbatim string.
function textOf(payload) {
  const runs = payload && Array.isArray(payload.A) ? payload.A : [];
  return runs.map((r) => (r && typeof r.A === 'string' ? r.A : '')).join('').replace(/\s+$/,'').trim();
}

// Pull the dominant style (font-size / family / align) from a text element's style runs.
function styleOf(payload, fonts) {
  const arr = payload && Array.isArray(payload.B) ? payload.B : [];
  for (const s of arr) {
    const st = s && s.A;
    if (st && typeof st === 'object' && (st['font-size'] || st['font-family'])) {
      const fsRaw = st['font-size'] && st['font-size'].B;
      const ffRaw = st['font-family'] && st['font-family'].B; // "<id>,0"
      const fid = ffRaw ? String(ffRaw).split(',')[0] : null;
      return {
        fontSize: fsRaw ? Math.round(Number(fsRaw)) : null,
        fontFamily: fid ? (fonts[fid] || fid) : null,
        align: (st['text-align'] && st['text-align'].B) || null,
      };
    }
  }
  return {};
}

/** Returns [{ page, bg, canvas:{w,h}, elements:[{type,role,x,y,w,h,text?,fontSize?,fontFamily?,align?}] }] */
export function decodeGeometry(td) {
  const W = (td.docSize && Number(td.docSize.A)) || 1080;
  const H = (td.docSize && Number(td.docSize.B)) || 1350;
  const OUTW = 1080, OUTH = 1350;
  const sx = OUTW / W, sy = OUTH / H; // element coords are already in docSize space; scale only if it differs
  const fonts = fontMap(td);
  return (td.pages || []).map((p, pi) => {
    const bg = (p.D && p.D.C) || '#ffffff';
    const elements = [];
    for (const e of p.E || []) {
      const type = TYPE[e['A?']] || 'other';
      const x = Math.round((Number(e.A) || 0) * sx);
      const y = Math.round((Number(e.B) || 0) * sy);
      const w = Math.round((Number(e.D) || 0) * sx);
      const h = Math.round((Number(e.C) || 0) * sy);
      const rec = { type, role: e.N || '', x, y, w, h };
      if (type === 'text') {
        rec.text = textOf(e.a);
        const st = styleOf(e.a, fonts);
        if (st.fontSize) rec.fontSize = Math.round(st.fontSize * sy);
        if (st.fontFamily) rec.fontFamily = st.fontFamily;
        if (st.align) rec.align = st.align;
      }
      elements.push(rec);
    }
    return { page: pi + 1, bg, canvas: { w: OUTW, h: OUTH }, elements };
  });
}

// Model-readable spec: one block per slide. Emits the RELIABLE fields — text, font-size,
// font-family, alignment, and box width x height — which are transform-invariant and fix the
// #1 faithful-repro bug (the author oversizing type it eyeballed off a screenshot). Absolute
// x/y is intentionally OMITTED: Canva nests elements in groups with translate/rotate the raw
// coords don't include, so exact positions are unreliable — the reference image governs placement.
export function formatGeometry(slides) {
  const CHROME = /^(next slide|swipe|tap|like|save|comment|share|follow)\b|^@/i;
  return slides.map((s) => {
    const head = `Slide ${s.page} — background ${s.bg}`;
    const lines = [];
    for (const e of s.elements) {
      if (e.type !== 'text') continue; // sizes/text are the reliable signal; devices come from the image
      if (!e.text || CHROME.test(e.text)) continue; // skip empty + nav/social chrome
      const font = [e.fontSize && `${e.fontSize}px`, e.fontFamily && `"${e.fontFamily}"`, e.align].filter(Boolean).join(' ');
      lines.push(`  [${e.role || 'text'}] ${font} · box ${e.w}x${e.h}px · "${e.text.replace(/\s+/g, ' ').slice(0, 140)}"`);
    }
    return `${head}\n${lines.join('\n') || '  (no text elements)'}`;
  }).join('\n\n');
}

// CLI: node scripts/decode-geometry.mjs <template-data.json>  (debug / verify)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('decode-geometry.mjs')) {
  const p = process.argv[2];
  if (p && fs.existsSync(p)) {
    const td = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(formatGeometry(decodeGeometry(td)));
  } else {
    console.error('usage: node scripts/decode-geometry.mjs <template-data.json>');
    process.exit(1);
  }
}
