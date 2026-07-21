# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Canva Template Workspace — project guide

Standalone engine that clones Canva templates and authors brand-recolorable carousel
templates from them. Two stages, two entry points.

## Commands

Plain Node (ESM `.mjs` + a few `.cjs`); deps are just `playwright` + `cheerio`. There is **no
build, no linter, and no test runner** — the gate scripts below ARE the test suite for an
authored template. Run everything from the repo root; scripts self-resolve their own root, so
paths are plain `scripts/…`.

```bash
npm run clone          # scripts/agent-canva-clone.mjs  — clone/dedupe orchestrator + status
npm run clone:browser  # scripts/clone-from-browser.mjs — CDP capture (Stage 1, needs Chrome :9222)
npm run generate       # scripts/generate-worker.mjs     — FAITHFUL batch (drains cloned queue)
npm run generate:once  # just the next cloned design
npm run dashboard      # rebuild dashboard-store.json + dashboard.html from disk
```

Gate an authored template (`output/<slug>.html`) — see "Gate & score pipeline" below:

```bash
npm run gate:contract <html>   # static contract check (0 violations = full marks)
npm run gate:verify   <html>   # render + measure: fonts/overflow/collision/contrast/photo
npm run gate:stress   <html>   # re-render with worst-case generated text; must still hold
npm run gate:brand    <html>   # differential recolor coverage under brand palettes
npm run score         <slug|path>   # combine all four gates → /10 into template-scores.json
npm run comparison    --design-id <id>   # rebuild designs/<id>/comparison.html
```

Other useful scripts: `remix-worker.mjs` (remix batch — the DEFAULT deliverable),
`remix-queue-status.mjs` / `next-template.mjs` (work queues), `decode-geometry.mjs` (exact
per-slide layout from Canva's obfuscated JSON), `fill-image-slots.mjs` (generate + inline photos
into `<img data-image="true">` slots), `fix-moved-paths.cjs` (repair a store written on another box).

## Prerequisite (both stages)

A debuggable Chrome logged into Canva on port **9222**, using a dedicated debug profile
dir — never Chrome's default `User Data` dir (Chrome 136+ blocks the debug port there).

The profile dir is **machine-specific** — it depends on the Windows user and where that
box keeps its logged-in Canva profile, so it is NOT hardcoded here. Check the agent's
memory for this machine's value (e.g. `chrome-debug-profile`) before launching. Two known
setups:

- Groovy box: `C:\Users\Groovy\chrome-debug-p6` with `--profile-directory="Profile 6"`
- mukun box: `C:\Users\mukun\chrome-debug-p6` (fresh default profile, no `--profile-directory`)

Launch (substitute this machine's dir):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 \
  --user-data-dir="<this machine's debug profile dir>" \
  --no-first-run --no-default-browser-check --new-window "https://www.canva.com/"
```

If a gated URL (`canva.com/folder/all-designs`) redirects to `/login`, log in ONCE in that
window; it persists. Generation also needs the Azure keys in `.env` (already configured):
`AZURE_OPENAI_*`, `AZURE_TEXT_MODEL`, `AZURE_IMAGE_*`, `GEN_PROVIDER` (codex | claude).

## Stage 1 — Clone (agent: `canva-clone-agent`)

Captures a Canva template's editor DOM → `designs/<id>/extract/` + dashboard preview. Use the
**`canva-clone-agent`** subagent (`.claude/agents/canva-clone-agent.md`) whenever the user says
"clone this template", "clone a few", pastes a `canva.com/design` URL, or works the template grid.
It wraps one command:

```bash
node scripts/clone-from-browser.mjs --tiles 3,7,12 --english-only   # grid tiles
node scripts/clone-from-browser.mjs --url "<editor url>"            # a specific design
node scripts/clone-from-browser.mjs --design-id <ID>               # an already-open editor
```

Captures in one pass (no redundant reloads), dedupes by content hash, screenshots each slide,
builds the dashboard preview, and refreshes — all in the same editor session. `--english-only`
skips non-English titles; `--min-pages N` (default **2**) keeps only multi-slide decks;
`--max-images N` (default **6**) drops photo-heavy decks — the RASTER (photo) count strongly
predicts generation speed + quality (0-6 photos = typographic, fast + clean; 15-53 = scrapbook/
collage, slow image-gen + text-on-photo contrast fails). Single-slide/photo-heavy decks are
cloned then rolled back (counts are only known post-extract). Pass `--max-images 999` to disable
the photo cap. Done = `status: cloned` + a `comparison` preview + `page-NN-thumbnail.png` == pageCount.

## Stage 2 — Generate

**"generate the template for <design-id>" means REMIX by default** — use the `template-remix-agent`.
The reference is inspiration: keep its craft and design language, invent the content (new topic, fresh
copy, own composition). The output must never reuse the reference's words, headlines, brand names or
`@handles`. Ship a faithful reproduction ONLY when asked for one explicitly ("clone it exactly",
"faithful repro") — that's `template-author-agent`.

History, so this doesn't flip again: an earlier "invent an original design" pivot was reverted for
hurting quality (memory `faithful-repro-pivot`), and Stage 2 became faithful-repro. That is now
superseded — the reverted pivot was the *batch worker* free-styling without a runbook, which is a
different thing from the remix agent, which studies the reference first and passes the same gates.
Evidence (2026-07-16): remix scored 8.8 (`write-better-emails`) and 10 (`the-drawn-line`) vs 8.2 for
the faithful repro of the same reference, and a faithful repro is a near-verbatim copy of someone
else's Canva template — see memory `template-authoring-intent`.

Three ways to run it:

### A) CLI agent (`template-remix-agent`) — THE DEFAULT for "generate the template for <id>"

The model studies the reference to work out WHY it works, keeps its craft and design language, then
invents the content — its own topic, fresh copy, its own composition. Recognisably the same design
family, but its own piece. It authors, RENDERS, LOOKS at the pixels and iterates, then runs the full
gate set. Runbook: `.claude/agents/template-remix-agent.md`.

Ships standalone: `output/<3-word-kebab-slug>.html`, its own renders in `.renders/output/<slug>/`, NO
`archetype-map.json` entry and no dashboard row (the map + row belong to a design's faithful version,
if one exists). Two remixes of the same reference are fine — give each a distinct slug.

**The gate score is NOT a quality signal on its own.** It measures structure, not composition:
`the-drawn-line` scored a perfect 10/10 while shipping colliding tabs, shouty all-caps body copy and
arrows clipped off the canvas. ALWAYS look at `.renders/output/<slug>/slide-NN.png` before calling a
deck done, and send the agent back with a specific defect list if it's wrong.

**Dispatching the CLI agent one-by-one across many designs?** The queue/progress lives ONLY in
whichever chat is dispatching it (one subagent call per design) — nothing durable tracks it, so a
crash or session restart loses "where we were" entirely (happened 2026-07-17). If you're driving a
multi-design batch this way, write the fixed scope to `remix-queue.json` (ids + why any were
excluded) once at the start, and check `node scripts/remix-queue-status.mjs` to see done/in-progress/
pending — it derives progress live from `remix-map.json` + `dashboard-store.json`, so it can't drift
out of sync. Any `generating` row left over from a real crash (not another chat's live agent) should
be knocked back with `node scripts/agent-canva-clone.mjs --action mark --design-id <id> --status
cloned` before resuming it.

**"start queue" / "resume queue" / "continue the queue"** (or similar, no design id given): run
`remix-queue-status.mjs`, take the FIRST entry under PENDING (queue order = oldest-first, not
in-progress) as the design to work, and dispatch exactly ONE `template-remix-agent` subagent for it.
Default concurrency is **1 at a time** — never launch more than one subagent from a bare "start
queue" instruction. Only run more concurrently if the user's prompt explicitly says a number or
"parallel"/"at once" (e.g. "start queue with 3 in parallel"). Chain the next one only after the
current one reports back, same as running it manually one-by-one.

**Multi-session safety**: `remix-queue-status.mjs` only READS — it claims nothing. Two separate
chats both saying "start queue" within moments of each other WILL both compute the same oldest-
pending design (confirmed happening in practice, 2026-07-17 — two chats both started DAHO9lfaPdg).
`--action mark --status generating` does NOT fully close this: it reads the store once at process
start and only locks at save time, so two callers can both see "free" before either writes.

Use **`agent-canva-clone.mjs --action claim --design-id <id> --stage "authoring"`** instead — it does
the check-and-set as ONE atomic operation inside a single lock acquisition (re-reads the store fresh
from disk only once the lock is held), so exactly one caller gets `claimed: true` even when raced
head-to-head (tested: two simultaneous calls on the same id → one true, one false). The ORCHESTRATING
session must call `claim` and check the result BEFORE dispatching the subagent: `claimed: false` means
someone else already has it — pick the next pending design instead. `mark` still exists for manual
status fixes (un-sticking a crash-orphaned row back to `cloned`, marking `failed`) where atomicity
doesn't matter. (The self-driving batch command
below doesn't have this problem — its
queue is just "whatever is still `cloned`", which is already durable on disk.)

### B) Batch command — self-driving, drains the `cloned` queue

```bash
node scripts/remix-worker.mjs                 # REMIX (the default deliverable), every cloned design
node scripts/remix-worker.mjs --once          # just the next one
node scripts/remix-worker.mjs --design-id <ID>
node scripts/generate-worker.mjs              # FAITHFUL repro — same engine, opt-in only
```

`remix-worker.mjs` is a thin wrapper over `generate-worker.mjs --remix` — ONE engine, not a fork.
`--remix` only selects prompts + the ship branch (standalone slug + `remix-map.json`, no
`archetype-map` claim); everything else — best-of-N, gates, bounded repair, occlusion guard,
count-lock, vision review — is shared, and `SYSTEM_REMIX`/`REVIEW_REMIX` are DERIVED from the
faithful prompts so the structure contract can't drift (a missed swap throws at startup). Don't
fork it to add a mode: this repo already carries one such fork (two copies of
`template-author-agent.md`) and they diverged.

**The worker is weaker than the CLI agent** — the gates measure structure, not composition, and its
vision review passes flat decks the agent's own eyes would catch. Spot-check
`.renders/output/<slug>/slide-NN.png` before trusting a batch.

#### Engine internals (`generate-worker.mjs`)

Walks the `cloned` queue and, per design: transcribes the reference faithfully, feeds the author EXACT
geometry (`decode-geometry.mjs` → real font-sizes/box-sizes so it stops eyeballing), runs the contract +
verify gates with a bounded repair loop, injects a deterministic occlusion guard (text always above
surfaces), then a **faithfulness vision loop** — renders the deck, shows the model each slide beside its
reference, and RE-AUTHORS from sight until collisions/occlusion/missing/chrome defects clear. Ships to
`output/<slug>.html`, maps the archetype, rebuilds the comparison, flips **cloned → success**.

```bash
node scripts/generate-worker.mjs                 # every cloned design, one by one
node scripts/generate-worker.mjs --once          # just the next one
node scripts/generate-worker.mjs --design-id <ID># a specific design
node scripts/generate-worker.mjs --slide <N>     # author ONLY reference page N → output/_slide-*.html preview (fast per-slide quality probe; needs --design-id)
node scripts/generate-worker.mjs --provider claude   # override GEN_PROVIDER (codex|claude)
```

Self-driving batch — start it and let it drain the queue. Output in `output/`; dashboard shows before/after.

### C) CLI agent (`template-author-agent`) — faithful reproduction, ONLY when asked for one

Same hand-authoring loop as the remix agent (author → render → LOOK → iterate), but it reproduces the
reference's layout/copy/devices closely instead of inventing content. Use ONLY on an explicit ask
("clone it exactly", "faithful repro") — the output is a near-verbatim copy of someone else's Canva
template, placeholder text and all, which is why it is no longer the default. Runbook:
`.claude/agents/template-author-agent.md`. It DOES own the design's `archetype-map.json` entry and
dashboard row (cloned → success). New agent files need a Claude Code restart to be spawnable by type;
until then run it via a `general-purpose` (opus) agent told to Read and follow that runbook.

## Single-image mode (`kind: 'single-image'`) — one-page posts, not carousels

Added 2026-07-20. content-gen has two template kinds, discriminated by a DB column, not a
filename convention: `carousel` (2-12 slides, `.ig-carousel > .slide`, per-element absolute
positioning mirroring Canva's own geometry) and `single-image` (exactly one page,
`.si-single > .si-page`, and — critically — **flow layout only** for every content slot;
position:absolute is allowed ONLY for a full-bleed background photo and one optional corner
decoration). Those two contracts structurally contradict each other, so this pipeline's usual
"decode exact Canva geometry, place each text node at its own x/y" approach cannot produce a
valid single-image template — the single-image path is **remix-only** for that reason (study
the reference's craft — density, hierarchy, decorative devices — and re-compose it in flow
layout with an invented topic; never a pixel-exact clone).

- **Clone**: `node scripts/clone-from-browser.mjs --search "<query>" --tiles <N> --kind
  single-image --english-only`. Flips the usual gates: requires pageCount === 1 (rejects
  multi-page), allows 1:1 / 4:5 / 9:16 / **1.91:1 landscape** aspect (the one landscape ratio
  this kind allows — content-gen's `SINGLE_IMAGE_FALLBACKS`), and disables the photo-heavy cap
  by default (a full-bleed background photo is the normal PHOTO-HERO archetype here, not a
  defect). Tags the dashboard entry `kind: 'single-image'`.
- **Generate**: `generate-worker.mjs --remix --design-id <id>` reads the entry's `kind` and
  routes automatically to the single-image authoring path (`processOneSI`/`SYSTEM_SI`/
  `REVIEW_SI`) — same plan → author → bounded-repair → faithfulness-vision-loop shape as the
  carousel path, simplified to one generation attempt (not best-of-N) since the tighter
  contract (one page, one required `<h1 class="headline">` slot) converges reliably without it.
  Ships to `output/<slug>.html` via `remix-map.json`, same as a carousel remix — always remix,
  regardless of whether `--remix` was passed, since single-image has no faithful mode.
- **Image slots**: `data-image-size` on `<img class="si-image">` MUST be `1024x1024` or
  `1024x1536` (the image-gen API's own valid sizes) — **never** the canvas's own pixel WxH
  (1080x1350 etc.). CSS (`object-fit:cover`) scales the generated image to fill whatever box
  it's placed in; the generator's native resolution is unrelated to the design canvas size.
  Getting this wrong fails generation with a confusing `400: ... divisible by 1` error.
- **Gates**: `check-template-contract.mjs`, `verify-slides.mjs`, `stress-slots.mjs`,
  `brand-audit.mjs` all auto-detect `.si-page` (a union selector alongside `.slide`,
  `.ig-carousel .slide, .si-single .si-page`) and treat it as a one-page deck; the viewport
  resizes to the page's own box since single-image canvases aren't locked to 1080×1350.
  `score-template.mjs` needed no changes — it just orchestrates the other four.
- **Verified against real content-gen source**, not guessed: the structural contract mirrors
  `backend/services/content/src/services/SingleImageTemplateGenerationService.ts`'s own "HARD
  CONTRACT" block, cross-checked against the ground-truth seeded `si-photo-hero.html` file. A
  real content-gen single-image file passes this workspace's contract gate clean; a real clone
  was authored, repaired, and shipped end-to-end during this rollout.

## Concurrency — other chats/agents may be working RIGHT NOW

This workspace is routinely driven from **several chats at once** (a clone agent here, a remix/author
agent there). Treat every shared path as live, not yours.

- **NEVER `rm -rf` a shared dir** — `output/`, `output/.verify/`, `replicas/`, `designs/`. Another
  chat's agent may be mid-run and you will destroy its in-progress work. (This has happened: wiping
  `output/.verify/` to "clean up" deleted a live agent's renders.)
- **Scope every delete to your own artifact**: only `output/.verify/<your-slug>/`, and only for a
  template this session created. If you did not create it, do not delete it — ask.
- **Need a clean render dir to test?** Use `verify-slides.mjs <html> --out <scratch-dir>` — never wipe
  the real one.
- **Renders are per-template**: `verify-slides.mjs` writes `<dir-of-html>/.verify/<template-name>/`,
  so parallel runs never collide. Read only `output/.verify/<slug>/slide-NN.png` (the command prints
  the dir it wrote). Never point a compare board at bare `.verify/` — it will show whichever deck
  rendered last.
- **Before touching a file you didn't create**, check it's not live: `ls -l --time-style=+%H:%M:%S`
  — a recent mtime means an agent is working on it. Leave it alone.
- **Changing a shared script** (e.g. `verify-slides.mjs` paths) while agents run will break them
  mid-flight: they loaded their runbook at spawn and follow the OLD contract. Prefer backwards-
  compatible changes, or wait until nothing is running.

## Architecture & data model

**The deliverable** is `output/<slug>.html` + its sibling image folder: one section per slide,
CSS/fonts inlined, **photos as files** at `output/assets/images/<slug>/<name>.png` referenced by
a RELATIVE path (`src="assets/images/<slug>/slide-03.png"`). It is **brand-recolorable** — every
non-fixed color is a `--brand-*` CSS var (`--brand-primary/-accent/-bg/-ink/-surface/…`), and photo
slots are `<img data-image="true">` that `fill-image-slots.mjs` fills with per-slide generated
images. Fixed literals (canvas paper, ink) intentionally do NOT move under recolor — that's what
`brand-audit.mjs` measures differentially.

**Photos are files, not base64 (changed 2026-07-21 — B2).** They used to be inlined as
`data:…;base64`, which pushed templates to 16-21 MB (345 MB across `output/`). content-gen stores
template HTML in a Postgres `html_content @db.Text` column that *will* accept that, but its own
HTTP create/update path caps at **10 MB** (`express.json` in `config/middleware.ts`) — so an
inlined template can be seeded yet never edited through the admin API — and its own 40 seeded
templates carry **zero** base64 (every content photo is a plain URL). Externalizing took HTML from
343 MB → 0.56 MB total.

- Naming is DERIVED, not arbitrary: a photo is named for the slide it sits on (`slide-03.png`),
  since the contract already permits at most one content photo per slide, so the slide number is
  both unique and meaningful. Single-image pages get `page-01.png`.
- Brand-logo `<img data-brand-logo>` stays INLINE — a few hundred bytes of URL-encoded SVG (not
  base64), and content-gen swaps it for the real brand logo at generation anyway.
- The relative path resolves correctly everywhere it's loaded today: every gate and
  `build-comparison.mjs` load the HTML in place via `pathToFileURL`, and the dashboard iframes it
  as `output/<slug>.html` from the repo root — both resolve `assets/images/…` against `output/`.
- Gate-enforced by `check-template-contract.mjs` **C12-IMGSRC**: a base64 content photo is a
  violation, and so is a linked path with no file behind it (a broken link renders as a silently
  missing image, which is worse).
- Backfill/repair tool: `node scripts/externalize-images.mjs --all` (decodes any base64 photo to a
  file and rewrites the src; `--dry` to preview).
- **At seed time** the relative prefix is swapped for the hosted (Azure Blob) URL. That upload +
  swap is **manual for now** — see "Future improvement" below.

**Gate & score pipeline** — why there are four gates, not one. Each catches a defect class the
others are blind to; a template only ships when all pass, and `score-template.mjs` folds them into
a single /10 (weights: contract 4.0, verify 3.0, stress 1.5, brand 1.5) cached in
`template-scores.json` for the dashboard:
- `check-template-contract.mjs` — **static**: element/slot semantics the runtime parser enforces
  (a body message stuffed into a label slot is a contract bug no render can see). Selectors + token
  list are copied from the `content-gen` backend parser so they can't silently diverge.
- `verify-slides.mjs` — **renders + measures pixels**: font actually loaded (no silent fallback),
  no overflow, no text/photo collision, WCAG-AA contrast, photo not flat. Writes to
  `<dir-of-html>/.verify/<template-name>/slide-NN.png` (per-template, so parallel runs never collide).
- `stress-slots.mjs` — re-renders with **worst-case generated text** (the author picks copy that
  fits; a production LLM won't), catching slots that only hold at the short end.
- `brand-audit.mjs` — a pixel counts as brand-driven only if it **changes** when the brand vars
  change (per-slide ≥1.5%, deck avg ≥3.0%).

Remember: the score measures **structure, not composition** — a 10/10 deck can still have colliding
tabs and shouty copy. Always LOOK at the rendered `slide-NN.png` before calling a deck done.

**JSON stores (all at repo root, all checked in):**
- `dashboard-store.json` — source of truth for the dashboard; one entry per design keyed by
  `designId` with `status` (`pending`→`cloning`→`cloned`→`generating`→`success`/`failed`/`duplicate`),
  `clone`, `qualityGate`, `remixes`, `comparison`, thumbnails. **All paths are workspace-RELATIVE**
  (`designs/<id>/…`) — the store is worked on from several machines, so an absolute root breaks every
  thumbnail elsewhere. `agent-canva-clone.mjs` relativizes on save; resolve with `toAbs(root, p)`
  before any `fs` call.
- `archetype-map.json` — design id → slug for its **faithful** template (owns the dashboard row).
- `remix-map.json` — design id → slug for **remixes** (standalone; no dashboard row).
- `template-scores.json` — slug → gate breakdown + /10 (populated by `score-template.mjs`).
- `index/template-dedupe-index.json` — dedupe is by content fingerprint (`exactHash` + `layoutHash`),
  NOT URL, so a recolor of a base template is a real `duplicate`.

**Concurrency & claiming** — because several chats drive this workspace at once, `remix-queue-status.mjs`
only READS (claims nothing) and status-marking is not atomic. To take a design safely, the orchestrating
session must call `agent-canva-clone.mjs --action claim --design-id <id> --stage authoring` (atomic
check-and-set under one lock) and dispatch only if `claimed: true`. See the Concurrency section above for
the shared-directory rules (never `rm -rf` a shared dir; scope deletes to your own slug).

## Future improvement — automate the seed-time image upload

Photos ship as local relative paths (`assets/images/<slug>/slide-03.png`). At seed time they must
live on Azure Blob and the HTML must point at the hosted URL instead. **Today that swap is manual**
— deliberately, because the Blob container/credentials aren't wired into this workspace yet.

When those details exist, automate it as a script that: uploads `output/assets/images/**` to the
container preserving the `<slug>/<name>.png` layout (so the hosted path mirrors the local one
1:1 — that symmetry is the whole point of the folder structure), then rewrites every
`src="assets/images/…"` to `<blob-base-url>/assets/images/…`. Keep it a SEPARATE step that emits
seed-ready copies rather than mutating `output/` in place, so the workspace stays renderable
offline and re-runnable. Needs: container name, base URL, and a connection string or SAS token
with write access.

## Notes

- Repo is standalone (root IS the workspace); scripts self-resolve their root — plain `scripts/…`.
- **Paths in `dashboard-store.json` are workspace-RELATIVE** (`designs/<id>/…`), never absolute. The
  store is checked in and this repo is worked on from several machines (`C:\Users\<x>\Projects\…`,
  `D:\wamp64\www\…`); an absolute root bakes one box's layout into shared data and every thumbnail
  breaks on the other. `agent-canva-clone.mjs` relativizes on save (`toRel`/`relativizeDeep`) and
  `dashboard.html` sits at the root so the browser resolves the relative srcs as-is. Resolve with
  `toAbs(root, p)` before any `fs` call. Repair a store written by an older/other box with
  `node scripts/fix-moved-paths.cjs` (idempotent; `--dry` to preview).
- The Stage-2 CLI authoring rules live in `.claude/agents/template-author-agent.md` in THIS repo
  (ships to `output/`). A separate older copy exists in the `content-gen` repo (ships to `backend/`).
- Dedupe is by fingerprint, not URL — a recolor of a base template is a real `duplicate`.
