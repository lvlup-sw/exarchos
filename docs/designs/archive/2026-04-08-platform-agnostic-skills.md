# Design: Platform-Agnostic Skills Distribution

**Feature ID:** `platform-agnostic-skills`
**Workflow type:** feature
**Status:** Design phase
**Date:** 2026-04-08

---

## Problem Statement

Exarchos distributes its SDLC workflow instruction layer (16 skills + 17 slash commands) as a Claude Code plugin. While the Exarchos CLI itself is already platform-agnostic and the skill *file format* is already agentskills.io-compatible, the **content** of each skill body is threaded with Claude-Code-specific constructs that do not work on other MCP-capable hosts:

1. **MCP tool prefixes** — bodies hard-code `mcp__plugin_exarchos_exarchos__*` (a Claude Code plugin naming convention). Other runtimes use different prefixes.
2. **Auto-chain syntax** — skills chain to the next phase via `Skill({ skill: "exarchos:plan", args: "..." })`, a Claude Code-only tool call. No equivalent exists in Codex, Copilot CLI, OpenCode, or Cursor.
3. **Slash command entry points** — `/exarchos:ideate` dispatch through `commands/*.md` is Claude Code's specific slash-command format.
4. **Delegation primitives** — `skills/delegation/SKILL.md` hand-rolls dual-tracked "Claude Code native" vs. "Cross-platform" sections inside one file, an unscalable pattern.
5. **Installer target** — `src/install.ts` symlinks to `~/.claude/` and writes `~/.claude.json`, hardcoding Claude Code's layout.

The user experience we want: a developer running Codex, Copilot CLI, OpenCode, or Cursor installs Exarchos and gets a full, working feature workflow (ideate → plan → delegate → review → synthesize → cleanup) **with the same fidelity as Claude Code**, using each runtime's native primitives where they exist. This document specifies how to migrate the instruction layer to meet that goal without duplicating source content or inventing abstractions that runtimes already provide.

---

## Approaches Explored

Three authoring models were considered during brainstorming. All three share the same distribution shape (monorepo, `skills-src/` → build step → committed `skills/<runtime>/` variants, `exarchos install-skills` wraps `npx skills add`). They differ in how the build step sees skill source and how much runtime-specific logic survives in the skill body.

### Option 1: Thin Substitution + MCP Encapsulation

**Approach:** The skill body is runtime-neutral prose + a small placeholder vocabulary (`{{MCP_PREFIX}}`, `{{CHAIN}}`, `{{SPAWN_AGENT_CALL}}`). A per-runtime YAML map provides the substitution values. The build step is ~150 LOC of plain regex-based rendering with argument parsing.

**Pros:**
- Lowest tooling cost; trivial renderer; no external template engine
- Skills remain single-author, single-file, readable
- Adding a new runtime is a YAML file + (optional) CLI adapter; no code changes
- Drift is impossible at the skill-body level
- Build step is easy to debug and snapshot

**Cons:**
- Substitution alone cannot express structurally divergent bodies (different step ordering, different gates)
- Forces more logic into MCP handlers where complex abstractions are needed
- Requires discipline to keep source bodies runtime-neutral

**Best when:** runtime divergence is mostly surface syntax (tool prefixes, chain syntax, command names) and hard primitives can be abstracted or are natively available in each target. Recon showed this matches Exarchos's current situation.

### Option 2: Fragment Library + Capability Matrix

**Approach:** Skills are assembled from fragments at build time. `skills-src/<skill>/` contains `base.md` plus feature-keyed fragment files (e.g., `fragments/spawn.claude.md`, `fragments/spawn.codex.md`). A central `runtimes/<runtime>.json` capability map picks which fragment to include per feature. Build step uses a partials-capable template engine (Handlebars/Eta) at ~200 LOC + dependency.

**Pros:**
- Scales to genuinely divergent bodies across runtimes
- Each fragment is small and independently testable
- Fragment reuse across runtimes (e.g., OpenCode and Codex can share identical shell-out fragments)
- `grep fragments/spawn.*` surfaces every spawn implementation

**Cons:**
- File count grows fast: ~16 skills × ~4 feature axes × ~5 variants → 100+ fragment files
- Navigating "what does the Codex variant look like?" requires mental assembly until build runs
- Harder to spot base/fragment composition issues without executing the build

**Best when:** skill bodies genuinely diverge in structure (not just syntax) across runtimes.

### Option 3: Capability DSL (Maximalist)

**Approach:** Skills are written against a canonical capability vocabulary, not runtime syntax. Source uses directives like `:::capability workflow.spawn-agents prompt="..." :::`. Each runtime maintains a capability library (`runtimes/<runtime>/capabilities/*.mdx`) defining how each capability renders. Build step is a full template engine + capability resolver + lint pass, ~500 LOC + dependencies + unit tests for the renderer itself.

**Pros:**
- Skills become a formal, runtime-independent specification of the workflow
- Runtime surface is completely encapsulated; adding a new runtime = writing a capability library, no skill edits
- The only approach that scales gracefully to 30+ runtimes

**Cons:**
- Heaviest tooling lift by far
- Requires disciplined authors who think in capabilities, plus docs for the capability vocabulary
- Requires rewriting every current skill body against the canonical form
- High risk of bike-shedding capability names; longer delivery horizon

**Best when:** platform-agnosticity is a strategic long-term commitment worth investing in compiler-frontend-grade tooling; overkill for v1 unless pushing upstream to agentskills.io.

## Chosen Approach

**Option 1 — Thin Substitution + Native Delegation Per Runtime.**

Skills are authored once in `skills-src/` using a small placeholder vocabulary (`{{MCP_PREFIX}}`, `{{CHAIN}}`, `{{SPAWN_AGENT_CALL}}`, etc.). A build step (`npm run build:skills`) reads each skill plus a per-runtime substitution map (`runtimes/<runtime>.yaml`) and emits six variants of every skill into `skills/<runtime>/<skill>/SKILL.md` for five Tier-1 runtimes (Claude Code, Copilot CLI, Codex, OpenCode, Cursor) plus a `generic` fallback. The generated trees are committed to git so `npx skills add` can read them directly. The Exarchos CLI wraps installation: `exarchos install-skills` detects the target runtime and shells out to `npx skills add github:lvlup-sw/exarchos skills/<runtime>`.

**Rationale:**

1. **Native primitives per runtime.** Context7 research confirmed 4 of 5 Tier-1 runtimes have first-class subagent delegation: Claude Code (`Task`), OpenCode (`Task`, literally identical), Codex (multi-agent spawn), Copilot CLI (`/delegate`, `/agent`). No common abstraction needs to be invented. Each runtime's placeholder substitution injects its own native syntax. Only Cursor CLI lacks in-session delegation and falls back to the generic sequential variant.
2. **Scope matches complexity.** The existing `skills/delegation/SKILL.md` review showed ~70% of body content is already runtime-neutral prose; the Claude-specific parts are surface-level syntax. Heavier approaches (fragment library, capability DSL) solve problems we don't have.
3. **Single source of truth.** Drift is impossible — all five Tier-1 variants derive from one `skills-src/` tree via deterministic rendering.
4. **No upstream blockers.** vercel-labs/skills consumes the generated directories as-is; no contributions required. The Exarchos CLI owns runtime detection, which keeps the UX smart without forking upstream.
5. **Generic fallback is free.** `runtimes/generic.yaml` with conservative values produces an LCD variant automatically, satisfying the non-Tier-1 commitment.

---

## Requirements

### DR-1: Single-source authoring in `skills-src/`

All skill content — frontmatter, process documentation, references — lives in exactly one place per skill: `skills-src/<skill>/SKILL.md`. Reference files (`references/*.md`) live in `skills-src/<skill>/references/`. Authors edit only `skills-src/`. The legacy `skills/` tree at repository root is deleted once migration completes.

- Acceptance criteria:
  - Given a new skill authored in `skills-src/<name>/SKILL.md`
  When `npm run build:skills` runs
  Then exactly six variants appear at `skills/{claude,copilot,codex,opencode,cursor,generic}/<name>/SKILL.md`
  And the generated content is deterministic across runs (byte-for-byte stable)
- Editing a file in `skills/<runtime>/` directly is detected by CI: a `skills:guard` check fails if any file under `skills/<runtime>/` has a mtime newer than the corresponding `skills-src/` source without a matching build artifact.
- Reference files under `skills-src/<skill>/references/` are copied unchanged to each variant's `references/` subdirectory (they contain pedagogical content, not runtime logic).

### DR-2: Build step with placeholder substitution

A new `npm run build:skills` target reads each source skill, substitutes placeholders according to the active runtime's map, and writes the result to `skills/<runtime>/<skill>/SKILL.md`. The build step is pure-TypeScript, has no runtime dependencies beyond `js-yaml`, and is integrated into `npm run build` so `dist/` and `skills/<runtime>/` are always consistent.

- Acceptance criteria:
  - Given `skills-src/delegation/SKILL.md` containing `{{SPAWN_AGENT_CALL}}` and `runtimes/claude.yaml` defining `SPAWN_AGENT_CALL` as a Claude `Task({...})` call
  When the build step runs
  Then `skills/claude/delegation/SKILL.md` contains the resolved `Task({...})` syntax with no placeholder residue
- An unresolved placeholder (present in source but absent from the runtime map) causes a hard build failure with a message naming the skill, the placeholder, and the runtime.
- Build output is idempotent: running `npm run build:skills` twice in a row produces no diff in `skills/<runtime>/`.
- `npm run build` invokes `npm run build:skills` so the generated tree is always in sync with the MCP server bundle.

### DR-3: Placeholder vocabulary (canonical)

The placeholder vocabulary is small, documented, and stable. Authors use only these tokens; adding a new one requires updating `docs/references/placeholder-vocabulary.md`.

**Initial vocabulary:**
- `{{MCP_PREFIX}}` — MCP tool name prefix (e.g., `mcp__plugin_exarchos_exarchos__` for Claude Code, `mcp__exarchos__` for generic)
- `{{CHAIN next="<skill>" args="<expr>"}}` — auto-chain invocation; resolves to native sub-skill invocation or prose fallback
- `{{SPAWN_AGENT_CALL}}` — delegation/spawn syntax block (multi-line)
- `{{COMMAND_PREFIX}}` — slash command prefix (e.g., `/exarchos:`, `/`, empty string)
- `{{TASK_TOOL}}` — the tool name used for background task operations (`Task`, `/delegate`, etc.)

- Acceptance criteria:
  - Given a skill body containing `{{MCP_PREFIX}}orchestrate`
  When built for `claude`
  Then the output contains `mcp__plugin_exarchos_exarchos__orchestrate`
  And when built for `generic`, the output contains `mcp__exarchos__orchestrate`
- The `{{CHAIN}}` placeholder supports named arguments and expands differently for runtimes that have native sub-skill invocation (Claude Code: `Skill({...})`) versus those that don't (Codex, Cursor: prose "invoke the <skill> skill next").
- Adding a new placeholder requires a PR that updates the vocabulary doc; a build-time lint rejects unknown placeholders.

### DR-4: Runtime capability matrix

A `runtimes/<runtime>.yaml` file per Tier-1 runtime (plus `generic.yaml`) defines the substitution map and a declarative capability matrix (`hasSubagents`, `hasSlashCommands`, `hasHooks`, `hasSkillChaining`, `mcpPrefix`, `skillsInstallPath`). The build step reads these and the Exarchos CLI consults the same files for runtime detection and install-path routing.

- Acceptance criteria:
  - `runtimes/` contains exactly six files: `claude.yaml`, `copilot.yaml`, `codex.yaml`, `opencode.yaml`, `cursor.yaml`, `generic.yaml`.
- Each file validates against `runtimes/schema.json` (Zod-checked at build time).
- The capability matrix is the single source of truth: `skillsInstallPath` is the path `npx skills add` should write to (e.g., `~/.claude/skills/` for Claude Code, `~/.config/opencode/skills/` for OpenCode); `mcpPrefix` is used by `MCP_PREFIX` placeholder resolution; `hasSubagents=false` triggers the sequential fallback for `SPAWN_AGENT_CALL`.
- Adding a new runtime = adding one YAML file + running the build; no code changes required.

### DR-5: Native delegation per runtime (no custom primitive)

The `skills-src/delegation/SKILL.md` body is stripped of all runtime branching. Delegation uses `{{SPAWN_AGENT_CALL}}` which each runtime map resolves to its own native syntax. The Exarchos MCP server does **not** grow a `spawn_agent` composite action; the existing worktree/monitoring handlers remain runtime-neutral.

- Acceptance criteria:
  - `skills-src/delegation/SKILL.md` contains **zero** occurrences of `Task({`, `/delegate`, `subagent_type`, or any runtime-native delegation syntax — only `{{SPAWN_AGENT_CALL}}`.
- `runtimes/claude.yaml` `SPAWN_AGENT_CALL` renders to `Task({ subagent_type: "exarchos-implementer", run_in_background: true, ... })`.
- `runtimes/opencode.yaml` `SPAWN_AGENT_CALL` renders to an OpenCode `Task({ subagent_type: "...", prompt: "..." })` call matching OpenCode's tool signature.
- `runtimes/codex.yaml` `SPAWN_AGENT_CALL` renders to Codex's multi-agent spawn invocation (exact syntax captured from `codex-rs/core/templates/collab/experimental_prompt.md` — see Open Questions).
- `runtimes/copilot.yaml` `SPAWN_AGENT_CALL` renders to `/delegate "<task description>"`.
- `servers/exarchos-mcp/src/orchestrate/` gains **no new handler** for agent spawning (validated by diff review).

### DR-6: Cursor delegation fallback policy

Cursor CLI has no in-session subagent primitive. For Cursor (and the generic variant), `SPAWN_AGENT_CALL` renders to a **sequential execution** directive: the skill tells the host agent to execute each task in the current session, one at a time, against the prepared worktrees. Worktrees are still created by `prepare_delegation`, but the agent visits each worktree in turn rather than spawning parallel workers.

- Acceptance criteria:
  - Given the Cursor variant of `delegation/SKILL.md`
  When an agent executes the dispatch step
  Then the body instructs sequential execution with a single in-session loop over `worktrees[]`
  And the body explicitly notes "delegation runs sequentially on Cursor due to no native subagent primitive"
- The delegation skill's completion semantics are identical for sequential runs: all tasks must still pass gates before the `delegate → review` transition fires.
- A user-visible warning is emitted once per session when Cursor executes delegation, linking to the rationale in the reference docs.

### DR-7: `exarchos install-skills` CLI command

The Exarchos CLI gains a new subcommand `exarchos install-skills [--agent <runtime>]` that detects the active agent, maps it to a `runtimes/<runtime>.yaml` entry, and invokes `npx skills add github:lvlup-sw/exarchos skills/<runtime>` with the correct target path from the capability matrix. If no Tier-1 runtime is detected, it installs `skills/generic/` and prints guidance.

- Acceptance criteria:
  - Given a user running `exarchos install-skills` on a machine with the Claude Code CLI installed
  When the command runs
  Then the CLI prints `"Detected: claude. Installing Exarchos skills for Claude Code..."` and invokes `npx skills add github:lvlup-sw/exarchos skills/claude`
- Given the user passes `--agent codex` explicitly
  Then runtime detection is skipped and the codex variant is installed regardless of what's present on the machine.
- Given no supported agent is detected and no `--agent` flag is passed
  Then the CLI installs `skills/generic/` and prints a message naming the fallback plus a link to the supported runtime list.
- The command prints the underlying `npx skills add` command before executing it (transparency).
- The command exits non-zero if `npx skills add` fails and propagates the child process's stderr.

### DR-8: Migration completeness (all 16 skills × 5 runtimes)

Every existing skill under `skills/` is migrated to `skills-src/` and rebuilt into all six variants. No skill is left in the legacy tree. The pre-existing `commands/*.md` slash-command files are similarly migrated: the ones that are thin dispatchers become per-runtime variants under `skills-src/<skill>/commands/` (if commands are a first-class concept for that runtime) or collapsed into the skill body's trigger section.

- Acceptance criteria:
  - Given the repository post-migration
  When `find skills -name SKILL.md -type f` runs
  Then the output contains exactly `16 * 6 = 96` files (16 skills × 6 variants)
- Given each of the 5 Tier-1 runtime variants
  When an integration smoke test runs `ideate → plan → delegate → review → synthesize → cleanup` on a dummy feature
  Then the workflow completes on each runtime with green gates (one real run per runtime in CI; Cursor runs with sequential delegation)
- The legacy `skills/` top-level source tree is removed; the post-migration `skills/` contains only generated subdirectories.
- The legacy `commands/` directory is either removed or retained as a Claude Code-only shim (decision deferred to Open Questions).

### DR-9: Skill installation paths per runtime

The build step's output under `skills/<runtime>/` is named such that `npx skills add github:lvlup-sw/exarchos skills/<runtime>` works with vercel-labs/skills' subdirectory source selection. The install path *on the user's machine* comes from the runtime's `skillsInstallPath` capability (e.g., `~/.claude/skills/`, `~/.config/opencode/skills/`, `.agents/skills/` for Codex).

- Acceptance criteria:
  - Given `runtimes/claude.yaml` declares `skillsInstallPath: "~/.claude/skills"`
  When `exarchos install-skills --agent claude` runs
  Then `npx skills add` is invoked with a target that resolves to `~/.claude/skills/` and the skills are written there.
- Given `runtimes/opencode.yaml` declares `skillsInstallPath: "~/.config/opencode/skills"`
  Then OpenCode install routes there.
- Given `runtimes/codex.yaml` declares `skillsInstallPath: "$HOME/.agents/skills"` (per Codex's agentskills discovery)
  Then Codex install routes there.
- Install paths are documented in the README install section and the CLI `--help` output.

### DR-10: Error handling and edge cases

The build system and install CLI fail loud and early with actionable messages. The design anticipates the following boundary and failure conditions.

- Acceptance criteria:
  - Given a source skill contains `{{UNKNOWN_TOKEN}}` not in any runtime map
    When `npm run build:skills` runs
    Then the build fails with `Error: unknown placeholder {{UNKNOWN_TOKEN}} in skills-src/<skill>/SKILL.md:<line>` naming the skill, placeholder, and line number, plus the list of known placeholders and remediation guidance.
  - Given `runtimes/codex.yaml` is missing `SPAWN_AGENT_CALL` which is used in `skills-src/delegation/SKILL.md`
    When the build runs
    Then it fails with `Error: runtime "codex" missing substitution for placeholder {{SPAWN_AGENT_CALL}}` naming the runtime, placeholder, and source file.
  - Given `runtimes/copilot.yaml` omits a required capability field
    When the build step validates the file
    Then Zod reports the exact missing path with a human-readable error and the build exits non-zero.
  - Given a developer edits `skills/claude/delegation/SKILL.md` directly (not via source)
    When CI runs the `skills:guard` check
    Then the check re-runs the build and fails if the working tree diff is non-empty, printing remediation guidance to run `npm run build:skills` and commit the result.
  - Given `exarchos install-skills` is run offline or with a network error
    When `npx skills add` fails
    Then the CLI surfaces stderr verbatim, exits with the child's exit code, and prints the exact `npx skills add` command so the user can retry manually.
  - Given multiple supported agent CLIs are present on the machine
    When `exarchos install-skills` runs without `--agent`
    Then the CLI prints the detected candidates and prompts the user to disambiguate interactively, or exits non-zero with remediation guidance in non-interactive / `--yes` mode.
  - Given `exarchos install-skills --agent unknown`
    When the CLI runs
    Then it prints `Unknown runtime: "unknown". Supported: claude, copilot, codex, opencode, cursor, generic.` and exits non-zero.
  - Given a user runs the delegation skill on Cursor with multiple tasks
    When the skill body executes
    Then it explicitly warns once that delegation is running sequentially, completes all tasks in order, and passes the same quality gates as parallel runs.

---

## Technical Design

### Monorepo layout (post-migration)

```
exarchos/
├── skills-src/                         # ← canonical authoring (new)
│   ├── brainstorming/
│   │   ├── SKILL.md                    # source with {{placeholders}}
│   │   └── references/
│   ├── delegation/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── ... (14 more)
│   └── _shared/                        # shared reference fragments
├── skills/                             # ← generated (committed to git)
│   ├── claude/
│   │   ├── brainstorming/SKILL.md      # rendered for Claude Code
│   │   ├── delegation/SKILL.md
│   │   └── ...
│   ├── copilot/...
│   ├── codex/...
│   ├── opencode/...
│   ├── cursor/...
│   └── generic/...
├── runtimes/                           # ← new
│   ├── schema.json                     # Zod-generated JSON schema
│   ├── claude.yaml
│   ├── copilot.yaml
│   ├── codex.yaml
│   ├── opencode.yaml
│   ├── cursor.yaml
│   └── generic.yaml
├── src/
│   ├── build-skills.ts                 # ← new: the renderer
│   ├── install-skills.ts               # ← new: the install subcommand
│   ├── install.ts                      # existing, unchanged
│   └── runtimes/                       # ← new
│       ├── load.ts                     # YAML + Zod loader
│       ├── detect.ts                   # runtime detection
│       └── types.ts
├── servers/exarchos-mcp/               # unchanged — no new handlers
├── commands/                           # removed OR Claude-only shim
└── package.json                        # new scripts: build:skills, install-skills
```

### Build pipeline

```
skills-src/<skill>/SKILL.md  ──┐
                               │
runtimes/<runtime>.yaml     ───┼──►  render(src, map)  ──►  skills/<runtime>/<skill>/SKILL.md
                               │
skills-src/<skill>/references/ ┘        (copied verbatim)         + references/
```

### Renderer (`src/build-skills.ts`) — pseudocode

```typescript
interface RuntimeMap {
  name: string;
  placeholders: Record<string, string>;
  capabilities: CapabilityMatrix;
  skillsInstallPath: string;
}

function buildAllSkills(): void {
  const runtimes = loadAllRuntimes('runtimes/');  // 6 maps
  const sources = findSkillSources('skills-src/'); // 16 skill dirs

  for (const runtime of runtimes) {
    for (const src of sources) {
      const rendered = render(src.body, runtime.placeholders);
      assertNoUnresolvedPlaceholders(rendered, src.path, runtime.name);
      writeFile(`skills/${runtime.name}/${src.name}/SKILL.md`, rendered);
      copyReferences(src.references, `skills/${runtime.name}/${src.name}/references/`);
    }
  }
}

function render(body: string, placeholders: Record<string, string>): string {
  return body.replace(/\{\{(\w+)(?:\s+([^}]*))?\}\}/g, (match, token, args) => {
    if (!(token in placeholders)) throw new Error(`unknown placeholder ${match}`);
    return expandWithArgs(placeholders[token], parseArgs(args));
  });
}
```

**Notes:**
- The renderer is ~150 LOC. No external template engine; plain regex-based substitution with argument parsing for `{{CHAIN next="..." args="..."}}`.
- Multi-line placeholders (like `{{SPAWN_AGENT_CALL}}`) are stored as YAML block scalars in the runtime map.
- `assertNoUnresolvedPlaceholders` runs after render and throws if any `{{...}}` remains.

### Runtime YAML format (example — `runtimes/claude.yaml`)

```yaml
name: claude
capabilities:
  hasSubagents: true
  hasSlashCommands: true
  hasHooks: true
  hasSkillChaining: true
  mcpPrefix: "mcp__plugin_exarchos_exarchos__"
skillsInstallPath: "~/.claude/skills"
detection:
  binaries: ["claude"]
  envVars: ["CLAUDE_CODE_*"]
placeholders:
  MCP_PREFIX: "mcp__plugin_exarchos_exarchos__"
  COMMAND_PREFIX: "/exarchos:"
  TASK_TOOL: "Task"
  CHAIN: |
    Skill({ skill: "exarchos:{{next}}", args: {{args}} })
  SPAWN_AGENT_CALL: |
    Task({
      subagent_type: "exarchos-implementer",
      run_in_background: true,
      description: "Implement task-<id>: <title>",
      prompt: `[full implementer prompt]`
    })
```

### Install CLI (`src/install-skills.ts`)

```typescript
export async function installSkills(opts: { agent?: string }): Promise<void> {
  const runtimes = await loadAllRuntimes();
  const target = opts.agent
    ? runtimes.find(r => r.name === opts.agent) ?? fail(`unknown runtime: ${opts.agent}`)
    : (await detectRuntime(runtimes)) ?? runtimes.find(r => r.name === 'generic')!;

  console.log(`Installing Exarchos skills for ${target.name}...`);
  const source = `github:lvlup-sw/exarchos`;
  const subPath = `skills/${target.name}`;
  const destPath = expandHome(target.skillsInstallPath);

  const cmd = `npx skills add ${source} ${subPath} --target ${destPath}`;
  console.log(`$ ${cmd}`);
  await spawnPropagatingExit(cmd);
}
```

Runtime detection inspects `PATH` for known binaries, inspects env vars, and falls back to interactive prompt (or `generic` in non-interactive mode).

---

## Integration Points

### Existing `src/install.ts`

The existing installer (which configures Claude Code specifically: symlinks commands/skills/rules, registers MCP servers in `~/.claude.json`) is **not touched** by this feature. It remains the "Claude Code plugin installer" for users who want deep Claude Code integration. The new `exarchos install-skills` is an orthogonal entry point that installs *only the skill content* via `npx skills add`, for any runtime. The two can coexist: a Claude Code user can run the plugin installer AND `exarchos install-skills --agent claude`, and the latter is a no-op overwrite with identical content.

### Exarchos MCP server (`servers/exarchos-mcp/`)

**No changes.** The MCP tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, hidden `exarchos_sync`) remain as-is. The tool *names* are already runtime-neutral (`exarchos_*`); only the *prefix* differs by host (e.g., `mcp__plugin_exarchos_exarchos__exarchos_workflow` vs. `mcp__exarchos__exarchos_workflow`). The prefix diff is absorbed by `{{MCP_PREFIX}}`. No new composite actions (validated by DR-5). This keeps the MCP server contract stable and the blast radius small.

### Existing `skills/` tree

Before migration, `skills/` contains authored sources. After migration, `skills/` contains only generated output. The transition is a single cutover PR: move all sources into `skills-src/`, add placeholders where necessary, commit generated output, delete legacy top-level sources. The cutover is mechanical for 14 of 16 skills (only cosmetic changes); `delegation/` and `synthesis/` need the most editorial work to collapse their dual-tracked sections into placeholders.

### `commands/` directory

Open question (see below): either deleted entirely (workflows become skill-invocation via description match on non-Claude runtimes) or retained as a Claude-Code-only shim that mirrors `skills/claude/*` triggers. Recommendation: retain as a thin shim for Claude Code since users already have muscle memory for `/exarchos:ideate`.

### `npm run build`

Updated to invoke `npm run build:skills` before/alongside `npm run build:mcp`. The generated `skills/<runtime>/` tree is committed to git (not gitignored) because vercel-labs/skills reads from git paths. CI includes a `skills:guard` check that re-runs the build in a clean checkout and fails if the working tree diffs — this prevents stale generated output from landing.

---

## Testing Strategy

### Unit tests (vitest, co-located per convention)

- **`src/build-skills.test.ts`** — renderer tests:
  - substitution of known placeholders
  - multi-line placeholder expansion
  - `{{CHAIN next="..." args="..."}}` argument parsing
  - error on unknown placeholder
  - error on missing runtime-map entry
  - idempotent output (running twice produces byte-identical results)
  - reference directory is copied unchanged
- **`src/runtimes/load.test.ts`** — runtime loader tests:
  - valid YAML loads and passes Zod schema
  - missing required capability field rejected with exact path
  - unknown fields tolerated (forward compat) or rejected (decision in planning)
- **`src/runtimes/detect.test.ts`** — runtime detection:
  - `PATH`-based detection for each Tier-1 runtime
  - env-var-based detection
  - ambiguous detection prompts (mocked)
  - unknown → `generic` fallback

### Integration tests

- **`skills:guard` CI check** — runs `npm run build:skills` in a clean checkout and asserts `git diff --exit-code skills/` is clean. Blocks PR merges that forget to rebuild.
- **Snapshot tests** — each Tier-1 variant of each skill is snapshotted; renderer changes that affect output are reviewed explicitly.
- **`exarchos install-skills --agent <runtime>` dry-run tests** — verify the correct `npx skills add` command is printed for each runtime without actually running it.

### Smoke tests (per Tier-1 runtime)

One end-to-end workflow execution per runtime on a dummy feature:
- `ideate` → dummy design doc
- `plan` → dummy implementation plan
- `delegate` → spawns real subagents on 4 runtimes (Claude, OpenCode, Codex, Copilot) / sequential on Cursor
- `review` → pass-through gates
- `synthesize` → creates a PR against a test branch
- `cleanup` → resolves workflow

Cursor's smoke test explicitly verifies the sequential-fallback path and the single user warning emission.

### Regression: delegation semantics identity

A property test asserts: given the same task list, Claude (parallel), OpenCode (parallel), and Cursor (sequential) produce equivalent completion state in workflow storage. Scheduling differs; quality gates and state transitions do not.

---

## Integration Points (Build Order)

The feature delivers in this order, with each step independently testable:

1. **Scaffold `runtimes/` with generic + claude YAMLs only.** Validates the schema, loader, and renderer against the current skill bodies. One runtime (claude) to prove the substitution approach.
2. **Migrate `skills-src/` from `skills/` for the 14 non-delegation skills.** Straight mechanical move + placeholder insertion for `{{MCP_PREFIX}}`, `{{COMMAND_PREFIX}}`, `{{CHAIN}}`. Claude variant byte-identical to current skills.
3. **Add `copilot`, `codex`, `opencode`, `cursor` runtime maps.** Fill in placeholder values using context7-sourced native syntax. Build emits four more variants.
4. **Refactor `skills-src/delegation/SKILL.md`** to collapse its dual-tracked sections into `{{SPAWN_AGENT_CALL}}`. Update each runtime's map with native delegation syntax.
5. **Add `exarchos install-skills` subcommand** + runtime detection. Integration test with mocked `npx skills add`.
6. **CI `skills:guard` check.** Wire into build pipeline.
7. **Smoke tests per runtime.** One per Tier-1, in CI matrix.
8. **Cutover:** delete legacy `skills/` top-level sources, commit generated tree, update docs.

---

## Open Questions

### OQ-1: Codex delegation syntax — exact invocation form

Context7 confirmed Codex has a multi-agent spawn primitive (`codex-rs/core/templates/collab/experimental_prompt.md`), but the snippet did not reveal the exact tool-call syntax a skill body should emit. Planning phase must fetch the full template and determine whether the invocation is a first-class tool call (like Claude's `Task()`) or a natural-language delegation directive that Codex interprets.

**Resolution path:** First task in the implementation plan is a recon task: fetch and read `codex-rs/core/templates/collab/experimental_prompt.md` in full, then populate `runtimes/codex.yaml` `SPAWN_AGENT_CALL` accordingly. If it turns out Codex uses prose-style delegation, the placeholder still works; the map just contains a multi-line instruction block instead of a code call.

### OQ-2: Fate of `commands/`

Should the legacy `commands/*.md` slash-command files be deleted entirely, migrated into the skill bodies as `Triggers` sections, or retained as a Claude-Code-only compatibility shim? Claude Code users have muscle memory for `/exarchos:ideate`. Other runtimes have different command conventions. Three options: (a) delete — rely entirely on skill description matching, (b) retain as Claude-only shim — keep `commands/` as-is and let other runtimes discover skills by description, (c) generate per-runtime command variants from `skills-src/<skill>/command.md` templates.

**Recommendation for planning:** (b) — retain as Claude-only shim. Lowest migration cost, preserves existing UX for the largest user base, other runtimes use native skill discovery which is documented as first-class in the agentskills spec.

### OQ-3: OpenCode skills install path canonicalization

OpenCode discovers skills from three paths simultaneously: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`. Which should `exarchos install-skills --agent opencode` write to? Project-level or global? Global is `~/.config/opencode/skills/` per the docs.

**Resolution path:** default to global (`~/.config/opencode/skills/`) for consistency with how Claude Code installs are handled; allow `--project` flag for project-scoped installs. Decide exact default during planning; low-stakes.

### OQ-4: Cursor delegation fallback — sequential-in-session vs. `cursor-agent -p` shell-out

Cursor has a CLI (`cursor-agent -p "prompt"`) that runs an agent non-interactively. The fallback for Cursor delegation could (a) run sequentially in the current agent's session, or (b) shell out to parallel `cursor-agent -p` processes. Option (b) gives parallelism but requires the MCP server to grow a shell-out action — contradicting DR-5 ("no new handler"). Option (a) is simpler and honest about the capability gap.

**Recommendation for planning:** (a) sequential-in-session. Revisit in a later feature if users demand Cursor parallelism.

### OQ-5: `skills-src/` vs. `src/skills/` naming

Should canonical sources live at `skills-src/` (top-level, matches `servers/`) or `src/skills/` (under `src/`, matches TypeScript convention)? Top-level is more discoverable for skill authors who aren't TS engineers; under `src/` is tidier.

**Recommendation for planning:** `skills-src/` (top-level) — skill authoring is a first-class activity and deserves top-level visibility.

### OQ-6: Handling skills with structural divergence (escape hatch)

Approach A assumes runtime divergence is surface-level. If during migration a skill needs *structurally* different bodies per runtime (different ordering of steps, different gates), the substitution vocabulary can't express it. The design should reserve an escape hatch: `skills-src/<skill>/SKILL.<runtime>.md` files override the default `SKILL.md` for a specific runtime. Build step prefers the override when present.

**Acceptance for escape hatch (if adopted in planning):**
- Given `skills-src/foo/SKILL.md` and `skills-src/foo/SKILL.codex.md`
  When building the codex variant
  Then the codex-specific file is used as the source (placeholders still apply)
  And the default `SKILL.md` is used for all other runtimes.
- A tripwire warning fires if more than 3 skills use the escape hatch (signaling it's time to reconsider Approach A).

**Recommendation for planning:** adopt escape hatch defensively but do not use it unless a specific skill proves it's needed.

---

## Provenance

This design traces to:

- User intent: *"Following the spirit of our principle of platform-agnosticity... we'd like to explore migrating our current thin instruction layer for Claude Code into a truly platform-agnostic instruction set."*
- Context7 recon confirming 4 of 5 Tier-1 runtimes have first-class subagent delegation
- `skills/delegation/SKILL.md` review showing ~70% runtime-neutral content + ~30% surface syntax divergence
- vercel-labs/skills capability check confirming no upstream hook/transform mechanism (so the Exarchos CLI must own runtime-aware install)
- Agentskills.io spec confirming the format is minimal and does not conflict with our substitution approach
