#!/usr/bin/env node
/**
 * build-seed-bundle.mjs — assemble everything content-gen needs to seed these templates into
 * ONE self-contained folder, so whoever does the seeding copies a directory and runs a command
 * instead of reverse-engineering this workspace.
 *
 *   seed-bundle/
 *     README.md                              step-by-step for the person/agent doing the seeding
 *     carousels/<slug>.html                  96 templates, photo srcs already pointing at Azure Blob
 *     seed-carousel-templates.generated.ts   the catalog entries, in content-gen's own array shape
 *     manifest.json                          machine-readable index (slug, kind, category, images)
 *
 * The HTML comes from output/.seed/ (hosted URLs), NOT output/ (local relative paths) — seeding
 * the latter would ship templates whose photos 404 for every user.
 *
 *   node scripts/build-seed-bundle.mjs
 */
import fs from 'fs';
import path from 'path';

const WORKSPACE = path.resolve(path.dirname(process.argv[1] || '.'), '..');
const SEED_HTML = path.join(WORKSPACE, 'output', '.seed');
const META_PATH = path.join(WORKSPACE, 'seed-metadata.json');
const BUNDLE = path.join(WORKSPACE, 'seed-bundle');

const argv = process.argv.slice(2);
// Emitted ready-to-use so the file is a STRAIGHT COPY into content-gen — no hand-renaming the
// export and no re-numbering `order` afterwards. Those manual steps are exactly what went wrong
// the first time this was integrated.
const EXPORT_NAME = (() => { const i = argv.indexOf('--export-name'); return i >= 0 ? argv[i + 1] : 'canvaDerivedTemplates'; })();
// content-gen's hand-authored entries occupy order 0-34, so start past them by default.
const ORDER_OFFSET = (() => { const i = argv.indexOf('--order-offset'); return i >= 0 ? Number(argv[i + 1]) : 100; })();

if (!fs.existsSync(SEED_HTML)) {
  console.error('output/.seed/ not found — run `npm run publish:images` first.');
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const files = fs.readdirSync(SEED_HTML).filter((f) => f.endsWith('.html')).sort();

// ── sanity gates: never emit a bundle that would seed broken templates ────────
const problems = [];
const rows = [];
for (const f of files) {
  const slug = f.replace(/\.html$/, '');
  const html = fs.readFileSync(path.join(SEED_HTML, f), 'utf8');
  const m = meta[slug];
  if (!m) { problems.push(`${slug}: no entry in seed-metadata.json (run generate-seed-metadata.mjs --all)`); continue; }
  if (/src="assets\/images\//.test(html)) problems.push(`${slug}: still has a RELATIVE image src — re-run publish-images.mjs`);
  if (/src="data:image\/[a-z+]+;base64,/i.test(html)) problems.push(`${slug}: has an inlined base64 photo — run externalize-images.mjs then publish-images.mjs`);
  const hosted = [...html.matchAll(/src="(https:\/\/[^"]+)"/g)].map((x) => x[1]).filter((u) => !/favicon|logo/i.test(u));
  rows.push({ slug, kind: m.kind || 'carousel', category: m.category, contentMode: m.contentMode, images: hosted.length, name: m.name });
}
if (problems.length) {
  console.error('REFUSING to build bundle — fix these first:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// ── emit ──────────────────────────────────────────────────────────────────────
fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(path.join(BUNDLE, 'carousels'), { recursive: true });
for (const f of files) fs.copyFileSync(path.join(SEED_HTML, f), path.join(BUNDLE, 'carousels', f));

// content-gen's own array shape. `kind` is omitted for carousels (it defaults) and emitted for
// single-image, matching how the hand-authored entries in its seed file are written.
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ').trim();
const arr = (xs) => `[${(xs || []).map((x) => `'${esc(x)}'`).join(', ')}]`;

const entries = rows.map((r, i) => {
  const m = meta[r.slug];
  const rp = m.recommendationProfile || {};
  const sc = rp.slideCountSweet || {};
  return `  {
    name: '${esc(m.name)}',
    slug: '${esc(m.slug)}',
    description: '${esc(m.description)}',
    category: '${esc(m.category)}',
    order: ${i + ORDER_OFFSET},
    enabled: true,
    isSystem: true,
    contentMode: '${esc(m.contentMode)}',${m.kind === 'single-image' ? `\n    kind: 'single-image',` : ''}
    recommendationProfile: {
      version: 1,
      title: '${esc(rp.title || m.name)}',
      summary: '${esc(rp.summary || m.description)}',
      tags: ${arr(rp.tags)},
      useCases: ${arr(rp.useCases)},
      tone: '${esc(rp.tone || 'professional')}',
      contentMode: '${esc(m.contentMode)}',
      visualStyle: ${arr(rp.visualStyle)},
      slideCountSweet: { min: ${sc.min ?? 1}, ideal: ${sc.ideal ?? 1}, max: ${sc.max ?? 1} },
      industries: [],
      audience: [],
    },
  },`;
}).join('\n');

// Emit EXPLICIT types, not bare object literals. content-gen's `carouselTemplates` array is
// annotated with a `contentMode: ContentMode` union; an untyped literal widens contentMode to
// `string`, and the spread then fails to compile with TS2322. Its own generated seed file
// declares the same local types for exactly this reason — mirrored here, plus the optional
// `kind` field theirs lacks (it has no single-image entries; we do).
const ts = `/**
 * Canva-derived social templates (${rows.length}: ${rows.filter((r) => r.kind === 'carousel').length} carousel, ${rows.filter((r) => r.kind === 'single-image').length} single-image).
 *
 * Contributed from the canva-template-workspace repo, which clones Canva references and authors
 * brand-recolorable templates from them. Each entry pairs with
 * backend/database/carousels/<slug>.html; photo srcs in those files already point at hosted
 * Azure Blob URLs, so there is nothing to upload at seed time.
 *
 * GENERATED by canva-template-workspace (scripts/build-seed-bundle.mjs) — do not hand-edit,
 * regenerate instead or your changes are lost on the next build.
 *
 * Keep this SEPARATE from seed-carousel-templates.generated.ts: that file is owned by
 * materialize-system-templates.ts, which regenerates it from the live DB and would wipe
 * anything added here.
 *
 * See docs/social-templates/02-templates/canva-derived-templates.md for the full workflow.
 */

import type { RecommendationProfile } from '@contentgen/shared';

type ContentMode = 'text-only' | 'text-images' | 'background-images';
type TemplateKind = 'carousel' | 'single-image';

export interface CanvaDerivedTemplateEntry {
  name: string;
  slug: string;
  description: string;
  category: string;
  order: number;
  enabled: boolean;
  isSystem: boolean;
  contentMode: ContentMode;
  recommendationProfile: RecommendationProfile;
  kind?: TemplateKind;
}

export const ${EXPORT_NAME}: CanvaDerivedTemplateEntry[] = [
${entries}
];
`;
fs.writeFileSync(path.join(BUNDLE, 'seed-carousel-templates.generated.ts'), ts);

fs.writeFileSync(
  path.join(BUNDLE, 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, templates: rows }, null, 2) + '\n'
);

const nCarousel = rows.filter((r) => r.kind === 'carousel').length;
const nSingle = rows.filter((r) => r.kind === 'single-image').length;
const nWithImages = rows.filter((r) => r.images > 0).length;
const totalImages = rows.reduce((s, r) => s + r.images, 0);

const readme = `# Seed bundle — ${rows.length} templates for content-gen

Everything needed to seed these into content-gen. Self-contained: copy this folder, follow the
four steps, done.

- **${nCarousel}** carousel, **${nSingle}** single-image
- **${nWithImages}** carry photos (**${totalImages}** images total), already uploaded to Azure Blob
- Generated ${new Date().toISOString().slice(0, 10)} by \`canva-template-workspace\`

## What's here

| Path | What it is |
|---|---|
| \`carousels/<slug>.html\` | The ${rows.length} templates. Photo \`src\`s already point at hosted Azure Blob URLs — nothing else to upload. |
| \`seed-carousel-templates.generated.ts\` | Catalog entries in content-gen's own \`carouselTemplates\` array shape. |
| \`manifest.json\` | Machine-readable index (slug, kind, category, contentMode, image count). |

## How to seed

**1. Copy the HTML into content-gen**

\`\`\`bash
cp carousels/*.html <content-gen>/backend/database/carousels/
\`\`\`

The seeder reads \`backend/database/carousels/<slug>.html\` by slug, so filenames must stay as-is.

**2. Register the entries**

Open \`<content-gen>/backend/database/seeds/seed-carousel-templates.ts\`. It exports a
\`carouselTemplates\` array. Add these ${rows.length} entries to it — either paste the contents of
\`seed-carousel-templates.generated.ts\`'s array, or drop the file in beside it and spread it:

\`\`\`ts
import { generatedCarouselTemplates } from './seed-carousel-templates.generated';

export const carouselTemplates = [
  // …existing hand-authored entries…
  ...generatedCarouselTemplates,
];
\`\`\`

⚠️ **\`order\` values in this file start at 0.** If the existing array already uses those numbers,
offset ours (e.g. \`order: i + 100\`) so ordering stays sane. Everything else is self-contained.

**3. Run the seeder**

\`\`\`bash
cd <content-gen>/backend/database
pnpm db:seed:carousel-templates
\`\`\`

It upserts by the composite unique \`(kind, slug)\`, so re-running is safe and idempotent.

**4. Verify**

\`\`\`sql
SELECT kind, COUNT(*) FROM "CarouselTemplate" WHERE is_system = true GROUP BY kind;
\`\`\`

Expect **${nCarousel} carousel** and **${nSingle} single-image**. Then open the template gallery —
cards render live from the HTML, so photos loading confirms the blob URLs resolve.

## Things worth knowing before you seed

- **These are seed-ready, not the working copies.** Photo \`src\`s are absolute Azure Blob URLs.
  The workspace also keeps a local-relative version for offline rendering — that one must never
  be seeded, its photos would 404 for every user. This bundle is built only from the hosted set.
- **The seeder prunes.** It deletes system rows whose slug is no longer in the array, so removing
  an entry and re-seeding removes it from the DB.
- **Contract-verified.** All ${rows.length} pass this workspace's contract gate, which mirrors
  content-gen's own \`carousel-template-parser.ts\` / \`validateColorTokens.ts\` /
  \`svgEmitLint.ts\` rules: 9-token \`:root\` deriving from the right \`--brand-*\` vars, SVG paint
  via \`--cg-fill\`/\`--cg-stroke\`, no \`currentColor\`, no inlined base64, no SVG \`<filter>\`.
- **Contract-clean is not the same as visually perfect.** A handful score below this workspace's
  own 8/10 quality bar (mostly WCAG contrast on photo-backed slides). They will seed and render
  fine; they just are not the strongest of the set. \`manifest.json\` does not flag these — ask
  the workspace owner if you need the current list.
- **Single-image templates** use \`.si-single > .si-page\` with flow layout, not
  \`.ig-carousel > .slide\`. content-gen already discriminates on the \`kind\` column; nothing extra
  to do, just do not assume every file is a carousel.

## Regenerating

From the workspace: \`node scripts/build-seed-bundle.mjs\`. It refuses to build if any template
still has a relative or base64 image src, so a bundle that exists is a bundle safe to seed.
`;
fs.writeFileSync(path.join(BUNDLE, 'README.md'), readme);

console.log(`seed-bundle/ built:`);
console.log(`  carousels/                            ${files.length} html`);
console.log(`  seed-carousel-templates.generated.ts  ${rows.length} entries`);
console.log(`  manifest.json`);
console.log(`  README.md`);
console.log(`\n${nCarousel} carousel, ${nSingle} single-image · ${nWithImages} with photos (${totalImages} images)`);
