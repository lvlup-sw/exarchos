# Spec: Harness conform-and-shrink bundle (skills collapse · AGENTS.md on-ramp · lifecycle → launcher)

**Date:** 2026-07-04 · **Feature:** `harness-conform-and-shrink` · **Depth:** standard
**Inputs:** #1599 (roadmap tracker) · #1601 (harness-agnosticism program) · #1602 / #1605 / #1607 (this bundle) · #1603 (launcher, shipped PR #1632) · [`docs/research/2026-06-21-harness-agnosticism-strategy.md`](../research/2026-06-21-harness-agnosticism-strategy.md) · ADR [`docs/adrs/2026-05-24-hook-layer-observe-only.md`](../adrs/2026-05-24-hook-layer-observe-only.md) · live SoTA research 2026-07-04 (citations inline)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> Ships as **v2.12.0-preview.1** — the Z2 tranche of #1601.

## Design & Rationale

### Problem Statement

Exarchos achieves harness-agnosticism today by **brute-force fan-out** rather than by conforming to the standards the ecosystem has since ratified. Three coupled gaps:

1. **Skills fan-out (#1602).** The committed `skills/` tree is 508 files — 6 runtimes × 18 skills — of which 15 skills differ per-runtime *only* in two prefix strings (`MCP_PREFIX`, `COMMAND_PREFIX`). Agent Skills is now a formal multi-vendor standard ([agentskills.io](https://agentskills.io/specification), extracted from Anthropic Dec 2025) loaded natively by every Tier-1 harness, and there is **no ecosystem prior art** for per-runtime SKILL.md *content* rendering — the convention is one file, per-harness *placement*. Our fan-out is pure maintenance drag (`skills:guard` diff surface, dual-baseline snapshot updates) that the standard has made unnecessary.
2. **Vocabulary fork (naming).** The same workflow step has up to three names: the skill name (`brainstorming`), the Claude command verb (`/exarchos:ideate`), and the opencode alias (`ideate`). Nine skills' names drift from their canonical verbs; only opencode declares `canonicalCommandAliases`. Upstream, Claude Code has merged commands into skills and Codex is deprecating prompts in favor of skills — the skill name *is* the invocation surface, so the fork is now a defect, not a style choice. INV-4 parity should cover vocabulary, not just guarantees.
3. **On-ramp and lifecycle ride harness-specific hooks (#1605, #1607).** The instruction on-ramp is a per-harness `SessionStart` hook directive (only where `canInjectContext`), and session lifecycle is observed via `SessionStart`/`SessionEnd` hooks — but a session-end signal is unreliable or absent on 3 of 5 hooked harnesses (OpenCode has no end event; Cursor headless/cloud don't fire `stop`/`sessionEnd`), and the MCP protocol will never provide a session boundary (shutdown has no protocol message; the 2026 draft spec removes protocol sessions and the `initialize` handshake outright — SEP-2567/SEP-2575, [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)). Meanwhile the launcher (#1603) already emits `launch.executing_started`/`launch.executed` at spawn/exit and ships an ephemeral injection seam (`launcher/injection-seam.ts`) that is **built but unwired**. There is no consumer-repo AGENTS.md injection at all, even though AGENTS.md is now a Linux Foundation (AAIF) standard read natively by every Tier-1 harness except Claude Code — whose own docs prescribe exactly the `CLAUDE.md → @AGENTS.md` shim we need ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)).

The enforcement half of #1607 is **already done**: ADR 2026-05-24 (#1476) deleted the enforcement hooks and centralized gating at the dispatch chokepoint (`core/dispatch.ts` readonly + shared-mutating gates). What remains is the residue that ADR left behind: the on-ramp directive, the lifecycle observers, and the docs that still describe hooks as a load-bearing layer.

### Chosen Approach

**Conform-and-shrink onto ratified standards; emit and enforce at chokepoints we own.**

- **#1602 — collapse.** Author the 15 procedural skills once, against **logical qualified tool names** (`exarchos:exarchos_workflow` prose form — Anthropic's documented harness-neutral convention, [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)), rendered to a single canonical `skills/standard/` set. Every surveyed harness keeps the raw tool name as the suffix of its model-visible MCP name, so logical names resolve universally; Codex is moving to fully bare names. Build-render survives **only** for the 3 orchestration skills (`delegation`, `refactor`, `brainstorming`) whose `TASK_TOOL`/`SPAWN_AGENT_CALL`/`CHAIN`/`SUBAGENT_*` tokens genuinely fork per harness — the bespoke moat the issue names, corrected from "~5" to the measured 3.
- **Naming — unify.** The skill name becomes the canonical verb (9 renames); Claude's fat `commands/*.md` collapse into the renamed skills (commands ≡ skills upstream); `canonicalCommandAliases` generalizes from an opencode special to a capability-driven default. One name space across all six runtimes.
- **#1605 — standard on-ramp.** A consumer-side **managed-block inserter** with Ruler-hardened semantics writes the Exarchos on-ramp block into the consumer's `AGENTS.md` (users own the file; we own only our block), plus a `CLAUDE.md` managed block holding a one-line `@AGENTS.md` import. Where the launcher is used, orientation is injected **ephemerally at spawn** through each harness's native channel — zero repo mutation; the managed block is the direct-launch floor.
- **#1607 — lifecycle to the launcher, hooks retired where covered.** The launcher becomes the sole lifecycle + injection authority (decision 2026-07-04, chosen over the two-layer advisory alternative): the `SessionStart` directive hooks and the `SessionEnd` observer are **retired**; `SubagentStop` survives as the only token-attribution seam. Direct launches fall back to the AGENTS.md managed block for on-ramp, and to the existing event-sourced liveness reconciliation (WLM, INV-10) for lifecycle — reconcile-on-next-entry, never a daemon (INV-15).

## Requirements

### DR-1: Procedural skills collapse to one standard SKILL.md with logical tool names

The 15 procedural skills are authored once, with no `MCP_PREFIX`/`COMMAND_PREFIX` tokens; prose tool references use the qualified logical form (`exarchos:<tool_name>`); machine-parsed frontmatter keeps `metadata.mcp-server: exarchos` (matches Anthropic guidance) and never carries harness-prefixed names.

**Acceptance criteria:**
- Rendered per-runtime variants for the 15 procedural skills are deleted; a single canonical render (`skills/standard/<name>/`) replaces them; committed `skills/` file count drops from ~508 to the orchestration-only residual (~3 × 6 runtimes + shared fixtures).
- `grep -r "MCP_PREFIX\|COMMAND_PREFIX" skills-src/<procedural>/` returns empty for all 15; the placeholder lint **rejects** prefix tokens in procedural sources (classification enforced, not advisory).
- Each collapsed SKILL.md validates against the agentskills.io spec (`name` matches directory, ≤64 chars, description ≤1024).
- `skills:guard` scope shrinks to the residual rendered set and the canonical set; renderer comment stating "canonical five tokens" corrected to the real vocabulary.

### DR-2: Orchestration residual keeps build-render, with enforced classification

`delegation` (→ `delegate`), `refactor`, and `brainstorming` (→ `ideate`) retain per-runtime rendering for the 5 orchestration tokens (`TASK_TOOL`, `CHAIN`, `SPAWN_AGENT_CALL`, `SUBAGENT_COMPLETION_HOOK`, `SUBAGENT_RESULT_API`) and `<!-- requires:* -->` capability gating (used only by `delegation`).

**Acceptance criteria:**
- The 3 orchestration skills render per-runtime exactly as today (token substitution + requires-gating unchanged), under their new verb names.
- The build fails if a procedural skill introduces an orchestration token (the procedural/orchestration split is asserted at build time, not by convention).
- `assertRuntimeTokenCoverage` still guarantees every runtime declares all orchestration tokens; prefix tokens are dropped from the required-coverage set once no residual skill uses them (or retained only if an orchestration skill still does).

### DR-3: One canonical verb vocabulary across all six runtimes

Skill name = directory name = canonical verb. Renames: `brainstorming`→`ideate`, `implementation-planning`→`plan`, `delegation`→`delegate`, `synthesis`→`synthesize`, `discovery`→`discover`, `oneshot-workflow`→`oneshot`, `prune-workflows`→`prune`, `authoring-invariants`→`invariants`, `workflow-state`→ resolved per Open Question 1 (leaning: split into `rehydrate` + `checkpoint`). Claude's fat `commands/*.md` collapse into the renamed skills; `canonicalCommandAliases` generalizes to a capability-driven default for every runtime with a command surface that needs shims.

**Acceptance criteria:**
- On every runtime, the user-facing invocation vocabulary is identical (e.g. `ideate` invokes the same content whether surfaced as `/exarchos:ideate`, `$ideate`, or the `ideate` skill).
- No `commands/*.md` body duplicates skill content; commands are thin shims (frontmatter + pointer) or removed where the harness surfaces skills as commands natively.
- All cross-skill references (`CHAIN` targets `exarchos:{{next}}`, `next_actions` prose, docs, playbooks, rehydration `compactGuidance`) use the new names; the golden fixture (`rehydrate-demo.expected-document.json`) is regenerated.
- `onboard` migrates consumer installs: stale old-name skill directories are removed **only** when provenance-marked as Exarchos-installed (see DR-8), and the new names are installed in the same reconcile pass.

### DR-4: Install layout aligns to the `.agents/skills/` cross-client convention

The canonical skill set installs to `.agents/skills/` (project) / `~/.agents/skills/` (user) with per-harness placement; Windows uses copy-mode, never symlinks. No distribution CLI is adopted as primary in this bundle.

**Acceptance criteria:**
- `installSkills()` places the canonical set at the convention path and per-harness native dirs per each runtime's `skillsInstallPath`; on `win32`, placement is file copy (no symlink privilege requirement — INV-16).
- The existing `npx skills add` fallback continues to work against the repo (vercel-labs/skills discovers Claude plugin manifests; our `.claude-plugin/` packaging stays compatible).
- `doctor` reports layout drift (canonical copy missing / stale) without writing.

### DR-5: Consumer-side managed-block inserter with Ruler-hardened semantics

A managed-block writer inserts/updates the Exarchos on-ramp block in the consumer's `AGENTS.md` and a `CLAUDE.md` managed block containing a one-line `@AGENTS.md` import (own line — same-line-with-comment resolution is undocumented upstream). Users own their files; Exarchos owns only its marker-fenced block.

**Acceptance criteria:**
- Markers form a complete pair; an **incomplete pair is treated as absent** — the writer never claims trailing content, preserves everything, and appends a fresh well-formed block with a warning in the result (the Ruler #601 failure class, designed out).
- Idempotency by content hash: identical desired block → no write, no backup; changed block → backup once, then in-place block replacement touching nothing outside the markers.
- The block carries a provenance line (tool + version + source hash); writes are atomic (temp file + rename); existing line-ending style (LF/CRLF) of the target file is detected and preserved (INV-16 — no ecosystem tool handles this; we do).
- `AGENTS.md` block content is self-contained (no `@imports` inside AGENTS.md — Claude-only expansion would fork behavior per harness); block ≤ 4 KiB; writer warns when total file size approaches the Codex 32 KiB per-file ingestion cap.
- Marker syntax is unified with the existing `binding.ts` fence per Open Question 2.

### DR-6: Ephemeral spawn-time injection wired through per-harness native channels

`injectOrientation` is wired into `lifecycle-core.ts`, and the injection channel becomes a **per-harness declared capability** on the spawn descriptor — replacing the single `canInjectContext` boolean, which conflates hook-injection with spawn-injection (Cursor is hook-injectable but has no spawn channel).

**Acceptance criteria:**
- Channels per harness registry entry: Claude Code `--append-system-prompt-file`; Codex `-c developer_instructions=…`; Copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (temp dir with synthetic AGENTS.md); OpenCode `OPENCODE_CONFIG_CONTENT` (inline JSON `instructions`); Cursor `none` → documented fallback to the DR-5 managed block.
- A launcher-spawned session on each channel-bearing harness observes the orientation with **zero repo-file mutation**; `--dry-run` prints the resolved channel + payload without spawning.
- The orientation payload derives from the same single source as the managed block (`binding-src/binding.md`) — one content source, two delivery mechanisms.
- The `EXARCHOS_DIRECTIVE`-refusal property of the seam is preserved (orientation channel can never write the authoritative directive key).

### DR-7: Launcher is the lifecycle authority; covered hooks retired

Session lifecycle (start/end) is sourced from the launcher's `launch.executing_started`/`launch.executed` events; the `SessionStart` directive hooks (claude, codex), the `SessionEnd` observer, and the opencode `session.created` plugin observer are retired from shipped artifacts and from `onboard` installation. `SubagentStop` is **retained** — it is the only token-attribution seam.

**Acceptance criteria:**
- `hooks/hooks.json` ships `SubagentStop` only; `hooks/codex/hooks.json` and the opencode lifecycle plugin are removed (or reduced to nothing) by `build-hooks`; `hooks:guard` passes on the shrunk tree.
- `onboard` uninstalls previously-installed retired hooks from host settings **only** when the hook entry provenance-matches (command-marker match — never touches user-authored hooks), and is idempotent across repeated runs.
- Lifecycle verbs (`ps`/`describe`/`wait`) answer correctly for launcher-spawned sessions from `launch.*` events alone; for direct launches they answer from reconciliation (existing WLM liveness), and the docs state the coverage difference explicitly.
- The `session-start`/`session-end` CLI verbs' disposition follows Open Question 3; ADR 2026-05-24 gains a dated addendum recording this completion, and architecture docs stop describing hooks as an on-ramp/lifecycle layer.

### DR-8: Failure-mode handling for every file-mutating and spawn-path surface

Every new mutation surface fails safe, visibly, and idempotently.

**Acceptance criteria:**
- Managed-block writer: unwritable target / missing directory → structured error with `suggestedFix`; missing `AGENTS.md` → created with just the managed block; concurrent-writer collision → atomic rename semantics with post-write re-read verification, and a structured warning (not silent last-writer-wins) if verification mismatches.
- Spawn injection: channel construction failure (missing temp dir, oversize payload) → launch **proceeds** without orientation (fail-open for guidance — orientation is UX, not enforcement), with the degradation recorded on the `launch.executing_started` payload.
- Hook uninstall and stale-skill-rename removal: provenance-gated (marker/manifest match) — absence of provenance means **no deletion**, a warning, and a `doctor` finding; never inferred from backup absence (the Ruler #436 failure class).
- All new paths are exercised by tests on POSIX and covered by the `windows-latest` lane for path/CRLF/symlink behavior (INV-16).

## Technical Design

**Renderer split (`src/build-skills.ts`).** Skill classification (procedural vs orchestration) is derived from token usage and asserted at build time. Procedural skills render **once** to `skills/standard/<verb>/` (placeholder pass limited to non-prefix substitutions, i.e. effectively none); orchestration skills keep the existing per-runtime pipeline under `skills/<runtime>/<verb>/`. `skills:guard` guards both trees; the placeholder lint gains the procedural/orchestration classification rules. The prefix tokens disappear from procedural sources; runtime YAMLs keep them only while an orchestration skill still references them.

**Naming (`skills-src/`, `commands/`, `command-aliases/`).** Directory renames per DR-3 with `name:` frontmatter kept equal to the directory (agentskills spec requirement). `commands/*.md` bodies migrate into the corresponding `skills-src/<verb>/SKILL.md` where content genuinely differs, then become thin shims (or are dropped for harnesses that surface skills as commands natively). `canonicalCommandAliases` moves from a runtime-YAML boolean special-case to the default behavior for any runtime declaring a `commandsInstallPath` without native skill-command surfacing. `CHAIN` second-pass args (`exarchos:{{next}}`) resolve against the new verb names — the rename lands atomically with the reference updates in one build.

**Managed-block module (extends `src/binding.ts`).** `renderBindingBlock` already produces a marker-fenced block from `binding-src/binding.md`; this bundle adds the consumer-side half: `insertManagedBlock(filePath, block, opts)` implementing DR-5/DR-8 semantics, called by the `onboard` writers for `AGENTS.md` (all runtimes) and `CLAUDE.md` (claude shim: block contains `@AGENTS.md`). The `doctor` reconciler diffs desired-vs-actual block content by hash.

**Launcher injection (`servers/exarchos-mcp/src/launcher/`).** `HarnessDescriptor` gains an `injection` field — a discriminated union (`{kind: 'flag', flag}`, `{kind: 'env', key, format}`, `{kind: 'config-json', key}`, `{kind: 'none'}`) — populated per harness in `harnesses/*.ts` from the DR-6 channel matrix. `lifecycle-core.ts` calls `injectOrientation` during spawn-descriptor assembly; the existing `EXARCHOS_ORIENTATION` env write remains as a debugging breadcrumb but is no longer the delivery mechanism.

**Hook shrink (`hooks-src/`, `src/build-hooks.ts`, `orchestrate/onboard/hooks.ts`).** `hooks-src/hooks.json` drops to the `SubagentStop` entry; the codex hooks file and opencode plugin template are deleted; `installHook` gains a `removeRetiredHooks` pass (provenance = command-marker match, the same discipline already used for idempotent install). The directive text that the `SessionStart` hook used to inject is not lost — it *is* the binding/orientation content now delivered by DR-5/DR-6.

**Invariants preserved.** INV-4: parity improves — one content source per skill, per-harness placement; the orchestration residual is the only place runtime text still forks, and it stays tokenized. INV-2: no adapter logic is added; on-ramp/lifecycle move to launcher + onboard handlers (shared core). INV-11/INV-12: postures and affordances unchanged; enforcement stays at dispatch. INV-15: no daemon, no polling — lifecycle is launcher-emitted events + reconcile-on-next-entry; the 2026 MCP draft's removal of protocol sessions independently confirms this frame. INV-16: copy-mode installs, CRLF preservation, atomic writes, windows-latest coverage. INV-10: `launch.*` remains the liveness protocol; retiring `SessionEnd` removes a redundant, unreliable signal rather than a guarantee.

## Integration Points

- `src/build-skills.ts` — renderer split, classification assertion, `skills/standard/` emission, stale-comment fix
- `src/placeholder-lint.ts` — procedural/orchestration token rules
- `skills-src/*` — 9 renames + bare-name rewrite of 15 procedural skills + command-content fold-in
- `commands/*.md`, `command-aliases/` — thin-shim collapse; alias generalization
- `src/skills-guard.ts` — guard over both trees
- `src/install-skills.ts`, `orchestrate/onboard/install.ts` — `.agents/skills/` layout, copy-mode on win32, rename migration
- `src/binding.ts` (+ new consumer-insert module) — `insertManagedBlock`, marker unification
- `orchestrate/init/writers/*.ts`, `orchestrate/onboard/*` — AGENTS.md/CLAUDE.md block writes, hook uninstall pass, doctor drift findings
- `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `harnesses/*.ts`, `injection-seam.ts`, `lifecycle-core.ts` — injection channel union + wiring
- `hooks-src/*`, `src/build-hooks.ts`, `src/hooks-guard.ts` — hook shrink
- `runtimes/*.yaml`, `src/runtimes/types.ts` — per-channel injection capability replacing single-boolean consumption; alias default
- `docs/architecture/*`, ADR 2026-05-24 addendum, `docs/system-design.html` status rows — truth-up
- Test surfaces: skill snapshot baselines (dual-baseline update), `rehydrate-demo.expected-document.json` regen, parity tests, `servers/exarchos-mcp` separate typecheck, windows-latest lane

## Alternatives considered

- **Install-time prefix resolution (per-consumer render at install).** Rejected in #1602 and confirmed by research: a shared `.agents/skills/` path read by N harnesses cannot carry a baked prefix, and the prefix is a property of the live tool list, not a static install fact. No ecosystem tool does install-time content transformation.
- **Fully bare tool names in prose (`exarchos_workflow` alone).** Viable — every harness preserves the raw name as a suffix — but Anthropic's authoring guidance documents the qualified `Server:tool` form as the robust convention when multiple servers are attached; qualified is equally harness-neutral, so we take the documented form.
- **Symlink `CLAUDE.md → AGENTS.md`.** Rejected: Anthropic's own docs prefer the import on Windows; symlinks break copy-based workflows and Windows non-Developer-Mode checkouts (INV-16).
- **Two-layer hooks (keep SessionStart/SessionEnd as advisory alongside launcher authority).** The OPA warn-locally/deny-at-admission analog; rejected by owner decision 2026-07-04 in favor of surface shrink — the launcher is uniform where used, the managed block covers direct launches, and WLM reconciliation already closes the direct-launch lifecycle gap. Revisitable if direct-launch telemetry proves insufficient.
- **MCP-handshake session detection.** Rejected: shutdown has no protocol message today and the 2026 draft removes sessions and `initialize` entirely; building on the handshake is building on sand.
- **Adopt `vercel-labs/skills` as primary distribution.** Deferred: de-facto leader but operationally immature on Windows (symlink privileges, lockfile-not-written #399, CRLF hash drift #781). We align with its *layout* so adoption later is cheap.
- **Status-quo per-runtime rendering.** Rejected: zero ecosystem prior art for per-runtime content; 6× duplication is pure carrying cost now that the standard exists.

## Open Questions

1. **`workflow-state` verb split.** One skill backs two verbs (`rehydrate`, `checkpoint`). Leaning: split into two thin verb skills over shared `references/`. Resolve at decomposition (small, mechanical either way).
2. **Marker syntax.** Existing `binding.ts` fence (`<!-- exarchos:binding:start -->`) vs strategy-doc proposal (`<!-- BEGIN exarchos (managed) -->`). Leaning: keep the existing fence — continuity with already-shipped binding artifacts; add the provenance line inside. Resolve at decomposition.
3. **`session-start`/`session-end` CLI verbs.** Hooks stop calling them; do the verbs stay as manual utilities (INV-2 parity surface, harmless) or retire? Leaning: keep the verbs, retire only hook registration; a later minor can remove them after a deprecation cycle. Resolve at decomposition.
4. **`generic` runtime lifecycle claim.** `generic` is excluded from the launcher enum by design; after hook retirement its lifecycle is reconciliation-only and its on-ramp is the managed block. Confirm docs state this as the contract (no code change expected).

## Decomposition

### Scope

**Target:** Full design (DR-1 … DR-8).
**Excluded:** None. Open Questions resolved here rather than deferred: OQ1 → **split** `workflow-state` into `rehydrate` + `checkpoint` thin verb skills over shared references (Task 005); OQ2 → **keep** the existing `binding.ts` fence, add the provenance line inside it (Task 012); OQ3 → **keep** the `session-start`/`session-end` CLI verbs, retire only hook registration (Tasks 016/018); OQ4 → documented as contract, no code (Task 018).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Procedural skills collapse to one standard SKILL.md, logical tool names | 001, 002, 003, 006, 009 |
| DR-2 | Orchestration residual keeps build-render, enforced classification | 001, 002, 009 |
| DR-3 | One canonical verb vocabulary across all six runtimes | 004, 005, 007, 008, 011 |
| DR-4 | Install layout aligns to `.agents/skills/` convention | 010 |
| DR-5 | Consumer-side managed-block inserter, Ruler-hardened | 012, 013 |
| DR-6 | Ephemeral spawn-time injection via per-harness channels | 014, 015 |
| DR-7 | Launcher is lifecycle authority; covered hooks retired | 016, 017, 018 |
| DR-8 | Failure-mode handling on every mutating/spawn surface | 011, 012, 015, 017 |


### Task 001: Renderer skill classification (procedural vs orchestration) with build-time assertion

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** Derive each skill's class from its token usage in `skills-src/`; expose it on the renderer's skill model; fail the build when a procedural skill references any orchestration token (`TASK_TOOL`, `CHAIN`, `SPAWN_AGENT_CALL`, `SUBAGENT_COMPLETION_HOOK`, `SUBAGENT_RESULT_API`) or a `<!-- requires:* -->` block. Fix the stale "canonical five tokens" comment.
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Expected tests:** `classifySkill_PrefixOnlySource_ClassifiedProcedural`, `classifySkill_ProceduralSourceWithOrchestrationToken_FailsBuild`, `classifySkill_RequiresBlockInProceduralSource_FailsBuild`
**Files:** `src/build-skills.ts`, `src/build-skills.test.ts`
**Dependencies:** None
**Parallelizable:** Yes (stream A head)

### Task 002: Placeholder-lint rules for the collapsed vocabulary

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** `lintPlaceholders` rejects `MCP_PREFIX`/`COMMAND_PREFIX` in procedural sources; orchestration tokens remain valid only in orchestration skills; required-coverage set (`assertRuntimeTokenCoverage`) drops prefix tokens once no residual source uses them.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `lintPlaceholders_PrefixTokenInProceduralSkill_Rejected`, `lintPlaceholders_OrchestrationTokenInOrchestrationSkill_Allowed`, `assertRuntimeTokenCoverage_PrefixTokensUnused_NotRequired`
**Files:** `src/placeholder-lint.ts`, `src/placeholder-lint.test.ts`, `src/build-skills.ts`
**Dependencies:** 001
**Parallelizable:** No (follows 001 in stream A)

### Task 003: `skills/standard/` single-render emission + guard coverage

**Risk Tier:** medium
**Implements:** DR-1
**Description:** Procedural skills render once to `skills/standard/<verb>/`; per-runtime emission narrows to the orchestration set; `skills:guard` diff-guards both trees; references copied verbatim as today. Adds `CHAIN` target validation (a `{{next}}` referencing a non-existent skill fails the build) so Task 004's renames are structurally checked.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `buildAllSkills_ProceduralSkill_EmitsSingleStandardVariant`, `buildAllSkills_OrchestrationSkill_EmitsPerRuntimeVariants`, `skillsGuard_StandardTreeDrift_Fails`
**Files:** `src/build-skills.ts`, `src/skills-guard.ts`, `src/build-skills.test.ts`
**Dependencies:** 001, 002
**Parallelizable:** No (stream A)

### Task 004: Canonical-verb renames (8 mechanical) + cross-reference updates

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Rename `brainstorming`→`ideate`, `implementation-planning`→`plan`, `delegation`→`delegate`, `synthesis`→`synthesize`, `discovery`→`discover`, `oneshot-workflow`→`oneshot`, `prune-workflows`→`prune`, `authoring-invariants`→`invariants`; keep `name:` frontmatter equal to directory; update every cross-skill reference (`CHAIN` `{{next}}` args, `@skills/...` links, `_shared` references, docs pointers).
**Verification (medium):** scoped tests + kill-probe (rename-reference integrity is behavior: broken `CHAIN` targets must fail the build).
**Expected tests:** `buildAllSkills_RenamedSkillNames_MatchDirectories`, `chainToken_TargetSkillMissing_FailsBuild` (validator from Task 003)
**Files:** `skills-src/ideate/SKILL.md`, `skills-src/plan/SKILL.md`, `skills-src/delegate/SKILL.md`, `skills-src/synthesize/SKILL.md`, `skills-src/discover/SKILL.md`, `skills-src/oneshot/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/invariants/SKILL.md` (renamed dirs + inbound references)
**Dependencies:** None (content stream; merges serialized with 001–003 in stream A)
**Parallelizable:** Yes (parallel to 001–003, same-stream serialize at merge)

### Task 005: Split `workflow-state` into `rehydrate` + `checkpoint` verb skills

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Two thin verb skills sharing `references/` (phase-transitions, state guidance); descriptions scoped per verb; all inbound references updated (OQ1 resolution).
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `buildAllSkills_RehydrateAndCheckpoint_BothEmitted`, `sharedReferences_LinkedFromBothVerbs_RenderedInBoth`
**Files:** `skills-src/rehydrate/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/_shared/references/verification.md` (shared refs relinked)
**Dependencies:** 004
**Parallelizable:** No (stream A)

### Task 006: Rewrite 15 procedural skills to qualified logical tool names

**Risk Tier:** medium
**Implements:** DR-1
**Description:** Replace `{{MCP_PREFIX}}<tool>` with the qualified logical form (`exarchos:<tool>` prose convention) and `{{COMMAND_PREFIX}}<verb>` with the canonical verb across the 15 procedural skills and their `references/`; keep `metadata.mcp-server: exarchos`; validate against agentskills.io frontmatter constraints.
**Verification (medium):** scoped tests + kill-probe; DR-1 grep AC (`MCP_PREFIX|COMMAND_PREFIX` empty over procedural sources).
**Expected tests:** Task 002's lint tests now pass over the real tree (`lintPlaceholders_RewrittenProceduralTree_NoPrefixTokens`)
**Files:** `skills-src/cleanup/SKILL.md`, `skills-src/debug/SKILL.md`, `skills-src/discover/SKILL.md`, `skills-src/dogfood/SKILL.md`, `skills-src/git-worktrees/SKILL.md`, `skills-src/plan/SKILL.md`, `skills-src/merge-orchestrator/SKILL.md`, `skills-src/mutation-adequacy/SKILL.md`, `skills-src/oneshot/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/invariants/SKILL.md`, `skills-src/rehydrate/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/review/SKILL.md`, `skills-src/shepherd/SKILL.md`, `skills-src/synthesize/SKILL.md` (+ each skill's `references/`)
**Dependencies:** 004, 005
**Parallelizable:** No (stream A; content-wide)

### Task 007: Collapse fat `commands/*.md` into the renamed skills

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Migrate content that exists only in `commands/*.md` (state-management choreography, auto-chain steps) into the corresponding `skills-src/<verb>/SKILL.md`; reduce commands to thin shims (frontmatter + one-line pointer) or delete where the harness surfaces skills as commands natively; no body duplication remains.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `commandsTree_NoBodyDuplicatesSkillContent` (guard-style assertion), trigger-tests still resolve each verb
**Files:** `commands/ideate.md`, `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`, `commands/debug.md`, `commands/refactor.md`, `commands/oneshot.md`, `commands/rehydrate.md`, `commands/checkpoint.md`, `commands/cleanup.md`, `commands/discover.md`, `commands/dogfood.md`, `commands/prune.md`, `commands/shepherd.md`, `commands/invariants.md`, `skills-src/ideate/SKILL.md` (fold-in targets per verb)
**Dependencies:** 004, 005, 006
**Parallelizable:** No (stream A tail)

### Task 008: Generalize `canonicalCommandAliases` to a capability-driven default

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Alias emission keys off runtime capability (declares `commandsInstallPath` without native skill-command surfacing) instead of the opencode-only boolean; emit `command-aliases/<runtime>/` for every qualifying runtime; INV-4: no runtime literals in the gate.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `aliasEmission_QualifyingRuntime_EmitsVerbAliases`, `aliasEmission_NativeSkillCommandRuntime_EmitsNone`
**Files:** `src/build-skills.ts`, `runtimes/*.yaml`, `src/runtimes/types.ts`
**Dependencies:** 003, 004 (003 orders the shared `src/build-skills.ts` edits behind the renderer chain)
**Parallelizable:** Yes (after 003+004; independent of 005–007)

### Task 009: Full regeneration — trees, snapshots, golden fixture, prose

**Risk Tier:** high
**Implements:** DR-1, DR-2 (and lands DR-3 renders)
**Description:** Run `npm run build:skills`; delete stale per-runtime renders for procedural skills; commit `skills/standard/` + shrunk `skills/<runtime>/` + regenerated `command-aliases/`; update snapshot baselines (vitest `-u` + claude batch-baseline copy); regenerate `rehydrate-demo.expected-document.json` if `compactGuidance`/`next_actions` prose changed; verify parity tests.
**Verification (high):** medium set + integration — full `vitest run` at root **and** `servers/exarchos-mcp`, `skills:guard`, `hooks:guard`, both typechecks.
**Expected tests:** existing suites green post-regen; `skillsGuard_RegeneratedTree_Clean`
**Files:** `skills/**`, `command-aliases/**`, `servers/exarchos-mcp/**/rehydrate-demo.expected-document.json`, snapshot baselines
**Dependencies:** 001–008
**Parallelizable:** No (stream A barrier)

### Task 010: Install layout — `.agents/skills/` + copy-mode on Windows

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4
**Description:** `installSkills()` places the canonical set at `.agents/skills/` (project) / `~/.agents/skills/` (user) and per-harness native dirs; `win32` placement is copy, never symlink; `npx skills add` fallback retained; `doctor` reports canonical-copy drift read-only.
**Verification (medium):** scoped tests + kill-probe (shape-based Windows tests per CI-gap discipline).
**Expected tests:** `installSkills_CanonicalLayout_PlacesAgentsSkillsDir`, `installSkills_Win32_UsesCopyNotSymlink`, `doctor_CanonicalCopyStale_ReportsDrift`
**Files:** `src/install-skills.ts`, `src/install-skills.test.ts`, `servers/exarchos-mcp/src/orchestrate/onboard/install.ts`
**Dependencies:** 009
**Parallelizable:** Yes (after 009; parallel with 011)

### Task 011: Onboard rename migration — provenance-gated stale-skill removal

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-8
**Description:** The onboard reconciler removes old-name skill dirs from consumer install paths **only** when provenance-marked as Exarchos-installed (install manifest/marker); unmarked dirs are preserved with a warning + `doctor` finding; new names installed in the same pass; idempotent.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `onboardMigrate_ProvenanceMarkedStaleSkill_Removed`, `onboardMigrate_UnmarkedDirectory_PreservedWithWarning`, `onboardMigrate_RepeatedRuns_Idempotent`
**Files:** `servers/exarchos-mcp/src/orchestrate/onboard/install.ts` (+ tests), `src/install-skills.ts`
**Dependencies:** 010
**Parallelizable:** No (follows 010)

### Task 012: `insertManagedBlock` — consumer-side managed-block writer

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-5, DR-8
**Description:** New module (extending `src/binding.ts` fence constants — OQ2: keep `<!-- exarchos:binding:start/end -->`): complete-pair-only semantics (incomplete pair ⇒ treated absent, content never claimed, fresh block appended + warning), content-hash idempotency (identical ⇒ no write, no backup), backup-once before first modification, provenance line (tool+version+source hash), LF/CRLF detection & preservation, atomic temp+rename, missing-file creation, structured error envelopes (`suggestedFix`), post-write re-read verification with structured warning on mismatch.
**Verification (high):** medium set + property tests (content outside markers is invariant under arbitrary insert/update sequences) + windows-lane CRLF coverage.
**Expected tests:** `insertManagedBlock_IncompletePair_TreatsAbsentAppendsFresh`, `insertManagedBlock_IdenticalContent_NoWriteNoBackup`, `insertManagedBlock_ChangedBlock_BacksUpOnceThenReplacesInPlace`, `insertManagedBlock_CrlfFile_PreservesLineEndings`, `insertManagedBlock_MissingFile_CreatesWithBlock`, `insertManagedBlock_UnwritableTarget_StructuredError`, property: `outsideContent_InvariantUnderAnyBlockOperationSequence`
**Files:** `src/managed-block.ts`, `src/managed-block.test.ts`, `src/binding.ts`
**Dependencies:** None (stream B head)
**Parallelizable:** Yes

### Task 013: Onboard writers — AGENTS.md block + CLAUDE.md `@AGENTS.md` shim + doctor drift

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5
**Description:** All runtime writers emit the on-ramp block into consumer `AGENTS.md` via `insertManagedBlock`; claude writer additionally maintains the `CLAUDE.md` managed block whose body is the `@AGENTS.md` import on its own line; block content derives from `binding-src/binding.md` (single source); size guards (block ≤ 4 KiB; warn near Codex 32 KiB file cap); AGENTS.md block self-contained (no `@imports`); `doctor` diffs desired-vs-actual by hash.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `claudeWriter_Shim_ImportOnOwnLineInsideBlock`, `writers_AgentsMdBlock_NoAtImportsInside`, `writer_FileNearCodexCap_Warns`, `doctor_BlockHashDrift_ReportsFinding`
**Files:** `servers/exarchos-mcp/src/orchestrate/init/writers/*.ts`, `servers/exarchos-mcp/src/orchestrate/onboard/*` (+ tests)
**Dependencies:** 012
**Parallelizable:** No (follows 012)

### Task 014: Injection-channel union on the harness registry

**Risk Tier:** medium
**Implements:** DR-6
**Description:** `HarnessDescriptor` gains `injection: {kind:'flag'|'env'|'config-json'|'none', …}`; per-harness values: claude `--append-system-prompt-file`, codex `-c developer_instructions=…`, copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (temp-dir synthetic AGENTS.md), opencode `OPENCODE_CONFIG_CONTENT` (inline `instructions`), cursor `none`.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `harnessRegistry_EveryHarness_DeclaresInjectionChannel`, `injectionChannel_Cursor_IsNoneWithManagedBlockFallbackDoc`
**Files:** `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `servers/exarchos-mcp/src/launcher/harnesses/*.ts` (+ tests)
**Dependencies:** None (stream B, parallel with 012)
**Parallelizable:** Yes

### Task 015: Wire `injectOrientation` into the spawn path (fail-open, dry-run-visible)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-6, DR-8
**Description:** `lifecycle-core.ts` applies the channel during spawn-descriptor assembly; orientation payload from the binding source; channel-construction failure (temp-dir, oversize) ⇒ launch proceeds without orientation, degradation recorded on `launch.executing_started` payload; `--dry-run` prints resolved channel + payload; `EXARCHOS_DIRECTIVE`-refusal preserved.
**Verification (high):** medium set + integration across the spawn seam (fake harness binary capturing argv/env), windows lane for temp-dir/path behavior.
**Expected tests:** `runLifecycle_ClaudeChannel_AppendsSystemPromptFileFlag`, `runLifecycle_CopilotChannel_PointsEnvAtSyntheticAgentsMd`, `runLifecycle_InjectionConstructionFails_LaunchProceedsWithDegradationRecorded`, `launcherVerb_DryRun_PrintsResolvedChannelAndPayload`, `injectOrientation_DirectiveKey_StillRefused`
**Files:** `servers/exarchos-mcp/src/launcher/lifecycle-core.ts`, `servers/exarchos-mcp/src/launcher/injection-seam.ts`, `servers/exarchos-mcp/src/launcher/verb.ts` (+ tests)
**Dependencies:** 014
**Parallelizable:** No (follows 014)

### Task 016: Hook-surface shrink to `SubagentStop`

**Risk Tier:** medium
**Implements:** DR-7
**Description:** `hooks-src/hooks.json` drops SessionStart/SessionEnd (SubagentStop only); delete `hooks/codex/hooks.json` source + opencode lifecycle-plugin template; `build-hooks`/`hooks:guard` updated; `canInjectContext` consumption removed from build-hooks (schema field retained, marked deprecated); the SessionStart directive text's duties are documented as delivered by DR-5/DR-6 surfaces; `session-start`/`session-end` CLI verbs retained (OQ3).
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `buildAllHooks_ClaudeTemplate_EmitsSubagentStopOnly`, `buildAllHooks_CodexAndOpencodeLifecycleArtifacts_NotEmitted`, `hooksGuard_ShrunkTree_Passes`
**Files:** `hooks-src/*`, `src/build-hooks.ts`, `src/hooks-guard.ts`, `hooks/**` (regenerated), `src/runtimes/types.ts`
**Dependencies:** 008 (shared `src/runtimes/types.ts` — serialized to avoid cross-stream conflict)
**Parallelizable:** Yes (after 008; parallel to streams A-tail and B)

### Task 017: Onboard hook-uninstall pass (provenance-matched, idempotent)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-7, DR-8
**Description:** `installHook` gains `removeRetiredHooks`: removes previously-installed SessionStart/SessionEnd entries from host settings **only** on command-marker provenance match; user-authored hooks untouched; no provenance ⇒ no deletion + warning + `doctor` finding; idempotent across runs.
**Verification (high):** medium set + integration over a real settings.json fixture matrix (ours-only / user-only / mixed / already-clean).
**Expected tests:** `removeRetiredHooks_ProvenanceMatchedEntry_Removed`, `removeRetiredHooks_UserAuthoredHook_Untouched`, `removeRetiredHooks_MixedSettings_RemovesOnlyOurs`, `removeRetiredHooks_RepeatedRuns_Idempotent`, `removeRetiredHooks_NoProvenance_WarnsAndPreserves`
**Files:** `servers/exarchos-mcp/src/orchestrate/onboard/hooks.ts` (+ tests)
**Dependencies:** 016
**Parallelizable:** No (follows 016)

### Task 018: Lifecycle-verb coverage + docs truth-up + ADR addendum

**Risk Tier:** medium
**Implements:** DR-7
**Description:** Verify (add if missing) coverage that `ps`/`describe`/`wait` answer for launcher-spawned sessions from `launch.*` events alone; document direct-launch coverage as reconciliation-only and `generic` as managed-block + reconciliation by contract (OQ4); ADR 2026-05-24 dated addendum recording hook retirement completion; architecture docs + `docs/system-design.html` status rows updated; guides updated for the new install layout + AGENTS.md on-ramp.
**Verification (medium):** scoped tests + kill-probe for the verb-coverage test; docs are static-checked.
**Expected tests:** `describe_LauncherSpawnedSession_AnswersFromLaunchEventsAlone`
**Files:** `docs/adrs/2026-05-24-hook-layer-observe-only.md`, `docs/architecture/*`, `docs/system-design.html`, `docs/guides/*`, `servers/exarchos-mcp/src/describe/*` (tests)
**Dependencies:** 015, 016, 017
**Parallelizable:** No (bundle tail)

### Parallelization

Three independent worktree streams, one barrier, one tail:

- **Stream A (skills + naming):** 001 → 002 → 003; 004 → 005 → 006 → 007; 008 (after 004). **009 is the stream barrier** (needs 001–008). Then 010 → 011.
- **Stream B (on-ramp):** 012 → 013 ∥ 014 → 015 (two parallel pairs).
- **Stream C (hooks):** 016 (after 008 — shared `types.ts`) → 017.
- **Tail:** 018 after 015 + 016 + 017.

Critical path: 001 → 002 → 003 → (merge with 004–008) → 009 → 010 → 011, with B and C absorbing parallel capacity. Checkpoint after 009 (stream-A barrier) and before 018 (phase tail), per the ~10-task checkpoint discipline.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); high adds integration across the seam
- [x] Open questions resolved (OQ1–OQ4 dispositions in Scope) — none deferred
- [ ] Ready for `plan-review`
