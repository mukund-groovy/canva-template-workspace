# Superseded

This single-agent spec has been split into two agents:

- **`design-clone-agent`** (`.claude/agents/design-clone-agent.md`) — reference intake only:
  a design URL in, page thumbnails + `template-data.json` out. It never writes a template.

- **`template-author-agent`** (`.claude/agents/template-author-agent.md`) — authors
  `backend/database/carousels/<slug>.html` from that intake, generates its photos, and gates
  the result on `verify-slides.mjs` + `brand-audit.mjs` before seeding.

The old "icons must never be 1:1 / use a different object family" rule in this file was WRONG
and produced rejected output twice. The rule is now: **preserve the layout and the object
roles; change the copy and the photo subjects.** See `template-author-agent.md`.
