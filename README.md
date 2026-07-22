# Canva Template Workspace

Standalone engine that clones Canva templates and authors brand-recolorable Instagram
templates from them, ready to seed into `content-gen`.

The repo root **is** the workspace — every script self-resolves it, so all paths below are
plain `scripts/…` and every command runs from the root.

Checked in and ready to use out of the box:

| | |
|---|---|
| `output/*.html` | 95 finished templates (75 carousel, 20 single-image) |
| `output/.seed/*.html` | the same templates with photo `src`s pointing at hosted blob URLs — this is what gets seeded |
| `designs/<id>/` | the cloned Canva reference behind each one, with page thumbnails |
| `dashboard.html` | open it in a browser; 93 success rows + 21 duplicates, no build step |

## Setup

```bash
npm install          # just playwright + cheerio
cp .env.example .env # then fill in the Azure keys
```

There is **no build, no linter and no test runner**. The four gate scripts below are the
test suite.

You only need `.env` and Chrome if you plan to clone or generate. Browsing the existing 95
templates and the dashboard needs neither.

### Chrome (cloning + generating only)

Both stages drive a debuggable Chrome logged into Canva on port **9222**, using a dedicated
debug profile directory — never Chrome's own `User Data` dir, which Chrome 136+ blocks the
debug port on. The directory is machine-specific, so it is not hardcoded anywhere:

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 \
  --user-data-dir="<your debug profile dir>" \
  --no-first-run --no-default-browser-check --new-window "https://www.canva.com/"
```

Log in once in that window; it persists.

## Commands

```bash
npm run dashboard        # rebuild dashboard-store.json + dashboard.html from disk
npm run clone            # clone orchestrator + status
npm run clone:browser    # Stage 1 — capture a Canva design over CDP
npm run generate         # Stage 2 — faithful reproduction, batch
npm run remix            # Stage 2 — remix (the default deliverable), batch
```

Gate one template (`output/<slug>.html`):

```bash
npm run gate:contract <html>   # static contract — element and slot semantics
npm run gate:verify   <html>   # render + measure: fonts, overflow, collision, contrast
npm run gate:stress   <html>   # re-render with worst-case text; must still hold
npm run gate:brand    <html>   # does the deck actually recolor under a brand palette
npm run score  <slug|path>     # folds all four into a /10 in template-scores.json
```

Publishing and seeding:

```bash
npm run publish:probe    # what would upload, without uploading
npm run publish:images   # push local photos to Azure Blob, rewrite output/.seed/
npm run seed:metadata    # AI-written title/useCases/tone for each template
npm run seed:bundle      # emit the typed TS the content-gen seeder imports
```

`publish:images` skips anything already uploaded (it compares Content-MD5), so re-running it
is cheap and safe.

## The two stages

**Stage 1 — clone.** Captures a Canva template's editor DOM into `designs/<id>/extract/`
plus a dashboard preview. Dedupe is by **content fingerprint, not URL**, so a recolor of a
base template is correctly flagged a duplicate.

```bash
node scripts/clone-from-browser.mjs --search "<query>" --english-only
node scripts/clone-from-browser.mjs --url "<editor url>"
node scripts/clone-from-browser.mjs --search "<query>" --kind single-image
```

**Stage 2 — generate.** "Generate the template for `<id>`" means **remix** by default: keep
the reference's craft and design language, invent the content. A faithful near-verbatim
reproduction is opt-in only.

```bash
node scripts/remix-worker.mjs --design-id <id>     # remix — the default
node scripts/generate-worker.mjs --design-id <id>  # faithful repro — opt in
```

Both ship a single self-contained `output/<slug>.html` with all CSS, fonts and photos
inlined, so it renders offline.

## Two template kinds

Discriminated by a `kind` field, not a filename convention, and their contracts genuinely
contradict each other:

- **`carousel`** — 2–12 slides, `.ig-carousel > .slide`, per-element absolute positioning
  mirroring Canva's own geometry.
- **`single-image`** — exactly one page, `.si-single > .si-page`, and **flow layout only**;
  `position:absolute` is allowed for a full-bleed background photo and one corner decoration,
  nothing else. Remix-only, because exact geometry cloning cannot satisfy a flow-layout
  contract.

All four gates auto-detect which kind they are looking at.

## Why four gates

Each catches a defect class the others are blind to, and `score-template.mjs` folds them into
one /10 (contract 4.0, verify 3.0, stress 1.5, brand 1.5):

- **contract** — static semantics the runtime parser enforces. A body message stuffed into a
  label slot is a real bug that no render can show you. Selectors are copied from content-gen's
  parser so they cannot silently diverge.
- **verify** — renders and measures actual pixels: font really loaded, no overflow, no
  text/photo collision, WCAG-AA contrast.
- **stress** — re-renders with worst-case generated copy, catching slots that only hold
  because the author picked short text.
- **brand** — a pixel counts as brand-driven only if it *changes* when the brand vars change.

> **The score measures structure, not composition.** A 10/10 deck can still have colliding
> tabs and shouty copy. Always look at `.renders/output/<slug>/slide-NN.png` before calling a
> deck done.

## Data files

All at the repo root, all checked in:

- `dashboard-store.json` — source of truth for the dashboard, one entry per design.
  **Every path in it is workspace-relative** (`designs/<id>/…`). This repo is worked on from
  several machines; an absolute root bakes one box's layout into shared data and breaks every
  thumbnail elsewhere. Repair a store written on another box with
  `node scripts/fix-moved-paths.cjs` (idempotent, `--dry` to preview).
- `archetype-map.json` — design id → slug for its faithful template.
- `remix-map.json` — design id → slug for remixes.
- `template-scores.json` — slug → gate breakdown and /10.
- `index/template-dedupe-index.json` — the fingerprint index.
- `seed-metadata.json` — per-template title, use cases and tone for seeding.

## Several chats may be working at once

This workspace is routinely driven from more than one session at a time.

- **Never `rm -rf` a shared directory** — `output/`, `output/.verify/`, `designs/`. Another
  agent may be mid-run. This has actually happened.
- Scope every delete to your own slug, and only for something this session created.
- Need a clean render dir? `verify-slides.mjs <html> --out <scratch-dir>` — never wipe the
  real one.
- To take a design safely, claim it atomically:
  `node scripts/agent-canva-clone.mjs --action claim --design-id <id> --stage authoring`,
  and only proceed if it returns `claimed: true`. Status marking alone does not lock.

## Seeding into content-gen

`seed-bundle/` holds everything the other repo needs. `seed-bundle/README.md` has the full
walkthrough; the short version is that the images are already hosted, so seeding uploads
nothing.

`CONTENT_GEN_INTEGRATION_PLAN.md` records the structural gaps found between this workspace's
output and content-gen's validators, and how each was closed.
