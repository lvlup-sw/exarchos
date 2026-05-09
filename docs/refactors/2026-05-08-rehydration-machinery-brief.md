# Refactor brief: rehydration machinery (overhaul track)

**Workflow:** `rehydration-machinery-refactor` (refactor / overhaul)
**Date:** 2026-05-08
**Design-of-record:** [`docs/research/2026-05-08-rehydrate-machinery-reinit.md`](../research/2026-05-08-rehydrate-machinery-reinit.md)
**Originating RCA:** [`docs/rca/2026-05-08-rehydrate-behavioral-gap.md`](../rca/2026-05-08-rehydrate-behavioral-gap.md)

## Goal

Reshape the rehydration surface to operate exclusively through two runtime-agnostic slash commands — `/exarchos:checkpoint` (save) and `/exarchos:rehydrate` (resume) — and remove the Claude Code hook chain that currently double-implements resume via filesystem side-channels. Land the recommended live-projection pattern for `phasePlaybook` so v2.10/v2.11/v2.12 milestones are forward-monotonic against this surface.

## Why overhaul, not polish

Polish track caps at ≤5 files of cosmetic/DRY change. This refactor:

- Deletes ~4,879 LoC across nine files (handlers + their tests)
- Modifies ~600 LoC across 19 files (schema, handlers, renderers, hook config)
- Bumps the rehydration document schema (v:2 → v:3)
- Adds one new event type and extends another
- Spans L2 (event store), L3 (projections), L5 (dispatch core), L8 (slash commands), and the `.claude-plugin` / `hooks/` configuration surfaces

This is structural, multi-layer, and breaks the `cli-commands/session-start` public-ish CLI surface. Overhaul track per `commands/refactor.md` definition.

## Invariants the refactor satisfies

| Invariant | Today's violation | After |
|---|---|---|
| [INV-1 event-sourcing integrity](../../.claude/skills/design-invariants/references/INV-1-event-sourcing.md) | Checkpoint-file format (`<featureId>.checkpoint.json` + `context.md`) is a second source of truth alongside `workflow.checkpoint` events. Stores-as-projections rule violated. | Event log is the only authority. `latestHandoff` / `recentHandoffs` projection folds checkpoint events. |
| [INV-2 facade equivalence](../../.claude/skills/design-invariants/references/INV-2-facade-equivalence.md) | `cli-commands/session-start.ts` carries behavior MCP envelope lacks; `getBehavioralGuidanceForPhase` returns rendered prose only on the CLI path. | Two surfaces (`handleRehydrate`, `handleCheckpoint`) routing through dispatch core, both producing identical structured envelopes carrying `phasePlaybook`. |
| [INV-4 platform-agnosticity](../../.claude/skills/design-invariants/references/INV-4-platform-agnosticity.md) | `SessionStart` and `PreCompact` hooks are Claude Code-specific bootstrap concepts. | Explicit slash-command verbs work identically in Claude Code, Codex, Cursor, OpenCode, Copilot, generic. |
| [INV-5b output contract](../../.claude/skills/design-invariants/references/INV-5b-output-contract.md) | `behavioralGuidance` ships as empty-string fields; `_eventHints.missing` carries critical information the renderer drops. | `phasePlaybook` lands as structured field on the envelope (compatible with `outputSchema` / `structuredContent` post-#1287); renderer surfaces `_eventHints.missing` always. |
| [INV-5c Aspire verbs](../../.claude/skills/design-invariants/references/INV-5c-aspire-verbs.md) | Resume happens implicitly via hook side effect. | Resume happens through an explicit control-plane verb. Mirrors the `merge_orchestrate` pattern in `merge-pending` ([runtime.md §7](../architecture/runtime.md#7-agent-cooperation-model)). |

## Scope summary

### Surfaces deleted (≈4,879 LoC)

- `servers/exarchos-mcp/src/cli-commands/session-start.ts` (798) and `.test.ts` (1593)
- `servers/exarchos-mcp/src/cli-commands/pre-compact.ts` (148) and `.test.ts` (486)
- `servers/exarchos-mcp/src/cli-commands/assemble-context.ts` (525) and `.test.ts` (689) and `.integration.test.ts` (339)
- `servers/exarchos-mcp/src/cli-commands/context-reload.integration.test.ts` (301)
- `commands/reload.md`
- `hooks/session-start.sh`

### Surfaces modified (≈600 LoC)

- `hooks/hooks.json` — drop `SessionStart` and `PreCompact` entries; six other hooks retained
- `servers/exarchos-mcp/src/adapters/hooks.ts` — drop `pre-compact` and `session-start` from `HOOK_COMMANDS`
- `servers/exarchos-mcp/src/adapters/hooks.test.ts` — drop tests for the two removed hooks
- `servers/exarchos-mcp/src/projections/rehydration/schema.ts` — v:3 schema, drop `BehavioralGuidanceSchema`, add `PhasePlaybookSchema` to envelope
- `servers/exarchos-mcp/src/projections/rehydration/upgrade.ts` — add v:2 → v:3 migration
- `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` — drop `behavioralGuidance` from initial document
- `servers/exarchos-mcp/src/projections/rehydration/serialize.ts` — update `STABLE_KEYS`
- `servers/exarchos-mcp/src/projections/rehydration/prose-lint.ts` — update lint targets
- `servers/exarchos-mcp/src/workflow/rehydrate.ts` — compose `phasePlaybook` from `getPlaybook(...)`
- `servers/exarchos-mcp/src/workflow/tools.ts` — `handleCheckpoint` composes `phasePlaybook`
- `servers/exarchos-mcp/src/event-store/schemas.ts` — extend `WorkflowRehydratedData`; register `session.machinery_consumed`
- `commands/rehydrate.md` — House Rules block
- `commands/checkpoint.md` — House Rules block
- `CHANGELOG.md` — record breaking change
- `skills-src/workflow-state/SKILL.md` and `references/mcp-tool-reference.md` — remove SessionStart references
- `skills-src/debug/SKILL.md` — remove SessionStart references
- `skills-src/delegation/references/troubleshooting.md` and `agent-teams-saga.md` — same
- `skills-src/synthesis/references/troubleshooting.md` — same

### Out of scope

- The other six entries in `hooks/hooks.json` (`PreToolUse` `exarchos guard`, `TaskCompleted`, `TeammateIdle`, `SubagentStart`, `SubagentStop`, `SessionEnd`). INV-4 ideally wants them removed too, but that is a separate refactor with substantial product-side deliberation.
- `commands/autocompact.md` — verified as pure `~/.claude/settings.json` toggle (Q3 confirmed). No hook dependency.
- Existing on-disk side-channel files (`.exarchos/workflow-state/*.checkpoint.json`, `context.md`). Silent migration (Q2 confirmed) — files become orphaned after the new flow lands and are harmless. CHANGELOG documents the file paths for users who want to clean them manually.

## Track selection

**Overhaul track.** `overhaulTrackSelected = true`.

## Phased execution

Six phases, sequenced. Each phase is independently verifiable and shippable as its own integration branch.

| # | Phase | Depends on | Scope |
|---|---|---|---|
| **P1** | Schema bump v:2 → v:3 | — | Internal projection drops `behavioralGuidance`; envelope adds `phasePlaybook`; `upgrade.ts` v:2→v:3; v:2 demoted to read-back-only |
| **P2** | Handler composition | P1 | `handleRehydrate` + `handleCheckpoint` compose `phasePlaybook` from `getPlaybook(...)`; shared helper consolidated |
| **P3** | Renderer rewrites | P2 | `commands/rehydrate.md` + `commands/checkpoint.md` rewritten with House Rules block |
| **P4** | Event emissions | — (parallel to P1/P2) | Extend `workflow.rehydrated` data schema; register `session.machinery_consumed`; add dispatch-core interceptor |
| **P5** | Hook + side-channel removal | P2, P3 | Delete `SessionStart` + `PreCompact` from `hooks/hooks.json`; delete `cli-commands/session-start.ts`, `pre-compact.ts`, `assemble-context.ts` and their tests; delete `commands/reload.md`; delete `hooks/session-start.sh`; modify `adapters/hooks.ts` |
| **P6** | Vestigial cleanup | P5 | Remove `BehavioralGuidanceSchema`, `getBehavioralGuidanceForPhase` references in remaining code, prose-lint references, skills-src docs, CHANGELOG |

## Risk register

- **Schema migration correctness.** v:2 snapshots in `.exarchos/workflow-state/*.projections.jsonl` must read-back through demoted v:2 schema and upgrade in memory via `upgrade.ts`. Property test: arbitrary v:2 doc + upgrade + parse against v:3 = success.
- **Cache prefix change.** `phasePlaybook` becoming part of `StableSectionsSchema` invalidates all existing cached rehydrate prefixes (Anthropic prompt-cache hint surface in `applyCacheHints`). One-time cost; not a regression.
- **`session.machinery_consumed` interceptor placement.** Has to fire on first L5 handler call after a `workflow.rehydrated` event on the same stream, must be idempotent (one emission per rehydrate-sequence), must not interceptor-loop on its own emission. Implementation discipline: short-circuit on event types `workflow.rehydrated` and `session.machinery_consumed`.
- **UX regression in Claude Code.** Auto-resume after `/clear` becomes explicit `/exarchos:rehydrate <feature>`. Fallback for "user does not remember feature ID" already documented in `commands/rehydrate.md` step 2 (`exarchos_view pipeline` → ask user). Acceptable per INV-4.
- **Documentation drift.** Many skills-src files reference SessionStart in onboarding/troubleshooting prose. Phase 6 catches these systematically; the `npm run skills:guard` CI gate fails on stale rendered output.

## Acceptance criteria

- All six phases ship; P5 + P6 land last so the hook chain is removed only after the explicit-verb surface is fully composed.
- `npm run typecheck` and `npm run test:run` green at the end of each phase.
- `commands-rehydrate-validation.test.ts` (or equivalent) asserts rendered output for a delegate-phase rehydrate contains the literal strings `### House Rules`, `task.progressed`, `exarchos_event`, and the discipline-reminder sentence.
- Schema parity test: arbitrary v:2 rehydration document upgrades cleanly to v:3 with no data loss other than `behavioralGuidance` field drop.
- New event type `session.machinery_consumed` registered in `EVENT_EMISSION_REGISTRY` with `source: 'auto'`; emission appears on stream after the first non-rehydrate handler call following a `workflow.rehydrated`.
- Plugin manifest (`hooks/hooks.json`) loads cleanly with `SessionStart` and `PreCompact` absent; the other six hooks (`PreToolUse`, `TaskCompleted`, `TeammateIdle`, `SubagentStart`, `SubagentStop`, `SessionEnd`) continue to fire correctly.

## Stop point

After the overhaul-plan phase produces `docs/plans/2026-05-08-rehydration-machinery-plan.md`, the workflow halts at `overhaul-plan-review` — a human checkpoint where the user reviews the TDD task list before delegation begins.
