#!/usr/bin/env node
/**
 * publish-images.mjs — upload template photos to Azure Blob and emit seed-ready HTML that
 * points at the hosted URLs instead of local relative paths.
 *
 * Templates ship with photos as FILES beside them, referenced relatively:
 *   output/<slug>.html                       <img src="assets/images/<slug>/slide-03.png">
 *   output/assets/images/<slug>/slide-03.png
 *
 * content-gen needs those photos on a URL. This uploads them and writes a PARALLEL copy of
 * each template with the src rewritten — output/ is never mutated, so the workspace stays
 * renderable offline and this script stays re-runnable.
 *
 *   output/.seed/<slug>.html                 <img src="https://…/social-templates/<slug>/slide-03.png">
 *
 * REMOTE LAYOUT — uploads go under the UPLOAD_DIR prefix, NOT the container root: the
 * container is shared with other services (it already carries an `assets/` prefix in active
 * use plus many UUID-named blobs), so mirroring our local `assets/images/…` path verbatim
 * would drop our files into someone else's space.
 *
 *   <container>/social-templates/<slug>/slide-03.png
 *
 * Auth is SharedKey (HMAC-SHA256) over the REST API — no SDK dependency, matching this repo's
 * "deps are just playwright + cheerio" constraint.
 *
 *   node scripts/publish-images.mjs --probe        # verify write access, one tiny blob, then delete it
 *   node scripts/publish-images.mjs --dry          # report what WOULD upload/rewrite, touch nothing
 *   node scripts/publish-images.mjs --all          # upload every image + emit every seed HTML
 *   node scripts/publish-images.mjs --slug <slug>  # just one template
 *   node scripts/publish-images.mjs --all --force  # re-upload even if the blob already exists
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const OUTPUT = path.join(WORKSPACE, 'output');
const SEED_DIR = path.join(OUTPUT, '.seed');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const DRY = argv.includes('--dry');
const PROBE = argv.includes('--probe');
const FORCE = argv.includes('--force');
const ONE = (() => { const i = argv.indexOf('--slug'); return i >= 0 ? argv[i + 1] : null; })();

// ── env ───────────────────────────────────────────────────────────────────────
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(WORKSPACE, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return { ...out, ...process.env };
}
const env = loadEnv();
const ACCOUNT = env.AZURE_STORAGE_ACCOUNT_NAME;
const KEY = env.AZURE_STORAGE_ACCESS_KEY;
const CONTAINER = env.AZURE_STORAGE_CONTAINER;
const PUBLIC_BASE = (env.AZURE_STORAGE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
// UPLOAD_DIR is written like a local path ("./social-templates"); normalize to a blob prefix.
const PREFIX = String(env.UPLOAD_DIR || 'social-templates').replace(/^\.?\//, '').replace(/\/$/, '');
const API_VERSION = '2021-08-06';

if (!ACCOUNT || !KEY || !CONTAINER || !PUBLIC_BASE) {
  console.error('missing storage config — need AZURE_STORAGE_ACCOUNT_NAME / _ACCESS_KEY / _CONTAINER / _PUBLIC_BASE_URL in .env');
  process.exit(1);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// ── SharedKey signing ─────────────────────────────────────────────────────────
// StringToSign layout is positional and unforgiving: VERB, Content-Encoding, Content-Language,
// Content-Length, Content-MD5, Content-Type, Date, If-*, Range, then canonicalized x-ms-*
// headers and the canonicalized resource. An empty Content-Length must be '' (not '0') on
// this API version, or every request 403s with a signature mismatch.
function signedHeaders({ method, blobPath, query = {}, extraHeaders = {}, contentLength = '', contentType = '' }) {
  const h = {
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': API_VERSION,
    ...extraHeaders,
  };
  const canonHeaders = Object.keys(h)
    .filter((k) => k.toLowerCase().startsWith('x-ms-'))
    .map((k) => [k.toLowerCase(), String(h[k]).trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}:${v}`)
    .join('\n');
  const resource = `/${ACCOUNT}/${CONTAINER}${blobPath ? '/' + blobPath : ''}`;
  const canonQuery = Object.keys(query).sort().map((k) => `${k.toLowerCase()}:${query[k]}`).join('\n');
  const stringToSign = [
    method, '', '', String(contentLength), '', contentType, '', '', '', '', '', '',
    canonHeaders, canonQuery ? `${resource}\n${canonQuery}` : resource,
  ].join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(stringToSign, 'utf8').digest('base64');
  return { ...h, Authorization: `SharedKey ${ACCOUNT}:${sig}` };
}

const blobUrl = (blobPath, query = {}) => {
  const q = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${blobPath}${q ? '?' + q : ''}`;
};

const md5b64 = (buf) => crypto.createHash('md5').update(buf).digest('base64');

/** { exists, md5, size } — md5 is null for blobs uploaded without a recorded Content-MD5. */
async function blobStatus(blobPath) {
  const headers = signedHeaders({ method: 'HEAD', blobPath });
  const r = await fetch(blobUrl(blobPath), { method: 'HEAD', headers });
  if (r.status !== 200) return { exists: false, md5: null, size: null };
  return {
    exists: true,
    md5: r.headers.get('content-md5'),
    size: Number(r.headers.get('content-length') || 0),
  };
}

/**
 * Decide whether a local file needs uploading. Existence alone is NOT enough: image filenames
 * are deterministic (slide-01.png), so a REGENERATED photo reuses its name — skipping on
 * existence would leave the stale image hosted forever while the local one silently diverges.
 *
 * Compare content instead: Content-MD5 when the blob has one, else byte length. Blobs uploaded
 * before this check existed carry no MD5, so they fall back to a size comparison rather than
 * forcing a full re-upload of everything.
 */
async function needsUpload(blobPath, buf) {
  const st = await blobStatus(blobPath);
  if (!st.exists) return { upload: true, why: 'new' };
  if (st.md5) return st.md5 === md5b64(buf) ? { upload: false, why: 'identical (md5)' } : { upload: true, why: 'changed (md5)' };
  if (st.size !== buf.length) return { upload: true, why: `changed (size ${st.size} -> ${buf.length})` };
  return { upload: false, why: 'same size, no md5 recorded' };
}

async function putBlob(blobPath, buf, contentType) {
  const contentMD5 = md5b64(buf);
  const headers = signedHeaders({
    method: 'PUT',
    blobPath,
    contentLength: buf.length,
    contentType,
    // Recording the hash on the blob is what makes future runs able to detect a CHANGED image
    // rather than just a missing one.
    extraHeaders: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-md5': contentMD5 },
  });
  headers['Content-Type'] = contentType;
  headers['Content-Length'] = String(buf.length);
  const r = await fetch(blobUrl(blobPath), { method: 'PUT', headers, body: buf });
  if (r.status !== 201) throw new Error(`PUT ${blobPath} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function deleteBlob(blobPath) {
  const headers = signedHeaders({ method: 'DELETE', blobPath });
  const r = await fetch(blobUrl(blobPath), { method: 'DELETE', headers });
  return r.status === 202;
}

// Transient-failure retry: a single dropped upload mid-run would otherwise leave the seed HTML
// pointing at a blob that isn't there.
async function withRetry(label, fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const wait = 1500 * 2 ** i;
      console.log(`    retry ${i + 1}/${attempts - 1} for ${label} in ${wait}ms (${String(e.message).slice(0, 60)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ── probe: prove write access without touching real data ──────────────────────
async function probe() {
  const p = `${PREFIX}/_probe/${Date.now()}-write-test.txt`;
  console.log(`probe blob: ${CONTAINER}/${p}`);
  await putBlob(p, Buffer.from('publish-images write probe', 'utf8'), 'text/plain');
  console.log('  PUT      : ok (201)');
  const pub = `${PUBLIC_BASE}/${p}`;
  const rd = await fetch(pub);
  console.log(`  public GET: HTTP ${rd.status}${rd.status === 200 ? ' — blobs are publicly readable' : ' — NOT publicly readable'}`);
  const del = await deleteBlob(p);
  console.log(`  DELETE   : ${del ? 'ok (202) — probe cleaned up' : 'FAILED (probe blob left behind)'}`);
  console.log('\nwrite access confirmed.');
}

// ── main publish ──────────────────────────────────────────────────────────────
function templatesToPublish() {
  const files = fs.readdirSync(OUTPUT).filter((f) => f.endsWith('.html') && !f.startsWith('_'));
  if (ONE) return files.filter((f) => f === `${ONE}.html`);
  return files;
}

async function publishOne(fileName) {
  const slug = fileName.replace(/\.html$/, '');
  const file = path.join(OUTPUT, fileName);
  let html = fs.readFileSync(file, 'utf8');
  const refs = [...new Set([...html.matchAll(/src="(assets\/images\/[^"]+)"/g)].map((m) => m[1]))];

  // A text-only template has nothing to upload, but it STILL gets a seed copy. Otherwise
  // output/.seed/ holds only the image-bearing templates and seeding means pulling some files
  // from .seed/ and the rest from output/ — an easy way to accidentally ship a template whose
  // photo srcs are still relative. .seed/ is the complete, unambiguous seed-ready set.
  if (!refs.length) {
    if (!DRY) {
      fs.mkdirSync(SEED_DIR, { recursive: true });
      fs.writeFileSync(path.join(SEED_DIR, fileName), html);
    }
    return { slug, images: 0, skipped: 0, uploaded: 0, seeded: true, textOnly: true };
  }

  let uploaded = 0, skipped = 0;
  for (const rel of refs) {
    const localPath = path.join(OUTPUT, rel);
    if (!fs.existsSync(localPath)) throw new Error(`${slug}: referenced image missing on disk: ${rel}`);
    // assets/images/<slug>/<name> -> <PREFIX>/<slug>/<name>
    const tail = rel.replace(/^assets\/images\//, '');
    const blobPath = `${PREFIX}/${tail}`;
    const ext = path.extname(localPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    if (!DRY) {
      const buf = fs.readFileSync(localPath);
      const decision = FORCE
        ? { upload: true, why: '--force' }
        : await withRetry(`HEAD ${blobPath}`, () => needsUpload(blobPath, buf));
      if (decision.upload) {
        await withRetry(`PUT ${blobPath}`, () => putBlob(blobPath, buf, contentType));
        uploaded++;
        if (decision.why.startsWith('changed')) console.log(`    re-uploaded ${tail} — ${decision.why}`);
      } else {
        skipped++;
      }
    }
    html = html.split(`src="${rel}"`).join(`src="${PUBLIC_BASE}/${blobPath}"`);
  }

  if (!DRY) {
    fs.mkdirSync(SEED_DIR, { recursive: true });
    fs.writeFileSync(path.join(SEED_DIR, fileName), html);
  }
  return { slug, images: refs.length, uploaded, skipped, seeded: true };
}

async function main() {
  console.log(`account   : ${ACCOUNT}`);
  console.log(`container : ${CONTAINER}`);
  console.log(`prefix    : ${PREFIX}/`);
  console.log(`public    : ${PUBLIC_BASE}/${PREFIX}/…\n`);

  if (PROBE) return probe();
  if (!ALL && !ONE) {
    console.error('usage: publish-images.mjs --probe | --all [--dry] [--force] | --slug <slug>');
    process.exit(1);
  }

  const files = templatesToPublish();
  if (!files.length) { console.log('no matching template.'); return; }

  let tImgs = 0, tUp = 0, tSkip = 0, tSeed = 0, withImages = 0, textOnly = 0;
  for (const f of files) {
    const r = await publishOne(f);
    if (r.seeded) tSeed++;
    if (!r.images) { textOnly++; continue; } // text-only: seeded, nothing to upload, not worth a line
    withImages++; tImgs += r.images; tUp += r.uploaded; tSkip += r.skipped;
    console.log(`${r.slug}: ${r.images} image(s)` + (DRY ? '' : ` — ${r.uploaded} uploaded, ${r.skipped} already present`));
  }
  console.log(`\n${withImages} template(s) with images (${tImgs} image ref(s)), ${textOnly} text-only.`);
  if (DRY) { console.log(`--dry: nothing uploaded; ${tSeed} seed HTML file(s) would be written.`); return; }
  console.log(`uploaded ${tUp}, skipped ${tSkip} (already in blob storage).`);
  console.log(`seed-ready HTML -> ${SEED_DIR} (${tSeed} file(s) — the COMPLETE set, seed from here)`);
  console.log(`\noutput/*.html is UNCHANGED (still relative paths, still renders offline).`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
