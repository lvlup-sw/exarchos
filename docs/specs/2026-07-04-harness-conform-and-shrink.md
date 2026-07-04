# Spec: Harness conform-and-shrink bundle (skills collapse · AGENTS.md on-ramp · lifecycle → launcher)

**Date:** 2026-07-04 · **Feature:** `harness-conform-and-shrink` · **Depth:** standard · **Revision:** 1
**Inputs:** #1599 (roadmap tracker) · #1601 (harness-agnosticism program) · #1602 / #1605 / #1607 (this bundle) · #1603 (launcher, shipped PR #1632) · [`docs/research/2026-06-21-harness-agnosticism-strategy.md`](../research/2026-06-21-harness-agnosticism-strategy.md) · ADR [`docs/adrs/2026-05-24-hook-layer-observe-only.md`](../adrs/2026-05-24-hook-layer-observe-only.md) · live SoTA research 2026-07-04 (citations inline) · plan-review round 1 (2 adversarial voters, 23 gaps folded into this revision)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> Ships as **v2.12.0-preview.1** — the Z2 tranche of #1601.

## Design & Rationale

### Problem Statement

Exarchos achieves harness-agnosticism today by **brute-force fan-out** rather than by conforming to the standards the ecosystem has since ratified. Three coupled gaps:

1. **Skills fan-out (#1602).** The committed `skills/` tree is 508 files — 6 runtimes × 18 skills — of which 15 skills differ per-runtime *only* in two prefix strings (`MCP_PREFIX`, `COMMAND_PREFIX`). Agent Skills is now a formal multi-vendor standard ([agentskills.io](https://agentskills.io/specification), extracted from Anthropic Dec 2025) loaded natively by every Tier-1 harness, and there is **no ecosystem prior art** for per-runtime SKILL.md *content* rendering — the convention is one file, per-harness *placement*. Our fan-out is pure maintenance drag (`skills:guard` diff surface, dual-baseline snapshot updates) that the standard has made unnecessary.
2. **Vocabulary fork (naming).** The same workflow step has up to three names: the skill name (`brainstorming`), the Claude command verb (`/exarchos:ideate`), and the opencode alias (`ideate`). Nine skills' names drift from their canonical verbs; only opencode declares `canonicalCommandAliases`. Upstream, Claude Code has merged commands into skills and Codex is deprecating prompts in favor of skills — the skill name *is* the invocation surface, so the fork is now a defect, not a style choice. INV-4 parity should cover vocabulary, not just guarantees. The authoritative command→skill map (`src/config/canonical-skills.ts`, with a CI drift guard and cross-package consumers) encodes today's fork and must be restructured with it.
3. **On-ramp and lifecycle ride harness-specific hooks (#1605, #1607).** The instruction on-ramp is a per-harness `SessionStart` hook directive (only where `canInjectContext`), and session lifecycle is observed via `SessionStart`/`SessionEnd` hooks — but a session-end signal is unreliable or absent on 3 of 5 hooked harnesses (OpenCode's only end signal is the `session.idle` proxy, which can fire repeatedly and is not a clean end; Cursor headless/cloud don't fire `stop`/`sessionEnd`), and the MCP protocol will never provide a session boundary (shutdown has no protocol message; the 2026 draft spec removes protocol sessions and the `initialize` handshake outright — SEP-2567/SEP-2575, [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)). Meanwhile the launcher (#1603) already emits `launch.executing_started`/`launch.executed` at spawn/exit and ships an ephemeral injection seam (`launcher/injection-seam.ts`) that is **built but unwired**. There is no consumer-repo AGENTS.md injection at all, even though AGENTS.md is now a Linux Foundation (AAIF) standard read natively by every Tier-1 harness except Claude Code — whose own docs prescribe exactly the `CLAUDE.md → @AGENTS.md` shim we need ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)).

The enforcement half of #1607 is **already done**: ADR 2026-05-24 (#1476) deleted the enforcement hooks and centralized gating at the dispatch chokepoint (`core/dispatch.ts` readonly + shared-mutating gates). What remains is the residue that ADR left behind: the on-ramp directive, the lifecycle observers, and the docs that still describe hooks as a load-bearing layer.

### Chosen Approach

**Conform-and-shrink onto ratified standards; emit and enforce at chokepoints we own.**

- **#1602 — collapse.** Author the procedural skills once, against **logical qualified tool names** (`exarchos:exarchos_workflow` prose form — Anthropic's documented harness-neutral convention, [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)), rendered to a single canonical `skills/standard/` set. Every surveyed harness keeps the raw tool name as the suffix of its model-visible MCP name, so logical names resolve universally; Codex is moving to fully bare names. Build-render survives **only** for the 3 orchestration skills (`delegation`, `refactor`, `brainstorming`) whose `TASK_TOOL`/`SPAWN_AGENT_CALL`/`CHAIN`/`SUBAGENT_*` tokens genuinely fork per harness — the bespoke moat the issue names, corrected from "~5" to the measured 3.
- **Naming — unify.** The skill name becomes the canonical verb (9 renames incl. the `workflow-state` split); the canonical-name registry (`canonical-skills.ts`), its cross-package consumers, the MCP-server source references, and the eval substrate rename in the same wave; Claude's fat `commands/*.md` bodies collapse into the renamed skills, with **thin shims retained for every skill-backed verb this cycle** (older-harness compatibility); `canonicalCommandAliases` generalizes from an opencode literal to a capability-driven gate. One name space across all six runtimes.
- **#1605 — standard on-ramp.** A consumer-side **managed-block inserter** with Ruler-hardened semantics writes the Exarchos on-ramp block into the consumer's `AGENTS.md` (users own the file; we own only our block), plus a `CLAUDE.md` managed block holding a one-line `@AGENTS.md` import. The block content is **runtime-neutral** (one block, every harness — the binding source is rewritten to the logical form first). Where the launcher is used, orientation is injected **ephemerally at spawn** through each harness's verified native channel — zero repo mutation; the managed block is the direct-launch floor.
- **#1607 — lifecycle to the launcher, hooks retired where a replacement actually reaches the consumer.** The launcher becomes the lifecycle + injection authority (decision 2026-07-04): the `SessionEnd` observer, the codex hooks artifact, the opencode lifecycle plugin, and the **onboard-installed** `SessionStart` directive are retired (the managed block replaces the on-ramp for every onboard-reachable consumer). The **Claude plugin bundle's auto-loaded `SessionStart` on-ramp is retained this cycle** — plugin-marketplace consumers never run `onboard`, so retiring it would silently strand them with no on-ramp; its retirement is deferred until the plugin flow gains a managed-block pathway. `SubagentStop` survives as the only token-attribution seam. Direct launches fall back to the AGENTS.md managed block for on-ramp and to event-sourced liveness reconciliation (WLM, INV-10) for lifecycle — reconcile-on-next-entry, never a daemon (INV-15).

## Requirements

### DR-1: Procedural skills collapse to one standard SKILL.md with logical tool names

The procedural skills (15 today; 16 after the `workflow-state` split) are authored once, with no `MCP_PREFIX`/`COMMAND_PREFIX` tokens; prose tool references use the qualified logical form (`exarchos:<tool_name>`); machine-parsed frontmatter keeps `metadata.mcp-server: exarchos` (matches Anthropic guidance) and never carries harness-prefixed names.

**Acceptance criteria:**
- Rendered per-runtime variants for the procedural skills are deleted; the committed tree becomes `skills/standard/<verb>/` (one render per procedural skill) plus the 3 × 6 orchestration residual and shared fixtures — the ~90 per-runtime procedural skill directories are gone.
- `grep -r "MCP_PREFIX\|COMMAND_PREFIX"` over every procedural source (16 post-split) returns empty; the placeholder lint **rejects** prefix tokens in procedural sources (classification enforced, not advisory).
- Each collapsed SKILL.md validates against the agentskills.io spec (`name` matches directory, ≤64 chars, description ≤1024).
- `skills:guard` covers the canonical set plus the residual rendered set; renderer comment stating "canonical five tokens" corrected to the real vocabulary.

### DR-2: Orchestration residual keeps build-render, with enforced classification

`delegation` (→ `delegate`), `refactor`, and `brainstorming` (→ `ideate`) retain per-runtime rendering for the 5 orchestration tokens (`TASK_TOOL`, `CHAIN`, `SPAWN_AGENT_CALL`, `SUBAGENT_COMPLETION_HOOK`, `SUBAGENT_RESULT_API`) and `<!-- requires:* -->` capability gating (used only by `delegation`).

**Acceptance criteria:**
- The 3 orchestration skills render per-runtime exactly as today (token substitution + requires-gating unchanged), under their new verb names.
- The build fails if a procedural skill introduces an orchestration token (the procedural/orchestration split is asserted at build time, not by convention).
- `assertRuntimeTokenCoverage` still guarantees every runtime declares all orchestration tokens; prefix tokens drop from the required-coverage set only after **both** the procedural rewrite and the binding-source neutralization land (no residual consumer).

### DR-3: One canonical verb vocabulary across all six runtimes

Skill name = directory name = canonical verb. Renames: `brainstorming`→`ideate`, `implementation-planning`→`plan`, `delegation`→`delegate`, `synthesis`→`synthesize`, `discovery`→`discover`, `oneshot-workflow`→`oneshot`, `prune-workflows`→`prune`, `authoring-invariants`→`invariants`, and `workflow-state`→ split into `rehydrate` + `checkpoint` (OQ1 resolution). The rename wave includes the authoritative registry `src/config/canonical-skills.ts` (map collapses toward identity; `rehydrate` moves out of `COMMAND_ONLY`; drift guard and cross-package consumers updated), the MCP-server source references, and the eval substrate. `canonicalCommandAliases` becomes a capability-keyed gate (mechanism generalized; opencode is the only runtime currently declaring a qualifying command surface, so no new alias trees are expected this cycle — the acceptance criterion is the capability-keyed gate per INV-4, not new emissions).

**Acceptance criteria:**
- On every runtime, the user-facing invocation vocabulary is identical (e.g. `ideate` invokes the same content whether surfaced as `/exarchos:ideate`, `$ideate`, or the `ideate` skill).
- No skill-backed `commands/*.md` body duplicates skill content; all skill-backed commands become thin shims (frontmatter + pointer) — **none are deleted this cycle** (preserves `/exarchos:<verb>` on older Claude builds; deletion deferred until a minimum-harness-version policy exists). Command-only surfaces (`autocompact.md`, `tag.md`) are exempt and unchanged; the no-duplication guard is scoped to skill-backed commands.
- All cross-references use the new names: `CHAIN` targets, `canonical-skills.ts` + `command-shim-emitter.ts` + loader/characterization tests, `workflow/playbooks.ts` `skill:`/`skillRef:` literals, `state-store.ts` / `test-runtime-resolver.ts` / `doctor/probes.ts` / `task-decomposition.ts` messages, `evals/<name>/` dataset directories + loader/harness assertions, `next_actions` prose, docs, and the rehydration `compactGuidance` golden fixture.
- `onboard` migrates consumer installs: stale old-name skill directories are removed when provenance is established — by the new install manifest (written by this release forward) **or** by the legacy content-hash bootstrap (directory content matches a shipped historical render, per the legacy-render manifest); modified or unmatched directories are preserved with a warning (see DR-8).

### DR-4: Install layout aligns to the `.agents/skills/` cross-client convention

The canonical skill set installs to `.agents/skills/` (project) / `~/.agents/skills/` (user) with per-harness placement; Windows uses copy-mode, never symlinks; installs write a provenance manifest. No distribution CLI is adopted as primary in this bundle.

**Acceptance criteria:**
- `installSkills()` places the canonical set at the convention path and per-harness native dirs per each runtime's `skillsInstallPath`; on `win32`, placement is file copy (no symlink privilege requirement — INV-16).
- Every install writes/updates a provenance manifest (installed names + content hashes + version) enabling later provenance-gated migration.
- `.claude-plugin/plugin.json` + `manifest.json` remain consistent with the restructured tree (paths valid, version bumped to the preview), and the `npx skills add` discovery fallback still resolves the repo's skills (vercel-labs/skills parses Claude plugin manifests).
- `doctor` reports layout drift (canonical copy missing / stale) without writing.

### DR-5: Consumer-side managed-block inserter with Ruler-hardened semantics

A managed-block writer inserts/updates the Exarchos on-ramp block in the consumer's `AGENTS.md` and a `CLAUDE.md` managed block containing a one-line `@AGENTS.md` import (own line — same-line-with-comment resolution is undocumented upstream). Users own their files; Exarchos owns only its marker-fenced block.

**Acceptance criteria:**
- Markers form a complete pair; an **incomplete pair is treated as absent** — the writer never claims trailing content, preserves everything, and appends a fresh well-formed block with a warning in the result (the Ruler #601 failure class, designed out).
- Idempotency by content hash: identical desired block → no write, no backup; changed block → backup once, then in-place block replacement touching nothing outside the markers.
- The block content is **runtime-neutral**: `binding-src/binding.md` is rewritten to the qualified logical tool form, `renderBindingBlock` is de-parameterized, and one `binding/standard/block.md` artifact serves every harness — onboarding N harnesses in one repo yields one identical, hash-stable block.
- The block carries a provenance line (tool + version + source hash); writes are atomic (temp file + rename); existing line-ending style (LF/CRLF) of the target file is detected and preserved (INV-16 — no ecosystem tool handles this; we do).
- `AGENTS.md` block content is self-contained (no `@imports` inside AGENTS.md — Claude-only expansion would fork behavior per harness); block ≤ 4 KiB; writer warns when total file size approaches the Codex 32 KiB per-file ingestion cap.
- Marker syntax is unified with the existing `binding.ts` fence per Open Question 2.

### DR-6: Ephemeral spawn-time injection wired through per-harness native channels

`injectOrientation` is wired into `lifecycle-core.ts`, and the injection channel becomes a **per-harness declared capability** on the spawn descriptor — replacing the single `canInjectContext` boolean, which conflates hook-injection with spawn-injection (Cursor is hook-injectable but has no spawn channel).

**Acceptance criteria:**
- Channels per harness registry entry: Claude Code append-system-prompt flag; Codex `-c developer_instructions=…`; Copilot `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (temp dir with synthetic AGENTS.md); OpenCode `OPENCODE_CONFIG_CONTENT` (inline JSON `instructions`); Cursor `none` → documented fallback to the DR-5 managed block. Each channel is **verified against the installed CLI before registry hard-coding** (capability probe with documented fallback — e.g. `--append-system-prompt-file` if present, else string-valued `--append-system-prompt`).
- A launcher-spawned session on each channel-bearing harness observes the orientation with **zero repo-file mutation**; `--dry-run` prints the resolved channel + payload without spawning.
- The orientation payload derives from the same runtime-neutral source as the managed block (`binding/standard/block.md`) — one content source, two delivery mechanisms.
- The `EXARCHOS_DIRECTIVE`-refusal property of the seam is preserved (orientation channel can never write the authoritative directive key).

### DR-7: Launcher is the lifecycle authority; hooks retired where a replacement reaches the consumer

Session lifecycle (start/end) is sourced from the launcher's `launch.executing_started`/`launch.executed` events. Retired: the `SessionEnd` observer, the codex hooks artifact, the opencode `session.created` lifecycle plugin, and the **onboard-installed** `SessionStart` directive (replaced by the DR-5 managed block, written in the same onboard pass). Retained: `SubagentStop` (only token-attribution seam) and the **Claude plugin bundle's auto-loaded minimal `SessionStart` on-ramp** (plugin-marketplace consumers never run `onboard`; stripping it would strand them with no on-ramp — its retirement is a tracked follow-up gated on a plugin-flow managed-block pathway).

**Acceptance criteria:**
- `hooks/hooks.json` (Claude plugin auto-load path) ships `SubagentStop` + the retained minimal `SessionStart` on-ramp, and **no `SessionEnd`**; codex hooks emission and the opencode lifecycle plugin are no longer generated by `build-hooks`; `hooks:guard` passes on the shrunk tree.
- `onboard` uninstalls previously-installed retired hooks from host settings **only** on command-marker provenance match (never touches user-authored hooks), is idempotent, and writes the managed block in the same reconcile pass — no consumer transitions through a state with neither hook nor block.
- Liveness verbs answer correctly for launcher-spawned sessions from `launch.*` events alone — verified against the real surfaces: `exarchos_view` `ps`/`wait` (`views/composite.ts` + WLM worktree handlers). For direct launches they answer from reconciliation (existing WLM liveness), and the docs state the coverage difference explicitly.
- The `session-start`/`session-end` CLI verbs stay as manual utilities (OQ3); ADR 2026-05-24 gains a dated addendum recording this completion; architecture docs stop describing hooks as an on-ramp/lifecycle layer; the onboard parity baseline is updated by the same task that changes the hook-install contract.

### DR-8: Failure-mode handling for every file-mutating and spawn-path surface

Every new mutation surface fails safe, visibly, and idempotently.

**Acceptance criteria:**
- Managed-block writer: unwritable target / missing directory → structured error with `suggestedFix`; missing `AGENTS.md` → created with just the managed block; concurrent-writer collision → atomic rename semantics with post-write re-read verification, and a structured warning (not silent last-writer-wins) if verification mismatches.
- Spawn injection: channel construction failure (missing temp dir, oversize payload) → launch **proceeds** without orientation (fail-open for guidance — orientation is UX, not enforcement), with the degradation recorded on the `launch.executing_started` payload.
- Hook uninstall and stale-skill-rename removal: provenance-gated — the install manifest for post-release installs, or the **legacy content-hash bootstrap** for pre-existing installs (directory content hash matches the shipped legacy-render manifest generated before the old renders are deleted); no provenance match means **no deletion**, a warning, and a `doctor` finding; never inferred from backup absence (the Ruler #436 failure class).
- All new paths are exercised by tests on POSIX and on Windows: the managed-block module lives in the **server package** (covered by the existing `test-windows` CI lane), and the CI workflow gains a **root-package Windows lane** covering the installer/copy-mode surfaces.

## Technical Design

**Renderer split (`src/build-skills.ts`).** Skill classification (procedural vs orchestration) is derived from token usage and asserted at build time. Procedural skills render **once** to `skills/standard/<verb>/`; orchestration skills keep the existing per-runtime pipeline under `skills/<runtime>/<verb>/`. `skills:guard` guards both trees; the placeholder lint gains the classification rules. **Regeneration is distributed, not deferred:** every source-editing task regenerates and commits its affected outputs (`skills/`, `command-aliases/`, `binding/`, `src/runtimes/embedded.ts` via `npm run codegen:runtimes`, snapshot baselines) within the same task, so `skills:guard`/`runtimes:guard` stay green on every PR; the late sweep task is a consistency check plus the coordinated deletion of stale renders, not the sole regeneration point.

**Naming (`skills-src/`, `commands/`, `command-aliases/`, registry, server source).** Directory renames per DR-3 with `name:` frontmatter kept equal to the directory (agentskills spec requirement). `src/config/canonical-skills.ts` restructures in the same wave: the command→skill map collapses toward identity, `rehydrate` leaves `COMMAND_ONLY` (skill-backed post-split), and its drift guard plus cross-package consumers (`servers/exarchos-mcp/src/runtime/command-shim-emitter.ts`, `ideate-loader.test.ts`, install-skills characterization tests) update together. Server-source references (`workflow/playbooks.ts` `skill:`/`skillRef:` literals, `state-store.ts:544`, `test-runtime-resolver.ts:121`, `doctor/probes.ts:246`, `task-decomposition.ts`) and the eval substrate (`servers/exarchos-mcp/src/evals/<old-name>/` datasets, `dataset-loader.test.ts`, `harness.test.ts` skill-list assertion) are renamed by a dedicated task. `commands/*.md` bodies migrate into the corresponding `skills-src/<verb>/SKILL.md`; every skill-backed command becomes a thin shim (kept, not deleted); `CHAIN` second-pass args resolve against the new verb names atomically with the reference updates.

**Binding neutralization + managed-block module.** `binding-src/binding.md` is rewritten to the qualified logical tool form and `renderBindingBlock` de-parameterized, emitting a single runtime-neutral `binding/standard/block.md`. The consumer-side inserter `insertManagedBlock(filePath, block, opts)` lives in the **server package** (`servers/exarchos-mcp/src/onramp/managed-block.ts`) — the onboard writers import it directly (no root→server JS-bridge), and its tests run under the existing `test-windows` lane. It implements DR-5/DR-8 semantics and reuses the `binding.ts` fence constants (OQ2). The `doctor` reconciler diffs desired-vs-actual block content by hash.

**Launcher injection (`servers/exarchos-mcp/src/launcher/`).** `HarnessDescriptor` gains an `injection` field — a discriminated union (`{kind: 'flag', flag}`, `{kind: 'env', key, format}`, `{kind: 'config-json', key}`, `{kind: 'none'}`) — populated per harness from the DR-6 channel matrix **after a per-channel verification probe against the installed CLI** (flag presence detected via help output; documented fallbacks). `lifecycle-core.ts` calls `injectOrientation` during spawn-descriptor assembly; the existing `EXARCHOS_ORIENTATION` env write remains as a debugging breadcrumb but is no longer the delivery mechanism.

**Hook shrink (`hooks-src/`, `src/build-hooks.ts`, `orchestrate/onboard/hooks.ts`).** `hooks-src/hooks.json` emission drops `SessionEnd` and the codex variant; the opencode plugin template is deleted; the Claude plugin bundle keeps `SubagentStop` + the minimal `SessionStart` on-ramp (plugin-distribution carve-out, DR-7). `installHook` gains a `removeRetiredHooks` pass (provenance = command-marker match, the same discipline as idempotent install), and the onboard pass writes the managed block in the same reconcile so no consumer is stranded. The onboard parity baseline updates with the contract change, owned by the same task.

**Invariants preserved.** INV-4: parity improves — one content source per skill and one runtime-neutral binding block; the orchestration residual is the only place runtime text still forks, and it stays tokenized. INV-2: no adapter logic is added; on-ramp/lifecycle move to launcher + onboard handlers (shared core). INV-11/INV-12: postures and affordances unchanged; enforcement stays at dispatch. INV-15: no daemon, no polling — lifecycle is launcher-emitted events + reconcile-on-next-entry; the 2026 MCP draft's removal of protocol sessions independently confirms this frame. INV-16: copy-mode installs, CRLF preservation, atomic writes, server-package placement + root Windows lane. INV-10: `launch.*` remains the liveness protocol; retiring `SessionEnd` removes a redundant, unreliable signal rather than a guarantee.

## Integration Points

- `src/build-skills.ts` — renderer split, classification assertion, `skills/standard/` emission, CHAIN-target validation, stale-comment fix
- `src/placeholder-lint.ts` — procedural/orchestration token rules
- `src/config/canonical-skills.ts` (+ drift guard test) · `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts` · loader/characterization tests — registry restructure
- `skills-src/*` — renames + split + bare-name rewrite + command-content fold-in
- `commands/*.md`, `command-aliases/`, `src/build-command-aliases.ts` (+ test) — thin shims; capability-keyed alias gate
- `binding-src/binding.md`, `src/binding.ts`, `binding/**` — runtime-neutral block source
- `servers/exarchos-mcp/src/workflow/playbooks.ts`, `state-store.ts`, `test-runtime-resolver.ts`, `doctor/probes.ts`, `task-decomposition.ts` — server-source rename propagation
- `servers/exarchos-mcp/src/evals/**` — dataset-dir renames + loader/harness assertion updates
- `src/skills-guard.ts`, `src/install-skills.ts`, `orchestrate/onboard/install.ts` — guard trees; `.agents/skills/` layout; provenance manifest; migration
- `servers/exarchos-mcp/src/onramp/managed-block.ts` (new) — consumer-side inserter (server package)
- `orchestrate/init/writers/*.ts`, `orchestrate/onboard/*` (+ `onboard.parity.test.ts`) — block writes, hook uninstall, doctor findings
- `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `harnesses/*.ts`, `injection-seam.ts`, `lifecycle-core.ts`, `verb.ts` — injection channels + wiring
- `hooks-src/*`, `src/build-hooks.ts`, `src/hooks-guard.ts`, `hooks/**` — hook shrink with plugin carve-out
- `runtimes/*.yaml`, `src/runtimes/types.ts`, `src/runtimes/embedded.ts` (via `codegen:runtimes`) — capability model changes
- `.github/workflows/ci.yml` — root-package Windows lane
- `.claude-plugin/plugin.json`, `manifest.json` — packaging truth-up, preview version
- `docs/architecture/*`, ADR 2026-05-24 addendum, `docs/system-design.html`, `docs/guides/*` — truth-up
- Test surfaces: skill snapshot dual-baselines, `rehydrate-demo.expected-document.json`, parity tests, server-package separate typecheck, Windows lanes

## Alternatives considered

- **Install-time prefix resolution (per-consumer render at install).** Rejected in #1602 and confirmed by research: a shared `.agents/skills/` path read by N harnesses cannot carry a baked prefix, and the prefix is a property of the live tool list, not a static install fact. The same argument forces the binding-block neutralization (DR-5) — a per-runtime-rendered block in a shared AGENTS.md would be install-time prefix baking.
- **Fully bare tool names in prose (`exarchos_workflow` alone).** Viable — every harness preserves the raw name as a suffix — but Anthropic's authoring guidance documents the qualified `Server:tool` form as the robust convention when multiple servers are attached; qualified is equally harness-neutral, so we take the documented form.
- **Symlink `CLAUDE.md → AGENTS.md`.** Rejected: Anthropic's own docs prefer the import on Windows; symlinks break copy-based workflows and Windows non-Developer-Mode checkouts (INV-16).
- **Two-layer hooks everywhere (keep SessionStart/SessionEnd as advisory alongside launcher authority).** The OPA warn-locally/deny-at-admission analog; rejected by owner decision 2026-07-04 in favor of surface shrink — with one narrow, evidence-forced carve-out: the Claude plugin bundle's auto-loaded SessionStart on-ramp survives this cycle because plugin-marketplace consumers have no other on-ramp path (they never run `onboard`). Full retirement is a tracked follow-up.
- **MCP-handshake session detection.** Rejected: shutdown has no protocol message today and the 2026 draft removes sessions and `initialize` entirely; building on the handshake is building on sand.
- **Adopt `vercel-labs/skills` as primary distribution.** Deferred: de-facto leader but operationally immature on Windows (symlink privileges, lockfile-not-written #399, CRLF hash drift #781). We align with its *layout* so adoption later is cheap.
- **Status-quo per-runtime rendering.** Rejected: zero ecosystem prior art for per-runtime content; 6× duplication is pure carrying cost now that the standard exists.

## Open Questions

1. **`workflow-state` verb split.** Resolved: split into `rehydrate` + `checkpoint` thin verb skills over shared references (Task 005); `rehydrate` leaves `COMMAND_ONLY` in the registry restructure (Task 019).
2. **Marker syntax.** Resolved: keep the existing `binding.ts` fence (`<!-- exarchos:binding:start/end -->`); the provenance line rides inside the block (Task 012).
3. **`session-start`/`session-end` CLI verbs.** Resolved: verbs stay as manual utilities (INV-2 parity surface); only hook registration retires; a later minor may remove them after a deprecation cycle (Tasks 016/018).
4. **`generic` runtime lifecycle claim.** Resolved: documented as contract — reconciliation-only lifecycle, managed-block on-ramp; no code change (Task 018).

## Decomposition

### Scope

**Target:** Full design (DR-1 … DR-8), revision 1 — folds in all 23 plan-review gaps (7 HIGH, 11 MEDIUM, 5 LOW).
**Excluded:** None deferred silently. Explicit deferrals recorded in-design: Claude-plugin SessionStart retirement (DR-7 carve-out, follow-up issue at synthesis); thin-shim deletion (DR-3, needs minimum-harness-version policy); distribution-CLI adoption (Alternatives).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Procedural skills collapse to one standard SKILL.md, logical tool names | 001, 002, 003, 006, 009 |
| DR-2 | Orchestration residual keeps build-render, enforced classification | 001, 002, 009 |
| DR-3 | One canonical verb vocabulary across all six runtimes | 004, 005, 007, 008, 011, 019, 020 |
| DR-4 | Install layout `.agents/skills/` + provenance manifest + packaging | 010, 022 |
| DR-5 | Consumer-side managed-block inserter, Ruler-hardened, runtime-neutral | 006, 012, 013 |
| DR-6 | Ephemeral spawn-time injection via verified per-harness channels | 014, 015 |
| DR-7 | Launcher is lifecycle authority; hooks retired where replacement reaches consumer | 016, 017, 018 |
| DR-8 | Failure-mode handling on every mutating/spawn surface | 010, 011, 012, 015, 017, 021 |

### Task 001: Renderer skill classification (procedural vs orchestration) with build-time assertion

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** Derive each skill's class from its token usage in `skills-src/`; expose it on the renderer's skill model; fail the build when a procedural skill references any orchestration token or a `<!-- requires:* -->` block. Fix the stale "canonical five tokens" comment.
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe.
**Expected tests:** `classifySkill_PrefixOnlySource_ClassifiedProcedural`, `classifySkill_ProceduralSourceWithOrchestrationToken_FailsBuild`, `classifySkill_RequiresBlockInProceduralSource_FailsBuild`
**Files:** `src/build-skills.ts`, `src/build-skills.test.ts`
**Dependencies:** None
**Parallelizable:** Yes (stream A head)

### Task 002: Placeholder-lint rules for the collapsed vocabulary

**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Description:** `lintPlaceholders` rejects `MCP_PREFIX`/`COMMAND_PREFIX` in procedural sources; orchestration tokens valid only in orchestration skills. Prefix tokens drop from `assertRuntimeTokenCoverage`'s required set **only after** the procedural rewrite (006, which also neutralizes the binding source — the last prefix consumer) lands; until then coverage keeps them (gate on classification, not on token existence).
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `lintPlaceholders_PrefixTokenInProceduralSkill_Rejected`, `lintPlaceholders_OrchestrationTokenInOrchestrationSkill_Allowed`, `assertRuntimeTokenCoverage_PrefixTokensStillConsumed_Required`
**Files:** `src/placeholder-lint.ts`, `src/placeholder-lint.test.ts`, `src/build-skills.ts`
**Dependencies:** 001
**Parallelizable:** No (stream A)

### Task 003: `skills/standard/` single-render emission + guard coverage + CHAIN-target validation

**Risk Tier:** medium
**Implements:** DR-1
**Description:** Procedural skills render once to `skills/standard/<verb>/`; per-runtime emission narrows to the orchestration set; `skills:guard` diff-guards both trees; references copied verbatim. Adds `CHAIN` target validation (a `{{next}}` referencing a non-existent skill fails the build). Regenerates and commits the new `skills/standard/` tree + baselines in-task (guards green on this PR).
**Verification (medium):** scoped tests + kill-probe; `skills:guard` green in-task.
**Expected tests:** `buildAllSkills_ProceduralSkill_EmitsSingleStandardVariant`, `buildAllSkills_OrchestrationSkill_EmitsPerRuntimeVariants`, `skillsGuard_StandardTreeDrift_Fails`, `chainToken_TargetSkillMissing_FailsBuild`
**Files:** `src/build-skills.ts`, `src/skills-guard.ts`, `src/build-skills.test.ts`, `skills/standard/**` (regenerated)
**Dependencies:** 001, 002
**Parallelizable:** No (stream A)

### Task 004: Canonical-verb renames (8 mechanical) + skills-src cross-reference updates + in-task regeneration

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Rename `brainstorming`→`ideate`, `implementation-planning`→`plan`, `delegation`→`delegate`, `synthesis`→`synthesize`, `discovery`→`discover`, `oneshot-workflow`→`oneshot`, `prune-workflows`→`prune`, `authoring-invariants`→`invariants`; keep `name:` frontmatter equal to directory; update every skills-src cross-reference (`CHAIN` `{{next}}` args, `@skills/...` links, `_shared` references). Regenerate + commit affected `skills/` trees and snapshot dual-baselines in-task.
**Verification (medium):** scoped tests + kill-probe; `skills:guard` green in-task (CHAIN validator from 003 proves reference integrity).
**Expected tests:** `buildAllSkills_RenamedSkillNames_MatchDirectories`, `chainToken_TargetSkillMissing_FailsBuild` (over renamed tree)
**Files:** `skills-src/ideate/SKILL.md`, `skills-src/plan/SKILL.md`, `skills-src/delegate/SKILL.md`, `skills-src/synthesize/SKILL.md`, `skills-src/discover/SKILL.md`, `skills-src/oneshot/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/invariants/SKILL.md`, `skills/**` + baselines (regenerated)
**Dependencies:** 003
**Parallelizable:** No (stream A — 003's validator and regen pipeline are prerequisites)

### Task 005: Split `workflow-state` into `rehydrate` + `checkpoint` verb skills

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Two thin verb skills sharing references; descriptions scoped per verb; inbound references updated; regenerate + commit trees/baselines in-task.
**Verification (medium):** scoped tests + kill-probe; `skills:guard` green in-task.
**Expected tests:** `buildAllSkills_RehydrateAndCheckpoint_BothEmitted`, `sharedReferences_LinkedFromBothVerbs_RenderedInBoth`
**Files:** `skills-src/rehydrate/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/_shared/references/verification.md` (relinked), `skills/**` (regenerated)
**Dependencies:** 004
**Parallelizable:** No (stream A)

### Task 019: Canonical-name registry restructure + cross-package consumers

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Restructure `src/config/canonical-skills.ts` for the unified vocabulary: `COMMAND_TO_SKILL` collapses toward identity (verb == skill), `rehydrate` leaves `COMMAND_ONLY` (skill-backed post-split), `checkpoint` maps to its new skill; update the co-located drift-guard test, `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts`, `servers/exarchos-mcp/src/commands/ideate-loader.test.ts` (hardcoded `skills-src/brainstorming` path), and `src/install-skills.*` characterization tests.
**Verification (medium):** scoped tests + kill-probe (both packages' affected suites).
**Expected tests:** `canonicalSkills_PostUnification_MapIsIdentityForSkillBackedVerbs`, `canonicalSkills_Rehydrate_IsSkillBacked`, `commandShimEmitter_RenamedRegistry_EmitsVerbShims`
**Files:** `src/config/canonical-skills.ts`, `src/config/canonical-skills.test.ts`, `servers/exarchos-mcp/src/runtime/command-shim-emitter.ts`, `servers/exarchos-mcp/src/commands/ideate-loader.test.ts`
**Dependencies:** 004, 005
**Parallelizable:** No (stream A)

### Task 020: Server-source + eval-substrate rename propagation

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Propagate the new verb names through MCP-server source: `workflow/playbooks.ts` `skill:`/`skillRef:` literals, `state-store.ts:544` + `test-runtime-resolver.ts:121` error messages (`skills-src/workflow-state` → split targets), `doctor/probes.ts:246` drift heuristic, `task-decomposition.ts:199/364`; rename `servers/exarchos-mcp/src/evals/{brainstorming→ideate, implementation-planning→plan, delegation→delegate}` dataset dirs and update `dataset-loader.test.ts:171` + `harness.test.ts:741` assertions.
**Verification (medium):** scoped tests + kill-probe; full server suite green in-task.
**Expected tests:** `playbooks_SkillRefs_ResolveAgainstRenamedTree`, `datasetLoader_RenamedEvalDirs_Loads`, `harness_SkillList_UsesCanonicalVerbs`
**Files:** `servers/exarchos-mcp/src/workflow/playbooks.ts`, `servers/exarchos-mcp/src/workflow/state-store.ts`, `servers/exarchos-mcp/src/config/test-runtime-resolver.ts`, `servers/exarchos-mcp/src/doctor/probes.ts`, `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`, `servers/exarchos-mcp/src/evals/**`
**Dependencies:** 004, 005
**Parallelizable:** Yes (parallel with 019; disjoint files)

### Task 006: Rewrite procedural skills to qualified logical tool names + binding-source neutralization

**Risk Tier:** medium
**Implements:** DR-1, DR-5
**Description:** Replace `{{MCP_PREFIX}}<tool>` with the qualified logical form (`exarchos:<tool>`) and `{{COMMAND_PREFIX}}<verb>` with the canonical verb across the 16 procedural skills + references. **Also neutralize the binding source** (the last prefix consumer): rewrite `binding-src/binding.md` to the logical form, de-parameterize `renderBindingBlock`, emit a single `binding/standard/block.md`; then drop prefix tokens from the required-coverage set (completing 002). Regenerate + commit trees/baselines in-task.
**Verification (medium):** scoped tests + kill-probe; DR-1 grep AC empty over all 16.
**Expected tests:** `lintPlaceholders_RewrittenProceduralTree_NoPrefixTokens`, `renderBindingBlock_NoPlaceholders_RuntimeNeutralOutput`, `bindingStandardBlock_SameContentForAllRuntimes`
**Files:** `skills-src/cleanup/SKILL.md`, `skills-src/debug/SKILL.md`, `skills-src/discover/SKILL.md`, `skills-src/dogfood/SKILL.md`, `skills-src/git-worktrees/SKILL.md`, `skills-src/plan/SKILL.md`, `skills-src/merge-orchestrator/SKILL.md`, `skills-src/mutation-adequacy/SKILL.md`, `skills-src/oneshot/SKILL.md`, `skills-src/prune/SKILL.md`, `skills-src/invariants/SKILL.md`, `skills-src/rehydrate/SKILL.md`, `skills-src/checkpoint/SKILL.md`, `skills-src/review/SKILL.md`, `skills-src/shepherd/SKILL.md`, `skills-src/synthesize/SKILL.md`, `binding-src/binding.md`, `src/binding.ts`, `binding/**` + `skills/**` (regenerated)
**Dependencies:** 004, 005
**Parallelizable:** No (stream A; content-wide)

### Task 007: Collapse fat `commands/*.md` bodies into skills; thin shims for all skill-backed verbs

**Risk Tier:** medium
**Implements:** DR-3
**Description:** Migrate content that exists only in `commands/*.md` (state-management choreography, auto-chain steps) into the corresponding `skills-src/<verb>/SKILL.md`; every skill-backed command becomes a thin shim (frontmatter + pointer) — **no deletions** this cycle (older-Claude compatibility). Command-only surfaces (`autocompact.md`, `tag.md`) are exempt; the no-duplication guard is scoped to skill-backed commands. Regenerate + commit in-task.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `commandsTree_SkillBackedCommands_NoBodyDuplication`, `commandsTree_CommandOnlySurfaces_Exempt`, trigger-tests resolve each verb
**Files:** `commands/ideate.md`, `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`, `commands/debug.md`, `commands/refactor.md`, `commands/oneshot.md`, `commands/rehydrate.md`, `commands/checkpoint.md`, `commands/cleanup.md`, `commands/discover.md`, `commands/dogfood.md`, `commands/prune.md`, `commands/shepherd.md`, `commands/invariants.md`, `skills-src/ideate/SKILL.md` (fold-in targets per verb)
**Dependencies:** 006, 019
**Parallelizable:** No (stream A tail)

### Task 008: Capability-keyed `canonicalCommandAliases` gate + alias regeneration

**Risk Tier:** medium
**Implements:** DR-3
**Description:** The alias gate in `src/build-command-aliases.ts` (line ~149) and the consumer gate in `src/install-skills.ts` key off runtime capability with no runtime literals (INV-4). Honest scope: opencode remains the only qualifying runtime this cycle — the deliverable is the generalized mechanism + regenerated `command-aliases/` under new verb names, not new alias trees. Run `codegen:runtimes` + commit `embedded.ts` if yaml/schema change; `runtimes:guard` green in-task.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `aliasEmission_QualifyingRuntime_EmitsVerbAliases`, `aliasEmission_NonQualifyingRuntime_EmitsNone`, `aliasGate_NoRuntimeLiterals`
**Files:** `src/build-command-aliases.ts`, `src/build-command-aliases.test.ts`, `src/install-skills.ts`, `runtimes/*.yaml`, `src/runtimes/types.ts`, `src/runtimes/embedded.ts` (codegen), `command-aliases/**` (regenerated)
**Dependencies:** 003, 004
**Parallelizable:** Yes (after 003+004; independent of 005–007)

### Task 021: Root-package Windows CI lane

**Risk Tier:** low
**Implements:** DR-8
**Description:** Extend `.github/workflows/ci.yml` with a Windows lane (or matrix entry) that runs the **root package** tests (current `test-windows` runs only `servers/exarchos-mcp`), gated on root-source changes; wire it into the existing blocking-status flow. Proven live by Tasks 010/012 test executions in that lane.
**Verification (low):** static analysis (workflow lint) + observed green lane on this task's own PR.
**Files:** `.github/workflows/ci.yml`
**Dependencies:** None
**Parallelizable:** Yes (any stream)

### Task 010: Install layout — `.agents/skills/` + copy-mode on Windows + provenance manifest

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4, DR-8
**Description:** `installSkills()` places the canonical set at `.agents/skills/` (project) / `~/.agents/skills/` (user) and per-harness native dirs; `win32` placement is copy, never symlink; **every install writes/updates a provenance manifest** (installed names + content hashes + version) — the forward half of the DR-8 migration policy; `doctor` reports canonical-copy drift read-only; `npx skills add` fallback retained. Installer learns the `skills/standard/` layout **before** any stale-render deletion (009) so no broken-install window exists.
**Verification (medium):** scoped tests + kill-probe (Windows behavior exercised in the Task 021 root lane).
**Expected tests:** `installSkills_CanonicalLayout_PlacesAgentsSkillsDir`, `installSkills_Win32_UsesCopyNotSymlink`, `installSkills_EveryInstall_WritesProvenanceManifest`, `doctor_CanonicalCopyStale_ReportsDrift`
**Files:** `src/install-skills.ts`, `src/install-skills.test.ts`, `servers/exarchos-mcp/src/orchestrate/onboard/install.ts`
**Dependencies:** 003, 008, 021 (008 orders the shared `src/install-skills.ts` edits)
**Parallelizable:** Yes (after 008; parallel with 005-007)

### Task 009: Consistency sweep — stale-render deletion, legacy-hash manifest, golden fixture, full integration

**Risk Tier:** high
**Implements:** DR-1, DR-2 (final state)
**Description:** With all source tasks landed and each PR guard-green: (a) generate the **legacy-render hash manifest** (content hashes of the outgoing per-runtime procedural renders — the DR-8 bootstrap input) *before* (b) deleting the ~90 stale per-runtime procedural skill dirs; (c) regenerate `rehydrate-demo.expected-document.json` if `compactGuidance`/`next_actions` prose changed; (d) verify parity tests; (e) build idempotence check (`build:skills` twice → no diff); (f) full `vitest run` at root **and** `servers/exarchos-mcp`, both typechecks, all guards.
**Verification (high):** medium set + full integration across both packages.
**Expected tests:** `legacyHashManifest_CoversAllDeletedRenders`, `buildSkills_SecondRun_NoDiff` (idempotence), plus all existing suites green post-deletion
**Files:** `skills/**` (deletions), legacy-hash manifest artifact, `servers/exarchos-mcp/**/rehydrate-demo.expected-document.json`
**Dependencies:** 004, 005, 006, 007, 008, 010, 019, 020
**Parallelizable:** No (stream A barrier — final)

### Task 011: Onboard rename migration — provenance-gated with legacy-hash bootstrap

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-8
**Description:** The onboard reconciler removes stale old-name skill dirs from consumer install paths when provenance is established via (a) the Task 010 install manifest, or (b) the **legacy content-hash bootstrap**: dir content hash matches the Task 009 legacy-render manifest (pre-existing installs, which predate any manifest). Modified/unmatched dirs → preserved + warning + `doctor` finding; new names installed in the same pass; idempotent. This makes the migration effective for the *existing* install base, not only future installs.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `onboardMigrate_ManifestProvenance_Removed`, `onboardMigrate_LegacyHashMatch_Removed`, `onboardMigrate_UserModifiedDir_PreservedWithWarning`, `onboardMigrate_RepeatedRuns_Idempotent`
**Files:** `servers/exarchos-mcp/src/orchestrate/onboard/install.ts` (+ tests), `src/install-skills.ts`
**Dependencies:** 009, 013, 017
**Parallelizable:** No (onboard-package chain tail: 013 → 017 → 011)

### Task 012: `insertManagedBlock` — consumer-side writer (server package)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-5, DR-8
**Description:** New module `servers/exarchos-mcp/src/onramp/managed-block.ts` (server package — onboard writers import directly, no root→server bridge; tests run in the existing `test-windows` lane). Reuses `binding.ts` fence constants (OQ2). Semantics: complete-pair-only (incomplete pair ⇒ treated absent, content never claimed, fresh block appended + warning), content-hash idempotency (identical ⇒ no write, no backup), backup-once, provenance line (tool + version + source hash), LF/CRLF detection & preservation, atomic temp+rename, missing-file creation, structured error envelopes, post-write re-read verification.
**Verification (high):** medium set + property tests (outside-block content invariant under arbitrary operation sequences) + Windows-lane CRLF coverage (native to server package).
**Expected tests:** `insertManagedBlock_IncompletePair_TreatsAbsentAppendsFresh`, `insertManagedBlock_IdenticalContent_NoWriteNoBackup`, `insertManagedBlock_ChangedBlock_BacksUpOnceThenReplacesInPlace`, `insertManagedBlock_CrlfFile_PreservesLineEndings`, `insertManagedBlock_MissingFile_CreatesWithBlock`, `insertManagedBlock_UnwritableTarget_StructuredError`, property: `outsideContent_InvariantUnderAnyBlockOperationSequence`
**Files:** `servers/exarchos-mcp/src/onramp/managed-block.ts`, `servers/exarchos-mcp/src/onramp/managed-block.test.ts`
**Dependencies:** None (stream B head)
**Parallelizable:** Yes

### Task 013: Onboard writers — AGENTS.md block + CLAUDE.md `@AGENTS.md` shim + doctor drift

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5
**Description:** All runtime writers emit the **runtime-neutral** on-ramp block (from `binding/standard/block.md`, Task 006) into consumer `AGENTS.md` via `insertManagedBlock`; claude writer additionally maintains the `CLAUDE.md` managed block whose body is the `@AGENTS.md` import on its own line; size guards (block ≤ 4 KiB; warn near Codex 32 KiB cap); no `@imports` inside the AGENTS.md block; `doctor` diffs desired-vs-actual by hash.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `claudeWriter_Shim_ImportOnOwnLineInsideBlock`, `writers_AgentsMdBlock_RuntimeNeutralAndNoAtImports`, `writer_FileNearCodexCap_Warns`, `doctor_BlockHashDrift_ReportsFinding`
**Files:** `servers/exarchos-mcp/src/orchestrate/init/writers/*.ts`, `servers/exarchos-mcp/src/orchestrate/onboard/*` (+ tests)
**Dependencies:** 012, 006
**Parallelizable:** No (follows 012; first link of onboard-package chain 013 → 017 → 011)

### Task 014: Injection-channel union on the harness registry (verified channels)

**Risk Tier:** medium
**Implements:** DR-6
**Description:** `HarnessDescriptor` gains `injection: {kind:'flag'|'env'|'config-json'|'none', …}`; per-harness values from the DR-6 matrix. **Channel verification before hard-coding:** detect the Claude flag variant via CLI help probe (`--append-system-prompt-file` if present, else string-valued `--append-system-prompt`); document each channel's provenance + fallback in the registry entry. Run `codegen:runtimes` if schema touched; `runtimes:guard` green in-task.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `harnessRegistry_EveryHarness_DeclaresInjectionChannel`, `injectionChannel_Cursor_IsNone`, `claudeChannel_FlagVariantResolvedByProbe_FallsBackToStringFlag`
**Files:** `servers/exarchos-mcp/src/launcher/harness-registry.ts`, `servers/exarchos-mcp/src/launcher/harnesses/*.ts` (+ tests)
**Dependencies:** None (stream B, parallel with 012)
**Parallelizable:** Yes

### Task 015: Wire `injectOrientation` into the spawn path (fail-open, dry-run-visible)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-6, DR-8
**Description:** `lifecycle-core.ts` applies the channel during spawn-descriptor assembly; orientation payload from `binding/standard/block.md`; channel-construction failure ⇒ launch proceeds without orientation, degradation recorded on `launch.executing_started` payload; `--dry-run` prints resolved channel + payload; `EXARCHOS_DIRECTIVE`-refusal preserved.
**Verification (high):** medium set + integration across the spawn seam (fake harness binary capturing argv/env) + Windows lane for temp-dir/path behavior.
**Expected tests:** `runLifecycle_ClaudeChannel_AppliesResolvedAppendSystemPromptFlag`, `runLifecycle_CopilotChannel_PointsEnvAtSyntheticAgentsMd`, `runLifecycle_InjectionConstructionFails_LaunchProceedsWithDegradationRecorded`, `launcherVerb_DryRun_PrintsResolvedChannelAndPayload`, `injectOrientation_DirectiveKey_StillRefused`
**Files:** `servers/exarchos-mcp/src/launcher/lifecycle-core.ts`, `servers/exarchos-mcp/src/launcher/injection-seam.ts`, `servers/exarchos-mcp/src/launcher/verb.ts` (+ tests)
**Dependencies:** 014, 006
**Parallelizable:** No (follows 014)

### Task 016: Hook-surface shrink (plugin carve-out preserved)

**Risk Tier:** medium
**Implements:** DR-7
**Description:** `build-hooks` emission changes: drop `SessionEnd` everywhere; stop emitting the codex hooks artifact and the opencode lifecycle plugin (both are generated outputs — this is an emission change; the only source deletion is `hooks-src/opencode-plugin.ts.tmpl`); the Claude plugin `hooks/hooks.json` retains `SubagentStop` + the minimal `SessionStart` on-ramp (plugin-distribution carve-out). Remove `canInjectContext` consumption from build-hooks (schema field retained, deprecated). `hooks:guard` green in-task. `session-start`/`session-end` CLI verbs untouched (OQ3).
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `buildAllHooks_ClaudePlugin_EmitsSubagentStopAndMinimalSessionStart_NoSessionEnd`, `buildAllHooks_CodexAndOpencodeLifecycleArtifacts_NotEmitted`, `hooksGuard_ShrunkTree_Passes`
**Files:** `hooks-src/hooks.json`, `hooks-src/opencode-plugin.ts.tmpl` (deleted), `src/build-hooks.ts`, `src/hooks-guard.ts`, `hooks/**` (regenerated), `src/runtimes/types.ts`
**Dependencies:** 006, 008
**Parallelizable:** Yes (after 008; parallel to streams A-tail and B)

### Task 017: Onboard hook-uninstall pass + managed-block hand-off + parity baseline

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-7, DR-8
**Description:** `installHook` gains `removeRetiredHooks`: removes previously-installed SessionStart/SessionEnd entries from host settings **only** on command-marker provenance match; user-authored hooks untouched; no provenance ⇒ no deletion + warning + `doctor` finding; idempotent. The same onboard reconcile writes the DR-5 managed block **before** hook removal (no consumer transitions through hook-less + block-less). Updates `onboard.parity.test.ts` baseline (owned here, not by a different stream).
**Verification (high):** medium set + integration over a settings.json fixture matrix (ours-only / user-only / mixed / already-clean / block-write-fails ⇒ hooks kept).
**Expected tests:** `removeRetiredHooks_ProvenanceMatchedEntry_Removed`, `removeRetiredHooks_UserAuthoredHook_Untouched`, `removeRetiredHooks_MixedSettings_RemovesOnlyOurs`, `removeRetiredHooks_RepeatedRuns_Idempotent`, `onboard_BlockWriteFails_RetiredHooksKept`
**Files:** `servers/exarchos-mcp/src/orchestrate/onboard/hooks.ts` (+ tests), `servers/exarchos-mcp/src/orchestrate/onboard/onboard.parity.test.ts`
**Dependencies:** 016, 013
**Parallelizable:** No (onboard-package chain: 013 → 017 → 011)

### Task 022: Plugin packaging + manifest truth-up

**Risk Tier:** medium
**Implements:** DR-4
**Description:** `.claude-plugin/plugin.json` + root `manifest.json`: bump version to `2.12.0-preview.1`; verify `skills`/`commands` paths against the restructured tree; add a packaging-consistency test (manifest paths exist, skill declarations parse); smoke the `npx skills add` discovery fallback against the repo layout.
**Verification (medium):** scoped tests + kill-probe.
**Expected tests:** `pluginManifest_PathsExistInTree`, `pluginManifest_Version_MatchesPreview`, `skillsAddDiscovery_ParsesPluginManifest`
**Files:** `.claude-plugin/plugin.json`, `manifest.json`, packaging test file
**Dependencies:** 009
**Parallelizable:** Yes (after 009; parallel with 011)

### Task 018: Liveness-verb coverage + docs truth-up + ADR addendum

**Risk Tier:** medium
**Implements:** DR-7
**Description:** Verify (add if missing) coverage that `exarchos_view` `ps`/`wait` answer for launcher-spawned sessions from `launch.*` events alone (correct surfaces: `views/composite.ts` + WLM worktree handlers — not `src/describe/`, which is action-metadata); document direct-launch coverage as reconciliation-only and `generic` as managed-block + reconciliation by contract (OQ4); ADR 2026-05-24 dated addendum recording completion + plugin carve-out; architecture docs + `docs/system-design.html` rows; guides for new install layout + AGENTS.md on-ramp.
**Verification (medium):** scoped tests + kill-probe for the verb-coverage test; docs static-checked (`verify_doc_links`).
**Expected tests:** `psView_LauncherSpawnedSession_AnswersFromLaunchEventsAlone`
**Files:** `servers/exarchos-mcp/src/views/composite.ts` (tests), `docs/adrs/2026-05-24-hook-layer-observe-only.md`, `docs/architecture/*`, `docs/system-design.html`, `docs/guides/*`
**Dependencies:** 015, 016, 017
**Parallelizable:** No (bundle tail)

### Parallelization

Three worktree streams with explicit cross-stream serialization on shared packages; regeneration is in-task so every merge is guard-green:

- **Stream A (renderer + naming):** 001 → 002 → 003 → 004 → 005 → {019 ∥ 020} → 006 → 007; 008 after 003+004; 010 after 008+021; **009** (consistency sweep + stale-render deletion + legacy-hash manifest) after 004–008, 010, 019, 020; 022 after 009.
- **Stream B (on-ramp):** 012 ∥ 014 heads; 013 after 012+006; 015 after 014+006.
- **Stream C (hooks):** 016 after 006+008 → 017 after 016+013.
- **Onboard-package chain (cross-stream, serialized):** 013 → 017 → 011 (with 011 also after 009 for the legacy-hash manifest).
- **Independent:** 021 (CI lane) anytime; feeds 010/012 verification.
- **Tail:** 018 after 015 + 016 + 017.

Critical path: 001 → 002 → 003 → 004 → 005 → 006 → 007 → 009 → 011/022 → 018. Checkpoints after 006 (content wave), after 009 (sweep), and before 018 (tail), per the ~10-task checkpoint discipline.

### Completion checklist

- [x] Every DR-N in the Requirements section maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); high adds integration across the seam
- [x] Open questions resolved (OQ1–OQ4 dispositions recorded) — explicit deferrals listed in Scope
- [x] All 23 plan-review round-1 gaps addressed (7 HIGH structural, 11 MEDIUM, 5 LOW)
- [ ] Ready for `plan-review` (round 2)
