# Spec: Harness conform-and-shrink bundle (skills collapse · AGENTS.md on-ramp · lifecycle → launcher)

**Date:** 2026-07-04 · **Feature:** `harness-conform-and-shrink` · **Depth:** standard · **Revision:** 2 (final review cycle per owner decision)
**Inputs:** #1599 (roadmap tracker) · #1601 (harness-agnosticism program) · #1602 / #1605 / #1607 (this bundle) · #1603 (launcher, shipped PR #1632) · [`docs/research/2026-06-21-harness-agnosticism-strategy.md`](../research/2026-06-21-harness-agnosticism-strategy.md) · ADR [`docs/adrs/2026-05-24-hook-layer-observe-only.md`](../adrs/2026-05-24-hook-layer-observe-only.md) · live SoTA research 2026-07-04 · plan-review round 1 (23 gaps) + round 2 (17 unique gaps) — both folded in

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> Ships as **v2.12.0-preview.1** — the Z2 tranche of #1601.

## Design & Rationale

### Problem Statement

Exarchos achieves harness-agnosticism today by **brute-force fan-out** rather than by conforming to the standards the ecosystem has since ratified. Three coupled gaps:

1. **Skills fan-out (#1602).** The committed `skills/` tree is 508 files — 6 runtimes × 18 skills — of which 15 skills differ per-runtime *only* in two prefix strings (`MCP_PREFIX`, `COMMAND_PREFIX`). Agent Skills is now a formal multi-vendor standard ([agentskills.io](https://agentskills.io/specification), extracted from Anthropic Dec 2025) loaded natively by every Tier-1 harness, and there is **no ecosystem prior art** for per-runtime SKILL.md *content* rendering — the convention is one file, per-harness *placement*. Our fan-out is pure maintenance drag (`skills:guard` diff surface, dual-baseline snapshot updates) that the standard has made unnecessary.
2. **Vocabulary fork (naming).** The same workflow step has up to three names: the skill name (`brainstorming`), the Claude command verb (`/exarchos:ideate`), and the opencode alias (`ideate`). Nine skills' names drift from their canonical verbs. Upstream, Claude Code has merged commands into skills and Codex is deprecating prompts in favor of skills — the skill name *is* the invocation surface, so the fork is now a defect, not a style choice. INV-4 parity should cover vocabulary, not just guarantees. The authoritative command→skill map (`src/config/canonical-skills.ts`, with a CI drift guard and cross-package consumers) encodes today's fork and must be restructured with it.
3. **On-ramp and lifecycle ride harness-specific hooks (#1605, #1607).** The instruction on-ramp is a per-harness `SessionStart` hook directive (only where `canInjectContext`), and session lifecycle is observed via `SessionStart`/`SessionEnd` hooks — but a session-end signal is unreliable or absent on 3 of 5 hooked harnesses (OpenCode's only end signal is the `session.idle` proxy, which can fire repeatedly and is not a clean end; Cursor headless/cloud don't fire `stop`/`sessionEnd`), and the MCP protocol will never provide a session boundary (shutdown has no protocol message; the 2026 draft spec removes protocol sessions and the `initialize` handshake outright — SEP-2567/SEP-2575, [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)). Meanwhile the launcher (#1603) already emits `launch.executing_started`/`launch.executed` at spawn/exit and ships an ephemeral injection seam (`launcher/injection-seam.ts`) that is **built but has zero production callers**. There is no consumer-repo AGENTS.md injection at all, even though AGENTS.md is now a Linux Foundation (AAIF) standard read natively by every Tier-1 harness except Claude Code — whose own docs prescribe exactly the `CLAUDE.md → @AGENTS.md` shim we need ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)).

The enforcement half of #1607 is **already done**: ADR 2026-05-24 (#1476) deleted the enforcement hooks and centralized gating at the dispatch chokepoint (`dispatch/core/dispatch.ts` readonly + shared-mutating gates). What remains is the residue that ADR left behind: the on-ramp directive, the lifecycle observers, and the docs that still describe hooks as a load-bearing layer.

### Chosen Approach

**Conform-and-shrink onto ratified standards; emit and enforce at chokepoints we own.**

- **#1602 — collapse.** Author the procedural skills once, against **logical qualified tool names** (`exarchos:exarchos_workflow` prose form — Anthropic's documented harness-neutral convention, [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)), rendered to a single canonical `skills/standard/` set. Every surveyed harness keeps the raw tool name as the suffix of its model-visible MCP name, so logical names resolve universally; Codex is moving to fully bare names. Build-render survives **only** for the 3 orchestration skills (`delegation`, `refactor`, `brainstorming`) whose `TASK_TOOL`/`SPAWN_AGENT_CALL`/`CHAIN`/`SUBAGENT_*` tokens genuinely fork per harness — the bespoke moat the issue names, corrected from "~5" to the measured 3.
- **Naming — unify, atomically.** The skill name becomes the canonical verb (9 renames incl. the `workflow-state` split), landed as **one atomic rename wave in a single PR**: skills-src directories, the canonical-name registry, every cross-package consumer, the MCP-server source references, the repo-root eval substrate, the commands' `@skills` references, and all regenerated trees move together — the rename's blast radius is too interconnected for incremental merges to stay green (round-2 finding). Claude's fat `commands/*.md` bodies collapse into the renamed skills, with **thin shims retained for every skill-backed verb this cycle** (older-harness compatibility). The alias emission gate is **already capability-keyed in the tree** (verified: `build-command-aliases.ts` gates on `capabilities.canonicalCommandAliases`, no runtime literals) — the alias work is regeneration under new verb names only.
- **#1605 — standard on-ramp.** A consumer-side **managed-block inserter** with Ruler-hardened semantics writes the Exarchos on-ramp block into the consumer's `AGENTS.md` (users own the file; we own only our block), plus a `CLAUDE.md` managed block holding a one-line `@AGENTS.md` import. The block content is **runtime-neutral** (one block, every harness — the binding source is rewritten to the logical form first, together with its only production consumer `build-hooks.ts`). Where the launcher is used, orientation is injected **ephemerally at spawn** through each harness's channel, resolved by a **spawn-time capability probe** — zero repo mutation; the managed block is the direct-launch floor.
- **#1607 — lifecycle to the launcher, hooks retired where a replacement actually reaches the consumer.** The launcher becomes the lifecycle + injection authority (decision 2026-07-04): the `SessionEnd` observer, the codex hooks artifact, the opencode lifecycle plugin, and the **onboard-installed** `SessionStart` directive are retired (the managed block replaces the on-ramp for every onboard-reachable consumer — with the reconcile-layer plumbing to actually reach them, a round-2 finding). The **Claude plugin bundle's auto-loaded `SessionStart` on-ramp is retained this cycle**, concretely specified: the neutral binding block baked as its `--directive` payload. `SubagentStop` survives as the only token-attribution seam. Direct launches fall back to the AGENTS.md managed block for on-ramp and to event-sourced liveness reconciliation (WLM, INV-10) for lifecycle — reconcile-on-next-entry, never a daemon (INV-15).

## Requirements

### DR-1: Procedural skills collapse to one standard SKILL.md with logical tool names

The procedural skills (15 today; 16 after the `workflow-state` split) are authored once, with no `MCP_PREFIX`/`COMMAND_PREFIX` tokens; prose tool references use the qualified logical form (`exarchos:<tool_name>`); machine-parsed frontmatter keeps `metadata.mcp-server: exarchos` and never carries harness-prefixed names.

**Acceptance criteria:**
- Rendered per-runtime variants for the procedural skills are deleted (this occurs naturally at Task 003 via the renderer's `cleanStaleFiles` pass and is committed there — the legacy-hash manifest does not depend on their working-tree presence, see DR-8); the committed tree becomes `skills/standard/<verb>/` plus the 3 × 6 orchestration residual and shared fixtures.
- `grep -r "MCP_PREFIX\|COMMAND_PREFIX"` over every procedural source (16 post-split) returns empty; the placeholder lint **rejects** prefix tokens in procedural sources.
- Each collapsed SKILL.md validates against the agentskills.io spec (`name` matches directory, ≤64 chars, description ≤1024).
- `skills:guard` covers the canonical set plus the residual rendered set; renderer comment stating "canonical five tokens" corrected.

### DR-2: Orchestration residual keeps build-render, with enforced classification

`delegation` (→ `delegate`), `refactor`, and `brainstorming` (→ `ideate`) retain per-runtime rendering for the 5 orchestration tokens and `<!-- requires:* -->` capability gating (used only by `delegation`).

**Acceptance criteria:**
- The 3 orchestration skills render per-runtime exactly as today, under their new verb names.
- The build fails if a procedural skill introduces an orchestration token.
- `assertRuntimeTokenCoverage` still guarantees every runtime declares all orchestration tokens; prefix tokens drop from the required-coverage set only after **both** the procedural rewrite and the binding-source neutralization land (no residual consumer).

### DR-3: One canonical verb vocabulary across all six runtimes

Skill name = directory name = canonical verb. Renames: `brainstorming`→`ideate`, `implementation-planning`→`plan`, `delegation`→`delegate`, `synthesis`→`synthesize`, `discovery`→`discover`, `oneshot-workflow`→`oneshot`, `prune-workflows`→`prune`, `authoring-invariants`→`invariants`, `workflow-state`→ split into `rehydrate` + `checkpoint`. The rename lands as **one atomic wave (single PR)** covering: skills-src, `src/config/canonical-skills.ts` (map collapses toward identity; `rehydrate` leaves `COMMAND_ONLY`) + drift guard + `command-shim-emitter.ts` + loader/characterization tests, server-source literals (`workflow/playbooks.ts`, `state-store.ts`, `test-runtime-resolver.ts`, `doctor/probes.ts`, `task-decomposition.ts`, `merge-preflight.ts`), server tests reading skills-src from disk (`runbooks/skill-coverage.test.ts`, `verbs/template-roundtrip.test.ts`, `__tests__/skills/*`, `__tests__/integration/ideate-update-action.test.ts`), the repo-root eval substrate (`evals/<old>/` dirs + `suite.json` `metadata.skill` literals + loader/harness assertions), `commands/*.md` `@skills` references, and all regenerated trees (`skills/`, `command-aliases/`, baselines).

**Acceptance criteria:**
- On every runtime, the user-facing invocation vocabulary is identical (e.g. `ideate` invokes the same content whether surfaced as `/exarchos:ideate`, `$ideate`, or the `ideate` skill).
- No skill-backed `commands/*.md` body duplicates skill content; all skill-backed commands become thin shims — **none deleted this cycle** (older-Claude compatibility; deletion deferred until a minimum-harness-version policy exists). `autocompact.md`/`tag.md` are exempt (command-only); the no-duplication guard is scoped to skill-backed commands.
- The atomic wave merges with both packages' full suites, both typechecks, and all guards green in the same PR — no intermediate red-CI window.
- `onboard` migrates consumer installs per the DR-8 provenance policy (manifest or multi-release legacy-hash bootstrap); modified/unmatched dirs preserved with a warning.

### DR-4: Install layout aligns to the `.agents/skills/` cross-client convention

The canonical skill set installs to `.agents/skills/` (project) / `~/.agents/skills/` (user) with per-harness placement; Windows uses copy-mode, never symlinks; installs write a provenance manifest. No distribution CLI is adopted as primary in this bundle.

**Acceptance criteria:**
- `installSkills()` places the canonical set at the convention path and per-harness native dirs; on `win32`, placement is file copy (INV-16). Manifest scope is explicit: one manifest per install scope (project / user), enumerating per-harness placement paths, with directory-name keys treated case-insensitively on case-insensitive filesystems.
- Every install writes/updates the provenance manifest (installed names + newline-normalized content hashes + version).
- Versioning flows through the **single source of truth**: root `package.json` bumped to `2.12.0-preview.1`, `scripts/sync-versions.sh` propagates to all five sinks (plugin.json incl. `minBinaryVersion`, manifest.json, server package.json, both `SERVER_VERSION` literals), `version:check` green; the release tag is coordinated with the package version.
- `.claude-plugin/` packaging consistency is asserted by a **local** manifest-parse test (paths exist, skill declarations parse — no network `npx` invocation in CI).
- `doctor` reports layout drift read-only.

### DR-5: Consumer-side managed-block inserter with Ruler-hardened semantics

A managed-block writer inserts/updates the Exarchos on-ramp block in the consumer's `AGENTS.md` and a `CLAUDE.md` managed block containing a one-line `@AGENTS.md` import (own line). Users own their files; Exarchos owns only its marker-fenced block.

**Acceptance criteria:**
- Complete-pair-only markers (incomplete pair ⇒ treated absent, content never claimed, fresh block appended + warning — Ruler #601 designed out).
- Content-hash idempotency (identical ⇒ no write, no backup); changed block ⇒ backup once, in-place replacement touching nothing outside the markers.
- The block is **runtime-neutral**: `binding-src/binding.md` rewritten to the logical form, `renderBindingBlock` de-parameterized, one `binding/standard/block.md` serves every harness — landed **together with its only production caller** (`src/build-hooks.ts`) and regenerated `hooks/**` + `binding/**` so typecheck and `hooks:guard` (which diffs both trees) stay green in the same PR.
- Provenance line inside the block; atomic temp+rename writes; LF/CRLF detection & preservation (INV-16).
- AGENTS.md block self-contained (no `@imports`); block ≤ 4 KiB; warn near the Codex 32 KiB cap.
- Fence syntax matches `binding.ts` (OQ2); the server-package module carries its own fence constants with a **cross-package equality guard test** (reads the root `src/binding.ts` source text and asserts the constants match — no root→server import, no JS bridge, no silent drift).

### DR-6: Ephemeral spawn-time injection wired through per-harness native channels

`injectOrientation` is wired into `lifecycle-core.ts`; the injection channel is a per-harness declared **static candidate list** on the spawn descriptor, resolved by a **spawn-time capability probe**.

**Acceptance criteria:**
- Descriptors declare candidates: Claude Code `--append-system-prompt-file` → fallback string-valued `--append-system-prompt`; Codex `-c developer_instructions=…`; Copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (temp-dir synthetic AGENTS.md); OpenCode `OPENCODE_CONFIG_CONTENT`; Cursor `none` → documented managed-block fallback. Descriptors stay pure data (the registry's no-behavior property is pinned by its type-test).
- **Probe timing defined:** `lifecycle-core` resolves the candidate at spawn time via a cached-per-process help probe using the win32-safe spawn path (`runCommandSync`/`resolveExecutable`); CLI absent or probe failure ⇒ channel `none` + degradation recorded (composes with DR-8 fail-open).
- A launcher-spawned session on each channel-bearing harness observes the orientation with zero repo-file mutation; `--dry-run` prints the resolved channel + payload without spawning or probing side effects.
- Orientation payload derives from `binding/standard/block.md` (one content source, two delivery mechanisms); the `EXARCHOS_DIRECTIVE`-refusal property is preserved.

### DR-7: Launcher is the lifecycle authority; hooks retired where a replacement reaches the consumer

Session lifecycle is sourced from `launch.executing_started`/`launch.executed`. Retired: `SessionEnd` observer, codex hooks artifact, opencode lifecycle plugin, and the **onboard-installed** `SessionStart` directive. Retained: `SubagentStop` (token-attribution seam) and the **Claude plugin bundle's auto-loaded `SessionStart` on-ramp** — concretely: the plugin template bakes the runtime-neutral `binding/standard/block.md` content as its `--directive` payload (≤ 4 KiB), with the hook command's binary-resolution verified (`exarchos` on PATH, with the `${CLAUDE_PLUGIN_ROOT}`-relative form evaluated as the robust alternative). Its retirement is a tracked follow-up gated on a plugin-flow managed-block pathway.

**Acceptance criteria:**
- `hooks/hooks.json` ships `SubagentStop` + the specified minimal `SessionStart` on-ramp, no `SessionEnd`; codex/opencode lifecycle artifacts no longer generated; `hooks:guard` green.
- `onboard` reaches the retired-hook population: the reconcile layer gains the plumbing a round-2 audit showed missing — a **retired-hooks-present doctor check** (remediable exactly when provenance-matched retired hooks exist), its `CHECK_CLASSIFICATION` entry, and **plan-step ordering** placing the managed-block write before hook removal, with the removal step consulting the block-write outcome (skip removal if the block write failed) — so no consumer transitions through hook-less + block-less.
- Hook uninstall is command-marker provenance-matched, idempotent, never touches user-authored hooks.
- Liveness verbs answer from `launch.*` events alone for launcher-spawned sessions — verified against the real surfaces (`exarchos_view` `ps`/`wait`, `views/composite.ts` + WLM handlers); direct launches answer from reconciliation, documented.
- `session-start`/`session-end` CLI verbs stay (OQ3); ADR 2026-05-24 addendum; onboard parity baseline updated by the same task that changes the contract.

### DR-8: Failure-mode handling for every file-mutating and spawn-path surface

**Acceptance criteria:**
- Managed-block writer: unwritable target → structured error with `suggestedFix`; missing `AGENTS.md` → created with just the block; concurrent-writer collision → atomic rename + post-write re-read verification with structured warning on mismatch.
- Spawn injection: channel construction/probe failure → launch **proceeds** without orientation, degradation recorded on `launch.executing_started`.
- Provenance policy: deletion only on (a) install-manifest match, or (b) **multi-release legacy-hash bootstrap** — a committed manifest of newline-normalized content hashes of the procedural renders **across historical releases** (generated from git history at the release tags, v2.9.0 through the current HEAD — not a single snapshot, and independent of working-tree state, so `cleanStaleFiles` deletions during regeneration cannot orphan it). Symlinked installs: remove the link only, never the target. No provenance match ⇒ no deletion + warning + `doctor` finding; never inferred from backup absence.
- Windows coverage: managed-block module lives in the server package (existing `test-windows` lane); a new **root-package Windows lane** covers the installer surfaces (proven live by Task 010's tests; Task 012's run in the existing server lane).

## Technical Design

**Renderer split (`src/build-skills.ts`).** Classification derived from token usage, asserted at build time. Procedural skills render once to `skills/standard/<verb>/`; orchestration skills keep the per-runtime pipeline. **Regeneration is distributed:** every source-editing task regenerates and commits its affected outputs in the same PR (`skills/`, `command-aliases/`, `binding/`, `hooks/`, `src/runtimes/embedded.ts` via `codegen:runtimes`, snapshot baselines) so all guards stay green per merge; the renderer's `cleanStaleFiles` pass performs the stale-render deletions naturally during those regenerations (no separate deletion step). After each merge into the integration branch, guards re-run there — the Task 009 sweep is the final consistency check, not the regeneration owner.

**Atomic rename wave.** All rename surfaces move in one PR (Task 004): the round-2 audit proved the blast radius (registry drift guard re-derived from command files, server tests reading `skills-src/` from disk, playbook/runbook literals, repo-root `evals/` + `suite.json` metadata) cannot merge incrementally without a deterministically red CI window between partial landings.

**Binding neutralization (with its consumer).** `binding-src/binding.md` → logical form; `renderBindingBlock` de-parameterized; `binding/standard/block.md` emitted — landed together with `src/build-hooks.ts` (the only production caller: it renders the SessionStart `--directive` and owns the `binding/` output layout) and the regenerated `hooks/**` + `binding/**`, because `hooks:guard` diffs both trees (Task 006).

**Managed-block module.** `servers/exarchos-mcp/src/onramp/managed-block.ts` (server package — onboard writers import directly; tests in the existing Windows lane). Own fence constants + a cross-package equality guard test against root `src/binding.ts` source text (no import, no bridge, drift caught). DR-5/DR-8 semantics; `doctor` diffs desired-vs-actual by hash.

**Launcher injection.** `HarnessDescriptor.injection` = static candidate list (pure data; type-test-pinned). `lifecycle-core` resolves at spawn via a cached win32-safe help probe; `injectOrientation` applies the resolved channel during spawn-descriptor assembly. The injection seam currently has zero production callers — this task wires it live for the first time.

**Hook shrink + reconcile plumbing.** `build-hooks` drops `SessionEnd` + codex/opencode lifecycle emission; the Claude plugin artifact keeps `SubagentStop` + the specified `SessionStart` (neutral-block directive baked at build). Onboard gains the retired-hooks doctor check + classification + ordered plan steps (block write before provenance-matched hook removal, with cross-step outcome consultation) in `dispatch/core/onboarding/reconcile.ts` + `orchestrate/doctor/checks/`; the parity baseline updates in the same task.

**Versioning.** Root `package.json` is the single source of truth; `scripts/sync-versions.sh` propagates; `version:check` gates drift; release tag coordinated (Task 022).

**Invariants preserved.** INV-4: one content source per skill + one runtime-neutral binding block; the orchestration residual is the only runtime-forked text. INV-2: no adapter logic added. INV-11/INV-12: unchanged; enforcement stays at dispatch. INV-15: launcher events + reconcile-on-next-entry, no daemon. INV-16: copy-mode installs, CRLF preservation, atomic writes, dual Windows lanes, win32-safe probe spawns. INV-10: `launch.*` remains the liveness protocol.

## Integration Points

- `src/build-skills.ts`, `src/placeholder-lint.ts`, `src/skills-guard.ts` — renderer split, classification, standard-tree emission, CHAIN validation
- `src/config/canonical-skills.ts` (+ drift guard) · `command-shim-emitter.ts` · loader/characterization tests — registry restructure (atomic wave)
- `skills-src/*`, `commands/*.md`, `command-aliases/`, `evals/**` (repo root), server-source literals + disk-reading tests — atomic wave surfaces
- `binding-src/binding.md`, `src/binding.ts`, `src/build-hooks.ts`, `binding/**`, `hooks/**` — neutralization with consumer
- `src/install-skills.ts`, `verbs/onboard/install.ts`, `migrations/` legacy-hash manifest + generator — layout, provenance, migration
- `servers/exarchos-mcp/src/onramp/managed-block.ts` (new) + fence-equality guard
- `orchestrate/init/writers/*.ts`, `orchestrate/onboard/*`, `dispatch/core/onboarding/reconcile.ts`, `orchestrate/doctor/checks/` (+ parity baseline) — block writes, retired-hooks check, ordered uninstall
- `servers/exarchos-mcp/src/launcher/*` — candidate lists, spawn-time probe, wiring
- `hooks-src/*`, `src/hooks-guard.ts` — hook shrink with specified plugin carve-out
- `runtimes/*.yaml`, `src/runtimes/types.ts`, `src/runtimes/embedded.ts` (codegen) — capability model
- `.github/workflows/ci.yml` — root Windows lane
- `package.json` + `scripts/sync-versions.sh` (+ five sinks) — preview version
- `docs/architecture/*`, ADR addendum, `docs/system-design.html`, `docs/guides/*` — truth-up
- Test surfaces: dual-baselines, `rehydrate-demo.expected-document.json`, parity tests, server typecheck, both Windows lanes

## Alternatives considered

- **Install-time prefix resolution.** Rejected (#1602 + research): a shared `.agents/skills/` path cannot carry a baked prefix. The same argument forces binding neutralization — a per-runtime block in a shared AGENTS.md would be install-time prefix baking.
- **Fully bare tool names in prose.** Viable, but Anthropic documents the qualified `Server:tool` form as the robust convention; equally harness-neutral, so we take the documented form.
- **Symlink `CLAUDE.md → AGENTS.md`.** Rejected: official docs prefer the import on Windows; symlinks break copy workflows and non-Developer-Mode Windows (INV-16).
- **Two-layer hooks everywhere.** Rejected by owner decision 2026-07-04, with one evidence-forced carve-out: the Claude plugin's SessionStart on-ramp survives because plugin-marketplace consumers have no other on-ramp path. Full retirement is a tracked follow-up.
- **Incremental rename landing (004/005/019/020 split).** Rejected in revision 2: the round-2 audit proved a deterministically red CI window between partial landings; the wave is atomic.
- **MCP-handshake session detection.** Rejected: no shutdown message today; the 2026 draft removes sessions and `initialize` entirely.
- **Adopt `vercel-labs/skills` as primary distribution.** Deferred (Windows immaturity: symlink privileges, lockfile #399, CRLF #781); we align with its layout so later adoption is cheap.
- **Status-quo per-runtime rendering.** Rejected: zero ecosystem prior art; pure carrying cost.

## Open Questions

1. **`workflow-state` verb split.** Resolved: split into `rehydrate` + `checkpoint` (atomic wave); `rehydrate` leaves `COMMAND_ONLY`.
2. **Marker syntax.** Resolved: keep the `binding.ts` fence; provenance line inside the block; cross-package constant-equality guard instead of a shared import.
3. **`session-start`/`session-end` CLI verbs.** Resolved: verbs stay; only hook registration retires.
4. **`generic` runtime lifecycle claim.** Resolved: documented contract — reconciliation-only lifecycle, managed-block on-ramp.

## Decomposition

### Scope

**Target:** Full design (DR-1 … DR-8), revision 2 — folds in round 1 (23 gaps) and round 2 (17 unique gaps: 7 HIGH, 5 MEDIUM, 5 LOW). Owner declared this the final review cycle; approval follows this revision.
**Excluded:** None deferred silently. Explicit deferrals: Claude-plugin SessionStart retirement (DR-7, follow-up issue at synthesis); thin-shim deletion (DR-3); distribution-CLI adoption (Alternatives).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Procedural skills collapse to one standard SKILL.md | 001, 002, 003, 006, 009 |
| DR-2 | Orchestration residual keeps build-render, enforced classification | 001, 002, 009 |
| DR-3 | One canonical verb vocabulary — atomic rename wave | 004, 007, 011 |
| DR-4 | Install layout + provenance manifest + versioned packaging | 010, 022 |
| DR-5 | Managed-block inserter, runtime-neutral, with consumer coupling | 006, 012, 013 |
| DR-6 | Spawn-time injection via probed channels | 014, 015 |
| DR-7 | Launcher lifecycle authority; hooks retired with real reach | 016, 017, 018 |
| DR-8 | Failure modes: provenance bootstrap, fail-open spawn, Windows lanes | 010, 011, 012, 015, 017, 021, 023 |

### Task 001: Renderer skill classification (procedural vs orchestration) with build-time assertion

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** Derive each skill's class from token usage; expose on the renderer's skill model; fail the build when a procedural skill references an orchestration token or `<!-- requires:* -->` block. Fix the stale "canonical five tokens" comment.
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Expected tests:** `classifySkill_PrefixOnlySource_ClassifiedProcedural`, `classifySkill_ProceduralSourceWithOrchestrationToken_FailsBuild`, `classifySkill_RequiresBlockInProceduralSource_FailsBuild`
**Files:** `src/build-skills.ts`, `src/build-skills.test.ts`
**Dependencies:** None
**Parallelizable:** Yes (stream A head)

### Task 002: Placeholder-lint rules for the collapsed vocabulary

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** `lintPlaceholders` rejects prefix tokens in procedural sources; orchestration tokens valid only in orchestration skills. Prefix tokens leave `assertRuntimeTokenCoverage`'s required set only after Task 006 (rewrite + binding neutralization — the last consumers) lands.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `lintPlaceholders_PrefixTokenInProceduralSkill_Rejected`, `lintPlaceholders_OrchestrationTokenInOrchestrationSkill_Allowed`, `assertRuntimeTokenCoverage_PrefixTokensStillConsumed_Required`
**Files:** `src/placeholder-lint.ts`, `src/placeholder-lint.test.ts`, `src/build-skills.ts`
**Dependencies:** 001
**Parallelizable:** No (stream A)

### Task 003: `skills/standard/` single-render emission + guard + CHAIN validation (stale renders deleted here)

**Risk Tier:** medium
**Implements:** DR-1
**Description:** Procedural skills render once to `skills/standard/<verb>/`; per-runtime emission narrows to the orchestration set; `skills:guard` covers both trees; adds `CHAIN` target validation. **The renderer's `cleanStaleFiles` pass deletes the ~90 per-runtime procedural renders during this task's regeneration — the deletions are committed here** (the legacy-hash manifest is git-history-derived, Task 023, and does not need them on disk).
**Verification (medium):** scoped tests + kill-probe; `skills:guard` green in-task.
**Expected tests:** `buildAllSkills_ProceduralSkill_EmitsSingleStandardVariant`, `buildAllSkills_OrchestrationSkill_EmitsPerRuntimeVariants`, `skillsGuard_StandardTreeDrift_Fails`, `chainToken_TargetSkillMissing_FailsBuild`
**Files:** `src/build-skills.ts`, `src/skills-guard.ts`, `src/build-skills.test.ts`, `skills/**` (regenerated incl. deletions)
**Dependencies:** 001, 002
**Parallelizable:** No (stream A)

### Task 023: Multi-release legacy-render hash manifest (git-history-derived)

**Risk Tier:** medium
**Implements:** DR-8
**Description:** Generator script + committed manifest (`migrations/legacy-skill-render-hashes.json`): newline-normalized content hashes of every per-runtime procedural skill render **across historical releases** — enumerated from git history at release tags (v2.9.0 → current HEAD) — so pre-existing installs of any prior release hash-match. Independent of working-tree state (immune to `cleanStaleFiles`). Records skill name, runtime, release, hash.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `legacyHashManifest_CoversAllReleaseTags`, `legacyHashManifest_HashesAreNewlineNormalized`, `legacyHashGenerator_WorktreeStateIrrelevant_SameOutput`
**Files:** `scripts/generate-legacy-skill-hashes.mjs`, `migrations/legacy-skill-render-hashes.json`, generator test
**Dependencies:** None
**Parallelizable:** Yes (any time; consumed by 011)

### Task 004: Atomic rename wave — one PR, every rename surface

**Risk Tier:** high
**Implements:** DR-3
**Description:** In a single PR: (a) rename 8 skills-src dirs + split `workflow-state` into `rehydrate`/`checkpoint` (frontmatter `name` == dir); (b) restructure `src/config/canonical-skills.ts` (identity-collapsed map, `rehydrate` out of `COMMAND_ONLY`) + drift-guard test + `command-shim-emitter.ts` + `ideate-loader.test.ts` + install-skills characterization tests; (c) server-source literals: `workflow/playbooks.ts` `skill:`/`skillRef:`, `state-store.ts:544`, `test-runtime-resolver.ts:121`, `doctor/probes.ts:246`, `task-decomposition.ts:199/364`, `verbs/pure/merge-preflight.ts:338`; (d) server tests reading skills-src from disk: `runbooks/skill-coverage.test.ts`, `verbs/template-roundtrip.test.ts`, `__tests__/skills/prune-workflows.test.ts`, `__tests__/skills/oneshot-workflow.test.ts`, `__tests__/integration/ideate-update-action.test.ts`; (e) repo-root `evals/{brainstorming→ideate, implementation-planning→plan, delegation→delegate}` + `suite.json` `metadata.skill` literals + `dataset-loader.test.ts` + `harness.test.ts`; (f) `commands/*.md` `@skills` references; (g) regenerate `skills/**`, `command-aliases/**`, snapshot dual-baselines.
**Verification (high):** medium set + **both packages' full suites, both typechecks, all guards green in this single PR**.
**Expected tests:** `buildAllSkills_RenamedSkillNames_MatchDirectories`, `canonicalSkills_PostUnification_MapIsIdentityForSkillBackedVerbs`, `canonicalSkills_Rehydrate_IsSkillBacked`, `playbooks_SkillRefs_ResolveAgainstRenamedTree`, `datasetLoader_RenamedEvalDirs_Loads`, `harness_SkillList_UsesCanonicalVerbs`
**Files:** `skills-src/**` (renamed dirs), `src/config/canonical-skills.ts` (+ test), `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts`, `servers/exarchos-mcp/src/commands/ideate-loader.test.ts`, `servers/exarchos-mcp/src/workflow/playbooks.ts`, `servers/exarchos-mcp/src/workflow/state-store.ts`, `servers/exarchos-mcp/src/config/test-runtime-resolver.ts`, `servers/exarchos-mcp/src/doctor/probes.ts`, `servers/exarchos-mcp/src/verbs/tasks/task-decomposition.ts`, `servers/exarchos-mcp/src/verbs/pure/merge-preflight.ts`, `servers/exarchos-mcp/src/runbooks/skill-coverage.test.ts`, `servers/exarchos-mcp/src/verbs/template-roundtrip.test.ts`, `servers/exarchos-mcp/src/__tests__/**`, `evals/**`, `commands/*.md`, `skills/**` + `command-aliases/**` + baselines (regenerated)
**Dependencies:** 003
**Parallelizable:** No (stream A — the wave)

### Task 006: Procedural rewrite to logical names + binding neutralization with its consumer

**Risk Tier:** medium
**Implements:** DR-1, DR-5
**Description:** Rewrite the 16 procedural skills + references to the qualified logical form (`exarchos:<tool>`, canonical verbs). Neutralize the binding source **together with its only production caller**: `binding-src/binding.md` → logical form; `renderBindingBlock` de-parameterized; `src/build-hooks.ts` call sites adapted (directive rendering + `binding/` layout + emission of `binding/standard/block.md`); regenerate `binding/**`, `hooks/**`, `skills/**` in-task (`hooks:guard` diffs hooks + binding — both committed here). Then drop prefix tokens from required coverage (completing 002).
**Verification (medium):** scoped tests + kill-probe; root typecheck + `skills:guard` + `hooks:guard` green in-task.
**Expected tests:** `lintPlaceholders_RewrittenProceduralTree_NoPrefixTokens`, `renderBindingBlock_NoPlaceholders_RuntimeNeutralOutput`, `bindingStandardBlock_SameContentForAllRuntimes`, `buildAllHooks_DirectiveUsesNeutralBlock`
**Files:** 16 × `skills-src/<verb>/SKILL.md` + `references/`, `binding-src/binding.md`, `src/binding.ts`, `src/build-hooks.ts`, `binding/**` + `hooks/**` + `skills/**` (regenerated)
**Dependencies:** 004
**Parallelizable:** No (stream A)

### Task 007: Collapse fat `commands/*.md` bodies into skills; thin shims

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Migrate command-only content into the corresponding skills; every skill-backed command becomes a thin shim (no deletions; `autocompact`/`tag` exempt; guard scoped to skill-backed). Regenerate `command-aliases/**` (alias files lift command descriptions) + `skills/**` in-task.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `commandsTree_SkillBackedCommands_NoBodyDuplication`, `commandsTree_CommandOnlySurfaces_Exempt`, trigger-tests resolve each verb
**Files:** `commands/ideate.md`, `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`, `commands/debug.md`, `commands/refactor.md`, `commands/oneshot.md`, `commands/rehydrate.md`, `commands/checkpoint.md`, `commands/cleanup.md`, `commands/discover.md`, `commands/dogfood.md`, `commands/prune.md`, `commands/shepherd.md`, `commands/invariants.md`, corresponding `skills-src/<verb>/SKILL.md` fold-in targets, `command-aliases/**` + `skills/**` (regenerated)
**Dependencies:** 006
**Parallelizable:** No (stream A tail)

### Task 021: Root-package Windows CI lane

**Risk Tier:** low
**Implements:** DR-8
**Description:** Extend `.github/workflows/ci.yml` with a Windows lane running **root-package** tests (existing `test-windows` covers only `servers/exarchos-mcp`), gated on root-source changes, wired into the blocking-status flow. Proven live by Task 010's installer tests (Task 012's tests run in the existing server lane).
**Verification (low):** static analysis + observed green lane on this task's PR.
**Files:** `.github/workflows/ci.yml`
**Dependencies:** None
**Parallelizable:** Yes (any stream)

### Task 010: Install layout — `.agents/skills/` + copy-mode + provenance manifest

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4, DR-8
**Description:** `installSkills()` places the canonical set at the convention paths + per-harness native dirs; `win32` copy-mode; **every install writes/updates a provenance manifest per install scope** (project/user; enumerates per-harness placement paths; newline-normalized hashes; case-insensitive directory-key semantics documented); `doctor` drift finding; `npx skills add` fallback retained. Installer learns `skills/standard/` before consuming tasks depend on it.
**Verification (medium):** scoped tests + kill-probe (Windows behavior in the Task 021 root lane).
**Expected tests:** `installSkills_CanonicalLayout_PlacesAgentsSkillsDir`, `installSkills_Win32_UsesCopyNotSymlink`, `installSkills_EveryInstall_WritesScopedProvenanceManifest`, `doctor_CanonicalCopyStale_ReportsDrift`
**Files:** `src/install-skills.ts`, `src/install-skills.test.ts`, `servers/exarchos-mcp/src/verbs/onboard/install.ts`
**Dependencies:** 003, 021
**Parallelizable:** Yes (after 003; parallel with 004-007)

### Task 009: Consistency sweep — idempotence, golden fixture, full integration

**Risk Tier:** high
**Implements:** DR-1, DR-2 (final state)
**Description:** With all source tasks landed guard-green: (a) build idempotence (`build:skills` + `build:hooks` twice → no diff); (b) regenerate `rehydrate-demo.expected-document.json` if `compactGuidance`/`next_actions` prose changed; (c) parity tests verified; (d) full `vitest run` at root **and** `servers/exarchos-mcp`, both typechecks, all guards on the integrated tree. (Stale-render deletion already happened at 003 via `cleanStaleFiles`; the legacy manifest is Task 023's, git-history-derived.)
**Verification (high):** medium set + full integration across both packages.
**Expected tests:** `buildSkills_SecondRun_NoDiff`, `buildHooks_SecondRun_NoDiff`, plus all existing suites green on the integrated tree
**Files:** `servers/exarchos-mcp/**/rehydrate-demo.expected-document.json` (if regenerated), integration verification only
**Dependencies:** 004, 006, 007, 010
**Parallelizable:** No (stream A barrier — final)

### Task 011: Onboard rename migration — provenance-gated, multi-release bootstrap

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-8
**Description:** Onboard reconciler removes stale old-name skill dirs across **both install scopes and all per-harness `skillsInstallPath` locations** when provenance is established via (a) the Task 010 manifest or (b) the Task 023 multi-release hash manifest (newline-normalized compare). Symlinked dirs: remove the link only. Modified/unmatched → preserved + warning + `doctor` finding; new names installed in the same pass; idempotent.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `onboardMigrate_ManifestProvenance_Removed`, `onboardMigrate_LegacyHashMatchAnyRelease_Removed`, `onboardMigrate_CrlfInstalledCopy_StillMatches`, `onboardMigrate_SymlinkedInstall_RemovesLinkOnly`, `onboardMigrate_UserModifiedDir_PreservedWithWarning`, `onboardMigrate_RepeatedRuns_Idempotent`
**Files:** `servers/exarchos-mcp/src/verbs/onboard/install.ts` (+ tests), `src/install-skills.ts`
**Dependencies:** 023, 013, 017, 009
**Parallelizable:** No (onboard-package chain tail: 013 → 017 → 011)

### Task 012: `insertManagedBlock` — consumer-side writer (server package)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-5, DR-8
**Description:** New module `servers/exarchos-mcp/src/onramp/managed-block.ts`. Carries its own fence constants (matching `binding.ts`) plus a **cross-package equality guard test** that reads root `src/binding.ts` source text and asserts the constants match (no root import, no JS bridge, drift caught). Semantics: complete-pair-only, content-hash idempotency, backup-once, provenance line, LF/CRLF preservation, atomic temp+rename, missing-file creation, structured errors, post-write re-read verification.
**Verification (high):** medium set + property tests (outside-block invariance) + Windows-lane CRLF coverage (existing server lane).
**Expected tests:** `insertManagedBlock_IncompletePair_TreatsAbsentAppendsFresh`, `insertManagedBlock_IdenticalContent_NoWriteNoBackup`, `insertManagedBlock_ChangedBlock_BacksUpOnceThenReplacesInPlace`, `insertManagedBlock_CrlfFile_PreservesLineEndings`, `insertManagedBlock_MissingFile_CreatesWithBlock`, `insertManagedBlock_UnwritableTarget_StructuredError`, `fenceConstants_MatchRootBindingSource`, property: `outsideContent_InvariantUnderAnyBlockOperationSequence`
**Files:** `servers/exarchos-mcp/src/onramp/managed-block.ts`, `servers/exarchos-mcp/src/onramp/managed-block.test.ts`
**Dependencies:** None (stream B head)
**Parallelizable:** Yes

### Task 013: Onboard writers — AGENTS.md block + CLAUDE.md shim + doctor drift

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5
**Description:** Runtime writers emit the runtime-neutral block (`binding/standard/block.md`) into consumer `AGENTS.md` via `insertManagedBlock`; claude writer maintains the `CLAUDE.md` block (own-line `@AGENTS.md` import); size guards; no `@imports` in the AGENTS.md block; `doctor` hash-diff finding.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `claudeWriter_Shim_ImportOnOwnLineInsideBlock`, `writers_AgentsMdBlock_RuntimeNeutralAndNoAtImports`, `writer_FileNearCodexCap_Warns`, `doctor_BlockHashDrift_ReportsFinding`
**Files:** `servers/exarchos-mcp/src/verbs/init/writers/*.ts`, `servers/exarchos-mcp/src/verbs/onboard/*` (+ tests)
**Dependencies:** 012, 006
**Parallelizable:** No (onboard chain: 013 → 017 → 011)

### Task 014: Injection-channel candidate lists on the harness registry

**Risk Tier:** medium
**Implements:** DR-6
**Description:** `HarnessDescriptor` gains `injection`: a **static candidate list** (pure data — the registry's no-behavior property stays type-test-pinned): claude `[--append-system-prompt-file, --append-system-prompt]`; codex config-flag; copilot env-dir; opencode config-json; cursor none. Provenance + fallback documented per entry. `codegen:runtimes` + `runtimes:guard` green if schema touched. (Probe execution lives in 015, not here.)
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `harnessRegistry_EveryHarness_DeclaresInjectionCandidates`, `injectionChannel_Cursor_IsNone`, `harnessRegistry_RemainsPureData`
**Files:** `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `servers/exarchos-mcp/src/launcher/harnesses/*.ts` (+ tests)
**Dependencies:** None (stream B, parallel with 012)
**Parallelizable:** Yes

### Task 015: Spawn-time channel probe + `injectOrientation` wiring (fail-open, dry-run-visible)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-6, DR-8
**Description:** `lifecycle-core` resolves the candidate **at spawn time** via a cached-per-process help probe using the win32-safe spawn path (`runCommandSync`/`resolveExecutable` — the `.cmd`-shim class); CLI absent / probe failure ⇒ channel none + degradation recorded. Applies the resolved channel via `injectOrientation` (first production caller of the seam); payload from `binding/standard/block.md`; construction failure ⇒ launch proceeds + degradation on `launch.executing_started`; `--dry-run` prints resolved channel + payload without side effects; `EXARCHOS_DIRECTIVE`-refusal preserved.
**Verification (high):** medium set + integration across the spawn seam (fake harness binary capturing argv/env, incl. probe behavior) + Windows lane.
**Expected tests:** `channelProbe_FlagPresent_SelectsPrimary`, `channelProbe_FlagAbsent_FallsBackToStringFlag`, `channelProbe_CliMissing_ChannelNoneWithDegradation`, `channelProbe_ResultCachedPerProcess`, `runLifecycle_InjectionConstructionFails_LaunchProceedsWithDegradationRecorded`, `launcherVerb_DryRun_PrintsResolvedChannelAndPayload`, `injectOrientation_DirectiveKey_StillRefused`
**Files:** `servers/exarchos-mcp/src/launcher/lifecycle-core.ts`, `servers/exarchos-mcp/src/launcher/injection-seam.ts`, `servers/exarchos-mcp/src/launcher/verb.ts` (+ tests)
**Dependencies:** 014, 006
**Parallelizable:** No (follows 014)

### Task 016: Hook-surface shrink (specified plugin carve-out)

**Risk Tier:** medium
**Implements:** DR-7
**Description:** `build-hooks` emission: drop `SessionEnd` everywhere; stop emitting codex hooks + opencode lifecycle plugin (source deletion: `hooks-src/opencode-plugin.ts.tmpl`); Claude plugin artifact keeps `SubagentStop` + **the specified SessionStart on-ramp** — the runtime-neutral `binding/standard/block.md` content baked as the `--directive` payload (≤ 4 KiB), claude-template-hardcoded (no `canInjectContext` lookup; consumption removed, schema field deprecated). Verify the hook command's binary resolution (evaluate `${CLAUDE_PLUGIN_ROOT}`-relative form vs bare `exarchos`; document the choice). `hooks:guard` green in-task.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `buildAllHooks_ClaudePlugin_EmitsSubagentStopAndSpecifiedSessionStart_NoSessionEnd`, `buildAllHooks_SessionStartDirective_IsNeutralBlockUnder4KiB`, `buildAllHooks_CodexAndOpencodeLifecycleArtifacts_NotEmitted`, `hooksGuard_ShrunkTree_Passes`
**Files:** `hooks-src/hooks.json`, `hooks-src/opencode-plugin.ts.tmpl` (deleted), `src/build-hooks.ts`, `src/hooks-guard.ts`, `hooks/**` (regenerated), `src/runtimes/types.ts`
**Dependencies:** 006
**Parallelizable:** Yes (after 006; parallel to streams A-tail and B)

### Task 017: Onboard retired-hooks plumbing — check, ordering, uninstall, parity

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-7, DR-8
**Description:** Make the uninstall actually reach its population: add a **retired-hooks-present doctor check** (remediable exactly when provenance-matched retired hooks exist in host settings — the round-2 audit showed the existing `session-start-hook` check passes for precisely those consumers), register it in `CHECK_CLASSIFICATION`, and order plan steps so the managed-block write precedes hook removal with the removal step consulting the block-write outcome (block write failed ⇒ hooks kept). `installHook` gains `removeRetiredHooks` (command-marker provenance match; user hooks untouched; idempotent). Parity baseline updated here.
**Verification (high):** medium set + integration over a settings.json fixture matrix (ours-only / user-only / mixed / already-clean / block-write-fails).
**Expected tests:** `retiredHooksCheck_ProvenanceMatchedHooksPresent_Remediable`, `retiredHooksCheck_CleanSettings_Pass`, `reconcile_BlockWriteOrderedBeforeHookRemoval`, `onboard_BlockWriteFails_RetiredHooksKept`, `removeRetiredHooks_MixedSettings_RemovesOnlyOurs`, `removeRetiredHooks_RepeatedRuns_Idempotent`
**Files:** `servers/exarchos-mcp/src/verbs/onboard/hooks.ts`, `servers/exarchos-mcp/src/verbs/doctor/checks/` (new check), `servers/exarchos-mcp/src/dispatch/core/onboarding/reconcile.ts`, `servers/exarchos-mcp/src/verbs/onboard/onboard.parity.test.ts`
**Dependencies:** 016, 013
**Parallelizable:** No (onboard chain: 013 → 017 → 011)

### Task 022: Versioned packaging via the sync pipeline

**Risk Tier:** medium
**Implements:** DR-4
**Description:** Bump root `package.json` (the SoT) to `2.12.0-preview.1`; run `scripts/sync-versions.sh` to propagate all five sinks (plugin.json + `minBinaryVersion`, manifest.json, server package.json, both `SERVER_VERSION` literals); `version:check` green; verify `.claude-plugin` paths against the restructured tree with a **local** packaging-consistency test (no network `npx` in CI); note release-tag/version coordination for the preview tag.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `versionCheck_AllSinksMatchRootPackageJson`, `pluginManifest_PathsExistInTree`, `pluginManifest_SkillDeclarationsParse_Locally`
**Files:** `package.json`, `scripts/sync-versions.sh` (run, not edited), `.claude-plugin/plugin.json`, `manifest.json`, `servers/exarchos-mcp/package.json`, `servers/exarchos-mcp/src/index.ts`, `servers/exarchos-mcp/src/adapters/mcp.ts`, packaging test
**Dependencies:** 009
**Parallelizable:** Yes (after 009; parallel with 011)

### Task 018: Liveness-verb coverage + docs truth-up + ADR addendum

**Risk Tier:** medium
**Implements:** DR-7
**Description:** Verify/add coverage that `exarchos_view` `ps`/`wait` answer for launcher-spawned sessions from `launch.*` events alone (`views/composite.ts` + WLM handlers); document direct-launch reconciliation-only coverage and the `generic` contract (OQ4); ADR 2026-05-24 dated addendum (completion + plugin carve-out); architecture docs + `docs/system-design.html` + guides (install layout, AGENTS.md on-ramp).
**Verification (medium):** scoped tests + kill-probe; docs checked via `verify_doc_links`.
**Expected tests:** `psView_LauncherSpawnedSession_AnswersFromLaunchEventsAlone`
**Files:** `servers/exarchos-mcp/src/views/composite.ts` (tests), `docs/adrs/2026-05-24-hook-layer-observe-only.md`, `docs/architecture/*`, `docs/system-design.html`, `docs/guides/*`
**Dependencies:** 015, 016, 017
**Parallelizable:** No (bundle tail)

### Parallelization

Three worktree streams; the rename is one atomic PR; regeneration is in-task; guards re-run on the integration branch after every merge (Task 009 is the final backstop, not the owner):

- **Stream A:** 001 → 002 → 003 → **004 (atomic wave)** → 006 → 007; 010 after 003+021; **009** after 004, 006, 007, 010; 022 after 009.
- **Stream B:** 012 ∥ 014 heads; 013 after 012+006; 015 after 014+006.
- **Stream C:** 016 after 006 → 017 after 016+013.
- **Onboard-package chain (serialized):** 013 → 017 → 011 (011 also after 023 + 009).
- **Independent:** 021 (CI lane), 023 (legacy manifest) — anytime.
- **Tail:** 018 after 015 + 016 + 017.

Critical path: 001 → 002 → 003 → 004 → 006 → 007 → 009 → 011 → 018. Checkpoints after 004 (wave), after 009 (sweep), before 018 (tail).

### Completion checklist

- [x] Every DR-N maps to at least one task; every task `Implements:` an existing DR-N
- [x] Every task carries a `riskTier` stamp; medium/high carry adequacy-judged tests; high adds integration
- [x] Open questions resolved; explicit deferrals listed in Scope
- [x] Round-1 (23) and round-2 (17) plan-review gaps addressed
- [x] Owner-declared final review cycle — approval follows this revision
- [ ] Ready for delegation
