# Cross-harness canonical workflow names + setup docs (v2.10.1 Bundle A)

**Workflow:** `refactor-v2-10-1-milestone` (overhaul track)
**Issues:** #1472 (consistent workflow names across harnesses), #1471 (harness-specific setup docs)
**Date:** 2026-05-31
**Status:** brief → plan

## Problem

Claude Code users invoke canonical workflow names — `/exarchos:ideate`, `/exarchos:plan`,
`/exarchos:delegate`, … — sourced from `commands/*.md`. Non-Claude runtimes
(opencode, codex, copilot, cursor, generic) receive **no command layer**; they get only
the skills, installed under their *descriptive* directory names (`brainstorming`,
`implementation-planning`, `delegation`, …). So the same workflow has a different
user-facing name depending on the harness.

This is more than cosmetic. The auto-chain directive is rendered from the `CHAIN`
placeholder, which already references **canonical** names:

- `claude.yaml`: `CHAIN: 'Skill({ skill: "exarchos:{{next}}", args: "{{args}}" })'`
- `opencode.yaml`: `CHAIN: "[Invoke the exarchos:{{next}} skill with args: {{args}}]"`

`{{next}}` is substituted with canonical names (`ideate`→`plan`→`delegate`). On Claude
this resolves (commands exist). On non-Claude runtimes the referenced skill name
(`exarchos:plan`) **is not installed** — the installed skill is `implementation-planning`.
The chaining guarantee therefore does not hold off the Claude path.

**Invariant framing — INV-4 (platform-agnosticity):** the six runtimes are first-class;
a workflow affordance that exists on Claude must exist on every runtime's path. Today the
canonical-name affordance (and the chaining that depends on it) leaks Claude-only. This
bundle closes that parity gap. Source-of-truth edits stay in `skills-src/` / `runtimes/` /
a new map module; generated `skills/<runtime>/**` is never hand-edited.

## Current state (verified)

- The canonical↔skill mapping exists **only as prose** — one `@skills/<dir>/SKILL.md`
  line per `commands/*.md`. No structured/declarative table anywhere.
- `src/build-skills.ts` renders `skills-src/` → `skills/<runtime>/<skill>/SKILL.md`. It
  emits **nothing** from `commands/`; commands are Claude-only and are loaded by the
  plugin manifest (`.claude-plugin/plugin.json`), not by the renderer.
- `src/install-skills.ts` copies skills (or shells out to `npx skills add`); it installs
  **no command artifacts**.
- `hasSlashCommands` is `true` for claude, opencode, codex, copilot; `false` for cursor,
  generic. Only claude is wired today.
- Per-runtime command-autoload location/format is **undocumented in this repo** for
  opencode/codex/copilot. opencode is the only one proven (the #1472 reporter hand-authored
  opencode command aliases that worked).

## Goals

1. **Single source-of-truth** for the canonical↔skill map, replacing 17 scattered prose
   references as the authority, with a guard that every `commands/*.md` "Skill Reference"
   line agrees with the map (drift fails CI, mirroring `skills:guard`).
2. **Canonical-name aliases on non-Claude runtimes** so users invoke `ideate`/`plan`/… and
   so the `CHAIN` directive resolves — emitted by the build, installed by `install-skills`,
   only for runtimes whose command-autoload convention is known and verified.
3. **Harness-specific setup docs** (#1471) in `documentation/guide/installation.md`:
   per-runtime config-file location, MCP config shape, stdio vs port, skill install command
   + destination, restart requirement — plus the canonical-name behavior and any caveat
   for runtimes where aliases are not yet emitted.

## Approach

### Map as source-of-truth (low risk)
Add `src/config/canonical-skills.ts` exporting `COMMAND_TO_SKILL` (canonical name →
skill dir; `review` maps to both `spec-review` + `quality-review`; `rehydrate`/`tag`/
`autocompact` have no skill and are command-only). Add a guard test that parses each
`commands/*.md` "Skill Reference" line and asserts agreement with the map — so the map and
the prose can never drift.

### Alias emission (scoped to proven runtimes)
During `npm run build:skills`, for runtimes with `hasSlashCommands: true` **and** a known
command-autoload convention, emit canonical-name alias artifacts (lightweight command files
that delegate to the underlying skill, mirroring the reporter's proven opencode setup).
`install-skills` installs them to the runtime's command dir.

- **opencode** — verify exact dir/format (`~/.config/opencode/command/*.md` expected;
  the reporter proved aliases work). Emit + install.
- **codex/copilot** — `hasSlashCommands: true` but command-autoload convention unconfirmed
  in-repo. **Do not emit broken artifacts.** Confirm the convention; if confirmed, emit; if
  not, document the gap (#1471) and leave for a follow-up. No silent cap — the docs state
  exactly which runtimes get canonical aliases and which don't yet.
- **cursor/generic** — `hasSlashCommands: false`; no alias layer. Document that the skill's
  descriptive name is the entry point, and note the chaining-name caveat.

### Docs (#1471)
Add a per-runtime matrix + short sections to `documentation/guide/installation.md`, sourced
from `runtimes/*.yaml` (skillsInstallPath, mcpPrefix, preferredFacade) and the facade doc.
Include the opencode MCP `config.json`/stdio example from the issue, the install command,
the destination path, and the restart hint. Optionally have `install-skills` print the
destination + restart hint after install (the issue's nice-to-have).

## Out of scope / explicitly deferred
- **#1485** (SessionStart hook + SessionEnd) — Bundle B, separate workflow. Part (b) decided:
  **keep** SessionEnd provenance telemetry (recorded on the issue).
- **#1473** (Category-C auto-emission) — deferred to **#1258 / v3.0.0**; needs a runbook
  executor that does not exist today. Moved off this milestone.

## Risks
- **Per-runtime command-autoload format** for opencode/codex/copilot is the only real
  unknown; the plan must verify before emitting, never ship broken alias pointers.
- Doubling user-facing names (descriptive skill + canonical alias) could confuse — mitigate
  by making the alias a thin delegator and documenting the relationship.
