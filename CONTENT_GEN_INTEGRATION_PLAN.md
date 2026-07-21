# Integration Plan: canva-template-workspace → content-gen

**Purpose.** This workspace clones Canva templates and authors brand-recolorable carousel
decks (`output/*.html`). The platform that actually uses these in production is **content-gen**
(`C:\Users\admin\Desktop\dprajapati\azure\content-gen`), where they'd become seeded
`CarouselTemplate` rows a user can pick, fill with AI copy, brand-skin, and publish. This
document is the concrete gap analysis between what this workspace currently outputs and what
content-gen actually requires — verified against content-gen's real source code, not assumed —
plus a step-by-step migration plan, plus a separate set of improvement ideas for content-gen
itself.

No code was changed in either project to produce this document. Everything below is either a
direct file/line citation from content-gen's source, or a direct grep/read of this workspace's
own `output/*.html` files.

At the time of writing, 16 of the eventual ~55 designs in this workspace's pipeline have
finished generation (`output/*.html`); the rest are still draining through the background
worker. Every finding below was checked across all 16 existing outputs, and the same finding
applies to future outputs too, since they all come from the same authoring prompt
(`scripts/generate-worker.mjs`) — fixing the prompt (Part D) fixes it for everything generated
from this point forward, not just the current 16.

---

## Part A — The good news: most of the contract already matches, on purpose

This is worth stating plainly before listing gaps: this workspace's own contract checker
(`scripts/check-template-contract.mjs`) was explicitly built by copying selectors from
content-gen's real parser (`carousel-template-parser.ts`) and validator (`validateColorTokens.ts`)
— see that file's own header comment. Because of that, the *structural* skeleton already lines
up almost exactly:

| Requirement | content-gen source | This workspace's output |
|---|---|---|
| Root wrapper `<div class="ig-carousel">` | `carouselTemplateContract.ts:68` — **hard throw** if missing | ✅ present in all 16 |
| Slide wrapper `<section class="slide">` | matches `SLIDE_UNION_SELECTOR` (`shared/utils/slide-canvas.ts:41`) | ✅ present in all 16 |
| 9-token `:root` layer (`--primary`, `--secondary`, `--accent`, `--bg`, `--surface`, `--text-high`, `--text-low`, `--border`, `--highlight`) | `validateColorTokens.ts:31-41` — **hard violation** if any missing | ✅ all 9 declared in all 16 |
| `data-cg-slide-type` on every slide | present in every one of content-gen's own 39 seeded `.html` files (confirmed by grep) | ✅ present in all 16 |
| `data-cg-svg` + `data-cg-preserve` on every root `<svg>` | required by *this workspace's own* gate (`check-template-contract.mjs` C10), matching an SVG-corruption bug content-gen's cheerio-based parser has | ✅ present everywhere SVGs are used |
| Brand lockup (`.brand-word`, `.brand-mark`, `data-brand-logo`) | `carousel-template-parser.ts:1215-1277` swaps these at generation time; **optional** per the AI-authoring prompts (`carousel-templates.ts:377`) | ✅ present, correctly optional |

This means the migration work below is narrower than "rebuild to match a different contract" —
it's closer to "close a handful of specific, verified gaps," most of which are fixable in the
authoring prompt once and apply to every future template.

---

## Part B — Confirmed gaps (evidence-based, ranked by severity)

### B1. `--highlight` sometimes derives from a brand variable content-gen never defines — **confirmed broken in 2 of 16 templates**

content-gen's validator doesn't just check that `--highlight` exists — it checks *what it
derives from* (`validateColorTokens.ts:186-208`, `checkBrandDerivation`), against a fixed map
(`TOKEN_BRAND_MAP`, line 55-65) that requires:

```
'--highlight': '--brand-accent',
```

content-gen's brand-skin injector (`carousel-brand-skin.ts`) only ever defines these
`--brand-*` variables: `primary, secondary, accent, ink, bg, surface, border, bg-alt, text,
text-muted, on-accent, on-primary, on-secondary` (+ `-readable` variants). **`--brand-highlight`
is never one of them.**

Checked across all 16 current outputs:

| File | `--highlight` derives from | Verdict |
|---|---|---|
| 12 of 16 (e.g. `breach-alert-briefing.html`, `garden-year-recap.html`, `pitch-craft-rules.html`, …) | `var(--brand-accent, ...)` | ✅ correct |
| `dear-new-parent.html`, `pack-light-checklist.html`, `make-your-zine.html` | `var(--brand-highlight, var(--brand-accent, ...))` or `var(--brand-accent2, var(--brand-accent, ...))` | ⚠️ works by accident — falls through to the correct var, but the primary reference is to a var that will never exist |
| **`price-your-worth.html`, `street-photography-diary.html`** | `var(--brand-highlight, <hardcoded-hex>)` — **no fallback to a real brand var at all** | ❌ **broken** — this color will never re-brand on content-gen; it always renders the hardcoded fallback hex regardless of which brand is applied |

This would not be caught by this workspace's own gate — `check-template-contract.mjs`'s
`C1-TOKENS` rule only checks that the 9 tokens *exist* (`REQUIRED_TOKENS.every(t =>
styleText.includes(t + ':'))`), never checking derivation source. So all 16 templates score
"clean" on this rule despite 2 being genuinely broken for this specific property. This is a real
blind spot in this workspace's own gate, not just a content-gen mismatch (see Part E1).

**Root cause**: the authoring prompt (`scripts/generate-worker.mjs:411`) lists the 9 required
token *names* but never pins the exact derivation source per token, so the model is free to
invent a plausible-looking but non-existent intermediate variable name.

### B2. Baked-in generated images make some files ~500× larger than content-gen's own templates — will not scale into a database row

content-gen's own image-slot convention (`carousel-template-parser.ts:313-321`) never embeds a
real image in the seeded template file — it sets `src="[[AI_IMG:<query>]]"`, a text placeholder
resolved to a real (small, remote) Pexels URL at generation time, with
`https://picsum.photos/1080/1350` as a tiny fallback.

This workspace's own `fill-image-slots.mjs`, by contrast, bakes a full base64 PNG directly into
the `<img src="data:image/png;base64,...">` attribute. Measured directly:

```
output/garden-year-recap.html   16,359,320 bytes  (5 baked photos)
output/price-your-worth.html        27,886 bytes  (no photos, typographic)
```

**~587× larger.** Every one of the 7 (of 16) templates with real photo slots has this problem.
Storing this as a hand-authored seed's HTML file (`backend/database/carousels/*.html`, tracked
in git, loaded into a TypeScript array at boot) would bloat the repo, slow every clone/checkout,
and very likely exceed whatever body-size limit content-gen's save/upload API route enforces
(not confirmed at a specific number, but a 16MB single-file payload is not a reasonable thing
to send through a typical JSON API route or store as a git-tracked text file).

The fix is a straightforward format conversion, not a quality loss: this workspace already
authors a specific, high-quality prompt per slot (`data-image-prompt="A woman in a linen apron
kneeling in a sunlit backyard vegetable garden…"`). That text is exactly the kind of thing that
should become content-gen's `[[AI_IMG:<query>]]` placeholder — porting the prompt text preserves
the authoring intent, and content-gen's own Pexels-resolution pipeline (or its own image-gen, if
enabled for that brand) fills it per-brand at actual generation time, which is the *correct*
place for that image to be decided anyway — a seed template baking in one specific stock photo
makes no sense once real brands with real topics start using it.

### B3. `--on-accent` doesn't match content-gen's own on-pair naming convention — cosmetic, but causes false-positive warnings

content-gen's own templates name this intermediate token `--on-fill` (confirmed in
`arrow-flow.html:22`: `--on-fill: var(--brand-on-accent, #ffffff);`), and its validator's
recognized on-pair pattern (`ON_PAIR_RE`, `validateColorTokens.ts:111-112`) matches `--on-fill`,
`--brand-on-accent`, `--on-primary`, `--brand-on-primary`, `--on-secondary`, `--brand-on-secondary`,
and the `-readable` suffixed variants — but **not** `--on-accent` (without "-fill").

This workspace's templates declare `--on-accent:var(--brand-on-accent,#111111)` and then use
`color:var(--on-accent)` on text sitting over a brand fill. Functionally the *color itself* is
correct (it does derive from `--brand-on-accent`), but because the R4 check
(`validateColorTokens.ts`) pattern-matches the *token name actually used in the `color:`
declaration*, not just its ultimate derivation, this will fire a spurious advisory warning every
time (not a hard block — R4 is warn-only — but noisy, and confusing to anyone reviewing content-
gen's validator output for these templates).

**Fix**: rename `--on-accent` → `--on-fill` everywhere in the authoring prompt and existing
outputs. Purely mechanical, zero visual/quality impact.

### B4. No seed metadata exists yet for any of the 40 (arguably the biggest gap, just not a code gap)

content-gen does not scan a directory for templates at boot — it reads a hardcoded TypeScript
array (`backend/database/seeds/seed-carousel-templates.ts:33-1444`), one object literal per
template, each with `name`, `slug`, `description`, `category`, `order`, `enabled`, `isSystem`,
`contentMode` (`'text-only' | 'text-images' | 'background-images'`), and a `recommendationProfile`
(`title`, `summary`, `tags[]`, `useCases[]`, `tone`, `visualStyle[]`,
`slideCountSweet: {min, ideal, max}`, `industries[]`, `audience[]`). None of this exists for any
of this workspace's outputs — it has to be authored by hand (or by a script) for every template
before it can be seeded. Existing categories in use: `general`, `business`, `lifestyle`, `tech`.

This is not a *quality* gap, but it is real work: 16 (soon ~55) templates × a dozen metadata
fields each. See Part D5 for a concrete templating approach to make this fast rather than
tedious.

### B5. `data-cg-slide-type` has no confirmed backend consumer — verify before treating it as load-bearing

It's present in every one of content-gen's own 39 seeded HTML files, and this workspace already
writes it faithfully (`data-cg-slide-type="text"` etc.) — but a direct grep across
`backend/services/content/src` and `shared` in `.ts`/`.tsx` source found **zero** code that
reads this attribute. It may be consumed by a frontend editor/playground file outside the paths
searched, or it may be a vestigial authoring convention with no active runtime reader. Either
way it costs nothing to keep writing it (it's already correct), but it should not be assumed to
be functionally required without a maintainer confirming where (if anywhere) it's actually read
— worth a 2-minute question to whoever owns the content-gen frontend rather than guessing further
here.

### B6. This workspace has never produced a single-image (`si-*`) template — ✅ RESOLVED (2026-07-21)

content-gen has two template *kinds*, discriminated by a DB column, not a filename convention:
`carousel` (2-12 slides) and `single-image` (exactly one `.si-page`, no `.slide`/`.ig-carousel`
at all — a structurally different root, per `SingleImageTemplateGenerationService.ts:1007-1038`).
This workspace's entire pipeline (`clone-from-browser.mjs`'s `--min-pages` gate, `generate-worker.mjs`'s
authoring prompt) is built exclusively around multi-slide carousels. If single-image posts are
a format worth having more of on content-gen, that's a new pipeline mode here, not a tweak — flagged
as a scope note, not a defect.

**Shipped.** Both sides now exist:

- **Clone**: `clone-from-browser.mjs --kind single-image` — exactly-1-page gate, allows content-gen's
  4 aspect ratios (including the 1.91:1 landscape one, unique to this kind), photo cap disabled by
  default, tags the entry `kind: 'single-image'`. `--url` also now auto-detects a template landing
  page vs an editor URL.
- **Contract gate**: `check-template-contract.mjs` detects `.si-page` and applies its own S1-S5
  rules (root structure, mutual exclusivity with carousel markup, the hard-required
  `<h1 class="headline">`, flow-layout-only enforcement, single-image-slot rule) — mirrored from
  content-gen's real `SingleImageTemplateGenerationService.ts` HARD CONTRACT, verified clean
  against a real content-gen file (`si-photo-hero.html`).
- **Render/measure gates**: `verify-slides.mjs`/`stress-slots.mjs`/`brand-audit.mjs` recognize
  `.si-single .si-page` alongside `.slide`, with a viewport that resizes to the page's actual
  canvas instead of assuming 1080×1350. `score-template.mjs` needed no changes.
- **Generation**: `generate-worker.mjs` gained a parallel authoring path (`SYSTEM_SI`/`REVIEW_SI`/
  `processOneSI`) — remix-only, since single-image's flow-layout requirement is structurally
  incompatible with this pipeline's exact-geometry faithful-reproduction approach. Dispatches
  automatically by `entry.kind`.
- **Agent docs**: `canva-clone-agent.md` and `template-remix-agent.md` updated so neither agent
  gets confused about which contract applies to which kind.
- **Verified end-to-end**, not just unit-tested: a real single-image Canva design was cloned,
  planned, authored, repaired, scored, and shipped through the full pipeline, producing a
  structurally valid, contract-clean template with a real generated photo baked in. One real bug
  found and fixed along the way (image-gen API rejects the canvas's own pixel size as a
  `data-image-size` — needs `1024x1024`/`1024x1536` regardless of canvas dimensions).

---

## Part C — Everything that needs **no** change

Worth stating explicitly so effort isn't wasted "fixing" things that are already fine:

- **Root wrapper, slide wrapper, 9-token layer, brand lockup, SVG contract attributes** — all
  already correct (Part A).
- **No thumbnail image is required.** content-gen's gallery renders a live preview component
  (`CarouselCardPreview`) rather than reading a stored thumbnail — this workspace's own dashboard
  cares about thumbnails for its *own* review UI, but that has no bearing on what content-gen
  needs.
- **`data-image="true"`** (this workspace's own image-slot marker) is inert but harmless on
  content-gen — its parser identifies content-photo slots structurally (any non-logo `<img>`
  inside a slide), so the attribute itself is simply ignored, not rejected. No need to strip it.
- **Optional brand lockup absence is fine** — 9 of 16 templates have no `.brand-word`/brand mark
  at all, which matches content-gen's own authoring guidance that a brand mark is optional and
  "many designs are stronger without one" (`SingleImageTemplateGenerationService.ts:1009`).

---

## Part D — Migration plan (in order)

1. **Extend `check-template-contract.mjs`'s C1-TOKENS rule to check derivation, not just
   presence**, mirroring content-gen's real `TOKEN_BRAND_MAP` exactly (Part B1's table). This
   makes the fix in step 2 verifiable and prevents every future generation from silently
   reintroducing the same bug. (This is a gate change in *this* workspace, not content-gen — no
   content-gen code needs to change for this step.)
2. **Fix the 2 confirmed-broken templates** (`price-your-worth.html`,
   `street-photography-diary.html`) — change `--highlight:var(--brand-highlight,#hex)` to
   `--highlight:var(--brand-accent,#hex)` (one-line edit per file, same fallback hex, zero visual
   change since the fallback is what's currently rendering anyway).
3. **Fix the authoring prompt** (`scripts/generate-worker.mjs`) to pin the exact derivation source
   per required token (the same table from B1), so this class of bug can't recur in the next ~40
   generations still in the pipeline.
4. **Convert baked image data-URIs to content-gen's placeholder convention** — replace
   `src="data:image/png;base64,..."` with `src="[[AI_IMG:<the existing data-image-prompt text>]]"`
   in the 7 photo-bearing templates; drop the now-redundant `data-image`/`data-image-prompt`
   attributes once the content is carried over (or leave them — they're inert, per Part C).
5. **Rename `--on-accent` → `--on-fill`** across the authoring prompt and all 16 outputs — a
   find-and-replace, no visual change.
6. **Author seed metadata for each template.** Suggested minimum viable fields per template:
   `name` (human title), `slug` (kebab from the filename, already matches), `description`
   (one line), `category` (pick from `general`/`business`/`lifestyle`/`tech`, or propose new ones
   if this workspace's topics don't fit — e.g. many current topics are personal/advice-column
   style, which might warrant a `personal` or `advice` category content-gen doesn't have yet),
   `contentMode` (`'text-only'` for the 9 typographic decks, `'text-images'` for the 7 with photo
   slots), and a `recommendationProfile` with a few tags. A single small script here could draft
   most of this automatically from what's already known (title from the design's topic, tags
   from a fixed vocabulary match against the deck's actual copy) with a human pass to confirm
   category/tone.
7. **Add entries to `seed-carousel-templates.ts`** (or a clearly-separated array/file if keeping
   this workspace's contributions distinguishable from the hand-authored set is preferable — a
   maintainer call, not a technical constraint) and run `pnpm db:seed:carousel-templates` per
   content-gen's own documented re-seed step.
8. **Validate before treating any of this as done**: run content-gen's own
   `enforceUniversalCarouselTemplateContract` in `'hard'` mode and `validateColorTokens` against
   every candidate file *before* seeding — this is the same validation content-gen would run
   anyway, just run it proactively so failures surface here, in a throwaway check, rather than as
   a confusing seed-time error later.

None of steps 1-5 require touching content-gen at all — they're entirely local to this
workspace's authoring prompt and existing output files. Steps 6-8 are the actual handoff into
content-gen.

---

## Part E — Improvement ideas for content-gen itself

These are opportunities noticed *while* doing this comparison — not required for this
migration, but genuinely useful findings from having looked closely at both systems side by
side.

### E1. content-gen's own validator is weaker than this workspace's gate in a few specific, portable ways

This workspace's `check-template-contract.mjs` encodes several structural rules that don't
appear to exist anywhere in content-gen's own `carouselTemplateContract.ts`/
`carousel-template-parser.ts`:

- **C4 (prose-without-slot-semantics)**: catches a `<p>`/`<h1-h6>` with real text but no
  recognized slot class — exactly the kind of element an LLM content-fill pass could write an
  oversized paragraph into, overlapping other content. This workspace's own comment describes a
  real shipped bug this caught. Content-gen's parser has no equivalent guard visible in the
  files reviewed.
- **C8 (more than one content photo per slide)**: content-gen's own parser only ever fills the
  *first* `<img>` per slide (confirmed in `carousel-template-parser.ts:536-537`,
  `.find('img').filter(isContentImage).first()`) — meaning a hand-authored template with 2 photo
  slots in one slide would silently ship its own baked-in second photo into every brand's post,
  forever. This workspace catches that at author time; content-gen's own hand-authored template
  set has no equivalent check, so it's plausible some of the 39 existing seeded templates already
  have this defect undetected.
- **C9 (readable text inside `<svg><text>`)**: catches a specific, previously-shipped font-load
  race bug (SVG `<text>` doesn't repaint on webfont arrival the way HTML text does). Given
  content-gen also renders with Playwright + Google Fonts, this exact bug class is equally
  possible in content-gen's own templates.

**Suggestion**: port these three checks (they're small, self-contained, cheerio-based — see the
actual code in `check-template-contract.mjs` C4/C8/C9) into content-gen's own contract enforcement,
run against all 39 existing seeded templates once as an audit. This protects content-gen's own
hand-authored library, not just future contributions from this workspace.

### E2. `data-cg-slide-type` (Part B5) is either dead code or under-documented

Worth a five-minute internal check: either wire it to something (a frontend "slide type" feature
that isn't there yet), or note in `CAROUSEL_COMPLETE_REFERENCE.md` that it's intentionally
authoring-convention-only. Right now a new contributor reading the seeded HTML has no way to
know which is true.

### E3. `CAROUSEL_COMPLETE_REFERENCE.md`'s slug list is stale

Noted during research: the doc's own list of "18 seeded slugs" (§3) no longer matches the
current 39-file/array count. Not discovered by this analysis' core question, but a quick,
low-risk doc fix while someone's already in that file.

### E4. No automated "does this seed file still match its DB row" check

Since seeding is a one-time script run (`seedCarouselTemplates()`) rather than a live directory
scan, there's no built-in way to detect drift — e.g. someone hand-edits
`backend/database/carousels/some-template.html` and forgets the documented
"you must re-seed" step. A lightweight CI check (hash the `.html` files, compare against a
hash stored at last-seed-time) would catch silent drift between the file on disk and what's
actually live in the database — a class of bug that's easy to introduce and hard to notice.

### E5. Consider accepting this workspace's `[[AI_IMG:query]]`-equivalent authoring signal as a first-class input

This workspace already authors a specific, contextual image *prompt* per slot
(`data-image-prompt`), not just a generic keyword — richer than a typical Pexels search query.
If content-gen's own image-gen path (mentioned as an alternative to Pexels in the codebase) can
accept a fuller prompt rather than a short query string, carrying that prompt text over (Part D4)
gets content-gen better, more specific imagery than its current Pexels-keyword-search default —
worth a look regardless of this specific migration.

---

## Appendix — Files/paths referenced in this analysis

- `content-gen/backend/services/content/src/services/carousel-template-parser.ts`
- `content-gen/backend/services/content/src/utils/validateColorTokens.ts`
- `content-gen/backend/services/content/src/utils/carouselTemplateContract.ts`
- `content-gen/shared/utils/carousel-brand-skin.ts`
- `content-gen/shared/utils/slide-canvas.ts`
- `content-gen/backend/database/seeds/seed-carousel-templates.ts`
- `content-gen/backend/database/carousels/*.html` (39 files)
- `content-gen/docs/CAROUSEL_COMPLETE_REFERENCE.md`
- `content-gen/docs/SINGLE_IMAGE_TEMPLATES_KNOWLEDGE_BASE.md`
- `canva-template-workspace/scripts/check-template-contract.mjs`
- `canva-template-workspace/scripts/generate-worker.mjs`
- `canva-template-workspace/scripts/fill-image-slots.mjs`
- `canva-template-workspace/output/*.html` (16 files, all read/grepped directly)
