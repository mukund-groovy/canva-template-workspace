# Canva Template Workspace

Portable, self-contained workflow folder for Canva template cloning.

Use this when you want any AI/tool/person to follow one consistent structure with no path guessing.
All required clone engine scripts now live inside `canva-template-workspace/scripts/canva/`.

## What You Need

1. `editor-page.full.html` from Canva editor (captured after load; one reload strategy recommended when rate-limited).
2. Design ID from Canva URL (`/design/<DESIGN_ID>/...`).

If `editor-page.full.html` is truncated, keep `editor-page.reconstructed.html` in the same source folder; the runner auto-falls back to it.

## Quick Start

Run from repo root:

```bash
node canva-template-workspace/scripts/clone-workspace.mjs \
  --design-id <DESIGN_ID> \
  --input-html <PATH_TO_EDITOR_PAGE_FULL_HTML>
```

### One-Line Agent Command (Recommended)

Use this when you do not want to pass long options each time:

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs --design-id <DESIGN_ID>
```

Optional:

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs \
  --url "https://www.canva.com/design/<DESIGN_ID>/..." \
  --input-html <PATH_TO_EDITOR_PAGE_FULL_HTML>
```

Defaults come from:

`canva-template-workspace/agent.config.json`

### Staged Workflow Commands

If you want manual stage control from chat:

1. Add entry only (no clone yet):

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs --action add --url "https://www.canva.com/design/<DESIGN_ID>/..."
```

2. Clone/extract only (downloads JSON/assets):

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs --action clone --design-id <DESIGN_ID> --input-html <PATH_TO_EDITOR_PAGE_FULL_HTML>
```

3. Generate only (from existing extracted data):

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs --action generate --design-id <DESIGN_ID>
```

4. Full pipeline in one shot:

```bash
node canva-template-workspace/scripts/agent-canva-clone.mjs --action run --design-id <DESIGN_ID> --input-html <PATH_TO_EDITOR_PAGE_FULL_HTML>
```

### Dashboard

Every agent run auto-updates:

- `canva-template-workspace/dashboard.html`

This single dashboard file shows all design entries with:
- status (`pending`, `cloning`, `cloned`, `generating`, `success`, `failed`, `duplicate`)
- source URL
- input HTML path
- weighted score/quality-gate result (global RMSE + edge-weighted RMSE)
- output HTML path
- workspace summary path
- last error (if failed)

Example:

```bash
node canva-template-workspace/scripts/clone-workspace.mjs \
  --design-id DAHN7DOKt8M \
  --input-html .tmp/canva-template-json/DAHN7DOKt8M/editor-page.full.html
```

## What Runner Does

1. Copies the source HTML into `designs/<DESIGN_ID>/capture/`.
2. Extracts JSON/assets into `designs/<DESIGN_ID>/extract/`.
3. Checks duplicate fingerprints against `index/template-dedupe-index.json`.
4. Generates final pure HTML:
   - preferred: auto-tuned mode with reference-page scoring (global + edge-weighted RMSE)
   - fallback: direct pure-HTML render from `template-data.json` when reference pages are missing
5. Writes `designs/<DESIGN_ID>/workspace-summary.json`.
6. Downloads local font files to `extract/assets/fonts/` and uses them in rendered HTML.

## Optional Flags

- `--workspace-root <path>`: override workspace root folder.
- `--dedupe-mode skip|continue|off`:
  - `skip` (default): if duplicate template is detected, skip heavy clone generation.
  - `continue`: process even if duplicate is detected.
  - `off`: disable dedupe.
- `--target-rmse <number>`: quality gate for auto-tune (example: `0.16`).
- `--stop-on-target true|false`:
  - `true` (default): stop early once a candidate meets `target-rmse`.
  - `false`: evaluate all candidate profiles and pick global best.

## Folder Contract

```text
canva-template-workspace/
  README.md
  scripts/
    agent-canva-clone.mjs
    clone-workspace.mjs
    prune-workspace.mjs
    canva/
      ...
  index/
    template-dedupe-index.json
  designs/
    <DESIGN_ID>/                  # single self-contained folder
      capture/
        editor-page.full.html
      extract/
        bootstrap.json
        template-data.json
        template-signature.json
        assets/
          fonts/
            font-manifest.json
      final/
        template-clone-pure-html.html
      index/
        template-dedupe-index.json # snapshot copy
      runs/
        latest.json
        index.json
        <run-id>/
          artifacts/
          logs/
          final/
            template-clone-pure-html.html
          report.json
      workspace-summary.json
```

## How Duplicate Detection Works

Duplicates are identified by template fingerprint, not URL.

Each extracted template creates:
- `exactHash`: strict signature including structure/style refs.
- `layoutHash`: structural signature tolerant to ID-level differences.

If either hash already exists in `index/template-dedupe-index.json` for another design ID, it is treated as duplicate.

## Outputs You Usually Need

1. Final clone HTML:  
   `designs/<DESIGN_ID>/final/template-clone-pure-html.html`
2. Run diagnostics:  
   `runs/<DESIGN_ID>/runs/latest.json` and latest run `report.json`
3. Extracted raw data:  
   `designs/<DESIGN_ID>/extract/template-data.json`
4. Duplicate mapping:  
   `index/template-dedupe-index.json`

## Workspace Hygiene

Prune historical run folders while keeping the latest N per design:

```bash
node canva-template-workspace/scripts/prune-workspace.mjs --keep-runs 2
```

## Handoff To Other AI

Share only `canva-template-workspace/` and this command:

```bash
node scripts/clone-workspace.mjs --design-id <DESIGN_ID> --input-html <editor-page.full.html>
```

That is enough context for another AI/tool to continue the same workflow.
