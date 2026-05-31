# Implementation Plan — Cross-harness canonical names + setup docs (v2.10.1 Bundle A)

**Workflow:** `refactor-v2-10-1-milestone` · **Track:** overhaul · **Design:**
[`2026-05-31-cross-harness-canonical-names.md`](./2026-05-31-cross-harness-canonical-names.md)
**Issues:** #1472, #1471

Verified facts grounding this plan (per-runtime command-autoload investigation done upfront):
- **opencode** ✅ — autoloads commands from `~/.config/opencode/commands/` (global) and
  `.opencode/commands/` (project); markdown + YAML frontmatter (`description`, `agent`,
  `model`, `subtask`); body is the prompt template, supports `$ARGUMENTS`. Gives the bare
  canonical name `/ideate`. (opencode.ai/docs/commands)
- **codex** ⚠️ — custom prompts (`~/.codex/prompts/*.md`, frontmatter + `$ARGUMENTS`) exist
  but are **deprecated** (OpenAI now recommends *skills* for reusable instructions) **and**
  are invoked namespaced as `/prompts:<name>`, i.e. `/prompts:ideate` — not the bare
  canonical name. Emitting deprecated, non-bare aliases is low value. (developers.openai.com/codex/custom-prompts)
- **copilot** ❌ — Copilot CLI has **no custom-command autoload**; custom slash commands from
  a prompts dir are an open feature request (github/copilot-cli #618, #1113). Only VS Code
  reads `.github/prompts/*.prompt.md`. Cannot emit working CLI aliases today.
- **cursor / generic** — `hasSlashCommands: false`; no command surface at all.
- **Conclusion:** opencode is the *only* runtime that can take a clean canonical alias this
  cycle. This is a verified decision, not a deferral.
- `CHAIN` already references canonical names; the gap is that those names aren't installed
  off the Claude path → INV-4 parity gap, not cosmetic.

## Tasks (TDD, dependency-ordered)

### T1 — Canonical↔skill map as source-of-truth + drift guard  *(no deps)*
- **RED:** `src/config/canonical-skills.test.ts` parses every `commands/*.md` "Skill
  Reference" (`@skills/<dir>/SKILL.md`) and asserts it agrees with the map; commands with
  no skill (`rehydrate`, `tag`, `autocompact`) are declared command-only; `review` maps to
  both `spec-review` + `quality-review`.
- **GREEN:** `src/config/canonical-skills.ts` exporting `COMMAND_TO_SKILL` (+ the
  command-only set). Guard green.
- **Files:** 2 new. Blast radius: tiny. Foundation for T2/T5.

### T2 — Emit canonical-name alias artifacts (opencode) during build  *(deps: T1)*
Scope is **opencode-only**, decided by the verified investigation above (codex aliases are
deprecated + namespaced; copilot CLI has no autoload; cursor/generic have no command surface).
The gating is driven by an explicit per-runtime capability, not a hardcoded "opencode" check —
so adding a future runtime is a data change.
- **RED:** test that the builder emits a canonical alias command file per `COMMAND_TO_SKILL`
  entry **only** for runtimes flagged as supporting bare canonical command-aliases (opencode
  today); emits nothing for cursor/generic/codex/copilot. Shape/snapshot test on the
  generated tree.
- Add an explicit capability to `runtimes/*.yaml` (e.g. `capabilities.canonicalCommandAliases:
  true` on opencode only) so the builder gates on declared capability, not a name literal —
  upholds INV-4 (no harness coupling in logic).
- **GREEN:** extend `src/build-skills.ts` (or new `src/build-command-aliases.ts`) to render
  alias files to a generated tree `command-aliases/<runtime>/<canonical>.md`. Each alias =
  frontmatter (`description` lifted from the command) + body that invokes the underlying
  skill via the runtime's skill-invoke convention (the `CHAIN`/skill directive), passing
  `$ARGUMENTS`.
- **Files:** `src/build-skills.ts` (+ optional new module), tests, generated
  `command-aliases/opencode/*.md`. Medium.

### T3 — install-skills installs aliases + prints destination/restart  *(deps: T2)*
- **RED:** test that `install-skills --agent opencode` copies `command-aliases/opencode/*`
  to opencode's `commandsInstallPath` and prints the destination path + restart hint
  (the #1471 nice-to-have).
- **GREEN:** add `commandsInstallPath: "~/.config/opencode/commands"` to
  `runtimes/opencode.yaml`; wire copy + post-install summary in `src/install-skills.ts`.
- **Files:** `src/install-skills.ts`, `runtimes/opencode.yaml`, tests. Medium.

### T4 — Guard regenerated aliases against drift  *(deps: T2)*
- **RED/GREEN:** extend the existing `skills:guard` re-render+`git diff` to also cover
  `command-aliases/**` (or add an analogous `aliases:guard`); wire into `build` + CI the
  same way `skills:guard` is. Drift fails CI.
- **Files:** guard script + `package.json`. Small.

### T5 — Harness setup docs (#1471)  *(deps: T1 for names; T2/T3 for accurate behavior)*
- Add a per-runtime matrix + sections to `documentation/guide/installation.md`:
  config-file location, MCP config shape (opencode stdio `config.json` from the issue),
  stdio-vs-port, skill install command + destination (`skillsInstallPath`), restart
  requirement — for opencode/codex/cursor/copilot/generic. Document the canonical-name
  behavior, **which runtimes get canonical aliases (opencode) and which don't yet**
  (codex/copilot pending; cursor/generic by-design no-commands), and the chaining-name
  caveat for the latter. No silent caps — state coverage explicitly. Use the verified
  per-runtime findings (top of doc): opencode = bare canonical aliases; codex = deprecated
  namespaced prompts, skills recommended (link developers.openai.com/codex/custom-prompts);
  copilot = no CLI autoload yet (link github/copilot-cli #618, #1113); cursor/generic = skill
  descriptive name is the entry point + chaining-name caveat.
- **Files:** `documentation/guide/installation.md`. Docs.

*(Former T6 "verify codex/copilot" resolved upfront — see verified facts at top. No separate
research task; its findings are folded into T2 scope and T5 docs.)*

## Sequencing for delegation
- Wave 1: **T1** (foundation).
- Wave 2: **T2** (after T1).
- Wave 3: **T3** + **T4** (after T2).
- Wave 4: **T5** docs (after behavior is real).

## Definition of done
- `COMMAND_TO_SKILL` is the single SoT; commands prose can't drift (CI guard).
- opencode users invoke `/ideate`,`/plan`,… and the auto-chain resolves on opencode.
- `install-skills` prints destination + restart hint.
- `installation.md` documents all five non-Claude runtimes + alias coverage + caveats.
- INV-4 conformance: no Claude-only leak; `skills-src/` + `runtimes/` + map are SoT;
  generated trees (`skills/**`, `command-aliases/**`) are never hand-edited.
- `npm run build`, `typecheck`, `test:run`, `skills:guard` all green.
