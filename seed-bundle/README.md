# Seed bundle — 96 templates for content-gen

Everything needed to seed these into content-gen. Self-contained: copy this folder, follow the
four steps, done.

- **76** carousel, **20** single-image
- **33** carry photos (**131** images total), already uploaded to Azure Blob
- Generated 2026-07-22 by `canva-template-workspace`

## What's here

| Path | What it is |
|---|---|
| `carousels/<slug>.html` | The 96 templates. Photo `src`s already point at hosted Azure Blob URLs — nothing else to upload. |
| `seed-carousel-templates.generated.ts` | Catalog entries in content-gen's own `carouselTemplates` array shape. |
| `manifest.json` | Machine-readable index (slug, kind, category, contentMode, image count). |

## How to seed

**1. Copy the HTML into content-gen**

```bash
cp carousels/*.html <content-gen>/backend/database/carousels/
```

The seeder reads `backend/database/carousels/<slug>.html` by slug, so filenames must stay as-is.

**2. Register the entries**

Open `<content-gen>/backend/database/seeds/seed-carousel-templates.ts`. It exports a
`carouselTemplates` array. Add these 96 entries to it — either paste the contents of
`seed-carousel-templates.generated.ts`'s array, or drop the file in beside it and spread it:

```ts
import { generatedCarouselTemplates } from './seed-carousel-templates.generated';

export const carouselTemplates = [
  // …existing hand-authored entries…
  ...generatedCarouselTemplates,
];
```

⚠️ **`order` values in this file start at 0.** If the existing array already uses those numbers,
offset ours (e.g. `order: i + 100`) so ordering stays sane. Everything else is self-contained.

**3. Run the seeder**

```bash
cd <content-gen>/backend/database
pnpm db:seed:carousel-templates
```

It upserts by the composite unique `(kind, slug)`, so re-running is safe and idempotent.

**4. Verify**

```sql
SELECT kind, COUNT(*) FROM "CarouselTemplate" WHERE is_system = true GROUP BY kind;
```

Expect **76 carousel** and **20 single-image**. Then open the template gallery —
cards render live from the HTML, so photos loading confirms the blob URLs resolve.

## Things worth knowing before you seed

- **These are seed-ready, not the working copies.** Photo `src`s are absolute Azure Blob URLs.
  The workspace also keeps a local-relative version for offline rendering — that one must never
  be seeded, its photos would 404 for every user. This bundle is built only from the hosted set.
- **The seeder prunes.** It deletes system rows whose slug is no longer in the array, so removing
  an entry and re-seeding removes it from the DB.
- **Contract-verified.** All 96 pass this workspace's contract gate, which mirrors
  content-gen's own `carousel-template-parser.ts` / `validateColorTokens.ts` /
  `svgEmitLint.ts` rules: 9-token `:root` deriving from the right `--brand-*` vars, SVG paint
  via `--cg-fill`/`--cg-stroke`, no `currentColor`, no inlined base64, no SVG `<filter>`.
- **Contract-clean is not the same as visually perfect.** A handful score below this workspace's
  own 8/10 quality bar (mostly WCAG contrast on photo-backed slides). They will seed and render
  fine; they just are not the strongest of the set. `manifest.json` does not flag these — ask
  the workspace owner if you need the current list.
- **Single-image templates** use `.si-single > .si-page` with flow layout, not
  `.ig-carousel > .slide`. content-gen already discriminates on the `kind` column; nothing extra
  to do, just do not assume every file is a carousel.

## Regenerating

From the workspace: `node scripts/build-seed-bundle.mjs`. It refuses to build if any template
still has a relative or base64 image src, so a bundle that exists is a bundle safe to seed.
