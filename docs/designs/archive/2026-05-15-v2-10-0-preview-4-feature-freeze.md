# v2.10.0-preview.4 — Feature-Freeze Bundle

**Feature ID:** `v2-10-0-preview-4-feature-freeze`
**Epic:** [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) — v3.0.0 P2: Agent Output Contract (HATEOAS + NDJSON)
**Milestone:** v2.10.0 — Agent Output Contract
**Scope:** #1238, #1244, #1260, #1261, #1262, #1272, #1273, #1274, #1290, #1291, #1298
**Date:** 2026-05-15

## Problem

v2.10.0-preview.3 shipped the Wave 0 carrier (`outputSchema + structuredContent`, #1369), Wave 1 data safety (#1388), and the Wave 2 + Wave 3 polish bundle (#1391/1392/1393/1394 + #1401). The carrier substrate is now live; what remains in the v2.10.0 milestone is the **feature surface that consumes it** — Roots-based input discovery, three-field correlation, Tasks (SEP-1686) dispatch-core integration, Elicitation, quality hints, plus the authoring substrate that lets `/ideate` and the gates speak the same structured language.

Preview.4 is the **final feature-work batch** before v2.10.0 transitions to release-candidate mode. After this bundle merges:

- v2.10.0-RC1 ships polish + bug fixes only (no new API surface, no new event types, no new MCP capabilities).
- Remaining open issues in the milestone (`#1330` static-analysis worktree, `#1329` TDD blast-radius gates, `#1301` worktree leak, `#1337` doctor-workflow test backfill, E2E infra `#1232/1233/1234/1170/1169`, etc.) are RC-eligible: bug or test, not feature.
- `#1365` eval-suite redesign explicitly defers to v2.11+ per its seed doc.

The eleven issues in this bundle were filed against the v2.10.0 milestone but never sequenced into a preview; preview.3's Wave 0 unlocked the registered-outputSchema dependency, so they are now all simultaneously viable. Keeping them open into RC would either force feature work into RC (breaking the freeze line) or push them to v2.11 (fragmenting the v2.10 "Agent Output Contract" story).

## Scope and grouping

The eleven issues cluster into four cohesive waves by shared surface:

| Wave | Theme | Issues | Surface |
|---|---|---|---|
| **A** | Output contract completion | #1238, #1262, #1290, #1274 | MCP envelope + capability resolver + next_actions |
| **B** | Correlation + event topology | #1291, #1261, #1272 | Dispatch entry + event store + TaskStore projection |
| **C** | Tasks dispatch-core | #1273 | Dispatch core + CLI `--follow` + MCP `tasks/*` |
| **D** | Authoring substrate | #1260, #1298, #1244 | `/ideate` inputs + gates + checkpoint lint |

Wave A and Wave D touch disjoint surfaces and can land in parallel. Wave B's three-field correlation threads through every event emission point (broad blast). Wave C builds on Wave B's `EventSourcedTaskStore` (#1272) and is the heaviest single issue in the bundle.

## Wave A — Output Contract Completion

The Wave 0 carrier (`structuredContent` + registered `outputSchema`) made the envelope shape-validated; Wave A finishes the agent-facing semantics that consume that carrier.

**#1238 next_actions Zod discriminated unions.** Today `next-actions-from-result.ts:48-91` uses `Record<string, unknown>` casts and inline `typeof` guards to pick `phase | workflowType | featureId | mergeOrchestrator` from two distinct payload shapes (workflow-handler payload vs. rehydration document). Convert to a Zod discriminated union (`ShapeOneSchema | ShapeTwoSchema`) consumed via `safeParse()`. Fail-closed on neither matching (the current `return []` masks shape regressions); preserve the no-actions case for non-success / null-data inputs. This is the contract enforcement point for all four composite tools' next_actions surface.

**#1262 output-token quality hint.** Long-horizon orchestrations narrate to the per-turn token cap and truncate mid-work. Telemetry already tracks per-tool tokens (`view telemetry`). Surface a `output_tokens_high` quality hint via `next_actions` when per-turn output tokens cross a configurable threshold (default 80% of cap); the hint suggests `checkpoint` as the next action with rationale. Threshold reads through `CapabilityResolver`, not raw yaml. New hint registers against `exarchos_view.describe` action discovery.

**#1290 Roots-based workspace discovery.** When `featureId` is omitted on a dispatch that requires it AND the client declared `roots: { listChanged: true }` at handshake, call `roots/list` (cached per-handshake; refreshed on `roots/list_changed`), scan each root for an Exarchos workspace signature (`.exarchos.yml`, `docs/workflow-state/*.state.json`), and resolve. Exactly one match → success + `workspace.resolved { source: 'roots', path, featureId }`. Zero matches → fall back to cwd-walk + `workspace.resolved { source: 'cwd' }`. Multiple matches → `INVALID_INPUT` with `validTargets` populated. CLI surface unchanged (no `roots` over CLI).

**#1274 Elicitation form mode for INVALID_INPUT.** When `dispatch()` finds a missing required parameter AND the client declared the `elicitation` capability, derive the field's sub-schema via `inputSchema.pick({ field: true })` and send `elicitation/create` instead of returning `INVALID_INPUT`. Elicitation schemas are **derived, not hand-written** — Zod's `.pick()` ensures the elicitation schema cannot drift from the validation schema (DIM-3). Emit `elicitation.requested` and `elicitation.fulfilled` events carrying `operationId`. Existing `INVALID_INPUT` path stays as the fallback for clients without the capability. URL-mode elicitation (OAuth) is out of scope.

### Wave A architectural choices

| Choice | Approach taken | Alternative rejected |
|---|---|---|
| Elicitation schema source | Derived via `.pick()` from `inputSchema` | Hand-written elicitation schemas — drift risk; doubles contract surface |
| Roots cache scope | Per-handshake; invalidated on `roots/list_changed` | Per-dispatch (refresh every call) — wastes RTT; client already notifies on change |
| Quality hint emission | Telemetry projection observes threshold, emits via `next_actions` on next envelope | New event type (`telemetry.threshold_crossed`) — over-engineering for a derived signal |
| `#1238` parser fail-mode | `safeParse()` + fail-closed on no-match | Continue inline guards + cast — leaves DIM-2/D3 debt in place |

## Wave B — Correlation + Event Topology

The Wave 0 carrier registered `_meta.operationId` per #1270 (shipped). Wave B widens that to the three-field correlation model and adds the events the carrier needs to observe.

**#1291 dispatch-boundary correlation — three-field metadata.** Mint a UUID at the entry of `dispatch()` and thread it through every event emitted during the call, the envelope's `_meta`, and the auto-emit chain. Three distinct fields, three distinct questions:

| Field | Question | Mint site |
|---|---|---|
| `operationId` | Which dispatch produced this event? | Always minted fresh at dispatch entry |
| `correlationId` | Which broader user-initiated workflow does this belong to? | Inherited from incoming envelope `_meta.correlationId` if present; otherwise = `operationId` |
| `causationId` | Which prior event caused this dispatch to fire? | Set from the upstream event's `eventId` when dispatch was triggered by a `next_actions` hint or saga continuation |

`correlationId` lets `/loop` cycles and subagent waves share a thread; `causationId` lets reconstruction answer *why* an event was emitted without timestamp heuristics. Backwards-compatible: existing single-`operationId` events get widened, never removed. The three-field shape mirrors Marten's published correlation model (see #1312 R-3).

**#1261 dispatch.preflight + stash.detected events.** `dispatch-guard.ts` runs DR-1 (ancestry), DR-2 (worktree assertion), protected-branch check, main-worktree check on every `delegate` call but emits no events. Adopt the existing `gate-utils.ts:emitGateEvent` pattern: emit `dispatch.preflight { guards: { ancestry, worktree, protectedBranch, mainWorktree }, passed, durationMs }` after each guard pass-or-fail, and `stash.detected { worktreePath, stashRef }` when a guard observes shared-stash state. Threads `operationId / correlationId / causationId` from Wave B. Unlocks telemetry attribution per guard and feeds future epic-autopilot signals.

**#1272 EventSourcedTaskStore — TaskStore as projection.** Implement the SDK's `TaskStore` interface as a projection over `task.created`, `task.polled`, `task.result`, `task.cancelled` events. The SDK's `InMemoryTaskStore` is **not** used — it would create a second source of truth, violating INV-1 (event-sourcing integrity) and DIM-1 (single-topology source of truth). Lives next to the event store, not inside the MCP adapter (INV-3 basileus-forward — TaskStore is process-local; remote dispatchers carry their own). Bounded retention via per-task TTL (DIM-7). Each emitted event carries the three-field correlation from #1291.

### Wave B architectural choices

| Choice | Approach taken | Alternative rejected |
|---|---|---|
| Correlation field count | Three (operationId + correlationId + causationId) | Single (operationId only, status quo) — closes 1/3 of observability questions |
| Correlation threading | Single primitive at dispatch entry; pass through context object | Re-derive at each emission point — DIM-1 violation; drift inevitable |
| `dispatch.preflight` granularity | One event per guard outcome (pass or fail) | One aggregate event for all guards — loses per-guard attribution |
| TaskStore implementation | Projection over events | SDK `InMemoryTaskStore` — INV-1 + DIM-1 violation |
| TTL surface | Per-task `expiresAt` in projection | Global expiry policy — agents need per-call control |

## Wave C — Tasks Dispatch-Core (#1273)

Tasks (SEP-1686) is a **dispatch-core abstraction**, not an MCP-adapter feature. Both CLI `--follow` and MCP `tools/call` (with `task: { ttl }` augmentation) consume the same dispatch path, the same `EventSourcedTaskStore`, the same `task.*` event stream. Architecture per the milestone-16 design §4.5:

```
                ┌──────────────────────────────────────────────┐
                │  Dispatch Core (shared)                      │
                │  ┌─────────────────────────────────────────┐ │
                │  │ One-shot: returns Envelope<T>           │ │
                │  ├─────────────────────────────────────────┤ │
                │  │ Tasks-augmented:                        │ │
                │  │   - returns CreateTaskResult            │ │
                │  │   - lifecycle in EventSourcedTaskStore  │ │
                │  │   - emits task.created/polled/result    │ │
                │  └─────────────────────────────────────────┘ │
                └─────────┬─────────────────────────────┬──────┘
                          │                             │
                ┌─────────▼──────────┐    ┌─────────────▼──────────┐
                │  CLI adapter       │    │  MCP adapter           │
                │  (in-process       │    │  (delegated polling    │
                │   Tasks consumer)  │    │   via tasks/get etc)   │
                └────────────────────┘    └────────────────────────┘
```

**First adoption:** `exarchos_view --follow workflow` and `exarchos_view --follow shepherd`. The CLI runs an in-process polling loop against the `EventSourcedTaskStore` (function calls, not JSON-RPC) and renders each transition to stdout. The MCP server returns `CreateTaskResult` immediately; the client drives `tasks/get` polling; final result via `tasks/result`. `taskSupport: 'optional'` capability gate so non-Task MCP clients fall back to the one-shot envelope path.

**Cancellation parity.** `tasks/cancel` from MCP and SIGINT on the CLI both route to the same `cancelTask` dispatch-core call, which emits `task.cancelled`. Compensation hooks (where the underlying workflow already has saga compensation defined) run identically on both surfaces.

### Wave C architectural choices

| Choice | Approach taken | Alternative rejected |
|---|---|---|
| Dispatch-core vs adapter-only | Shared dispatch-core abstraction | MCP-adapter-only — duplicates polling loop in CLI; INV-2 facade-equivalence violation |
| `taskSupport` resolution | `'optional'` — fall back to one-shot for clients without Tasks | `'required'` — breaks non-Task MCP clients |
| Polling cadence | Client-driven via `tasks/get` (MCP); 250ms loop (CLI default, configurable) | Server-push via SSE — out of scope for v2.10; design clean enough to add later |

## Wave D — Authoring Substrate

The structural drift between authoring artifacts (designs, plans, handoffs) and gates that consume them caused seven authoring round-trips during the #1259 substrate plan (per #1298) — every failure was a heading-shape mismatch, not a content gap. Wave D shifts authoring from "reverse-engineer the regex" to "declare the structured contract."

**#1260 machine-readable invariants.** Today `#1109` invariants, axiom DIM-1..DIM-8, Aspire CLI patterns, and the basileus-forward boundary live in CLAUDE.md prose, scattered design docs, and project memory. `/ideate` does not consume them as a structured input on first turn — they surface only after the user pushes back. Extract into a single file (`docs/architecture/invariants.md` with structured YAML frontmatter, or `.exarchos/invariants.yml`). Each entry: `id`, `dimension`, `applies-to` scopes, `summary`, `references`. `commands/ideate.md` and the `brainstorming` skill load and surface the relevant invariants in the first synthesis pass. Vocabulary lint fails CI when an invariant is referenced by id but absent from the file (DIM-3). Eliminates one redirect cycle per ideation.

**#1298 designs/plans machine-readable sidecar.** Plans and designs emit a YAML sidecar (or frontmatter) declaring the structured shape:

```yaml
# docs/designs/<feature>.sidecar.yml
schema: design.v1
sections:
  problem: { present: true }
  approaches: { count: 3 }
  drs:
    - { id: DR-1, title: "...", section: "Wave A" }
    - { id: DR-2, ... }
  acceptance:
    - { id: A-1, references: [DR-1] }
```

Gates (`check_design_completeness`, `check_plan_coverage`, `check_provenance_chain`, `check_task_decomposition`) consume the sidecar; markdown becomes prose-only. **Co-existence period:** for one release after preview.4 merges, gates accept either sidecar OR regex-scrape, log a deprecation warning when only regex is present. Removal of the regex branch is scheduled for v2.11. Schema lives next to the action's outputSchema source-of-truth (`verbs/sidecar-schemas.ts`).

**#1244 markdown-aware handoff lint (DIM-8).** Run the existing `prose-lint.ts` infrastructure on `handoff.context / nextSteps / suggestions` at `handleCheckpoint` input-validation time. Soft-fail (warn but don't block) by default; opt-in hard-fail via `.exarchos.yml` config. Flags AI-padded content, broken inline links, malformed code fences. Without this, AI-padded handoffs accumulate in the event log and degrade the rehydrate surface for downstream agents.

### Wave D architectural choices

| Choice | Approach taken | Alternative rejected |
|---|---|---|
| Sidecar format | YAML alongside markdown | Frontmatter inline in markdown — same file; harder to gate parse; tooling treats it as data |
| Sidecar co-existence | Accept either sidecar or regex during transition window | Hard cutover — breaks every in-flight workflow design/plan |
| Invariants location | `docs/architecture/invariants.md` with structured frontmatter | `.exarchos/invariants.yml` — config-file-centric; violates [extensibility envelope](feedback_extensibility_design_envelope) |
| Handoff lint default | Soft-fail (warn) — operators can opt into hard-fail | Hard-fail by default — too noisy on existing event-log content |

## Sequencing

Wave A and Wave D touch disjoint surfaces; they can land in parallel as two PR stacks. Wave B's three-field correlation widens every event emission point and must land before Wave C (Tasks dispatch-core consumes the EventSourcedTaskStore from Wave B).

```
                 ┌──── Wave A (4 PRs) ──────┐
   main ─────────┤                          ├──── Wave B (3 PRs) ──── Wave C (1 PR)
                 └──── Wave D (3 PRs) ──────┘
                  (parallel; serial merge)
```

**Within-wave PR order (each is its own stack, merged bottom-up):**

- **Wave A:** #1238 (Zod refactor) → #1262 (quality hint) → #1290 (Roots) → #1274 (Elicitation). #1238 first because the parser change ripples through every `next_actions` consumer; #1290 + #1274 last because both extend `CapabilityResolver`.
- **Wave D:** #1260 (invariants doc) → #1298 (sidecar) → #1244 (handoff lint). #1260 first because the invariants surface anchors what #1298's sidecar declares.
- **Wave B:** #1291 (three-field correlation) → #1261 (dispatch.preflight events) → #1272 (EventSourcedTaskStore). #1291 lands first; #1261 + #1272 both thread the new fields.
- **Wave C:** #1273 (Tasks dispatch-core) — single PR; depends on Wave B closing.

**Total surface:** 11 PRs across 4 wave-stacks. Parallel-safe pairs (A + D, then B + waiting C) reduce wall-clock time vs strict 11-PR serial.

**Per-subagent worktree hygiene** (from project memory): each wave gets its own integration branch (`feature/preview4-wave-{a,b,c,d}`); subagent worktrees branch from the integration branch (not main). Explicit `git checkout -B <work-branch> feature/preview4-wave-X` reset in dispatch prompt. `npm install` runs inside `servers/exarchos-mcp/` for each subagent worktree (avoids fake Zod failures from missing nested deps).

## Conformance — Design Invariants

| Invariant | Check | Result |
|---|---|---|
| **INV-1 event-sourcing integrity** | All projections (TaskStore, telemetry, dispatch.preflight) reconstructable from event stream; correlation widens metadata, not state | PASS |
| **INV-2 facade equivalence** | Tasks dispatch-core shared across CLI `--follow` and MCP `tasks/*`; Roots/Elicitation in MCP path, CLI uses existing INVALID_INPUT (capability-gated parity) | PASS |
| **INV-3 basileus-forward** | TaskStore process-local; remote dispatchers carry their own. No basileus-surface touch | PASS |
| **INV-4 platform-agnosticity** | Sidecar + invariants are platform-agnostic structured artifacts; Roots/Elicitation are MCP-spec features (per-runtime parity declared via CapabilityResolver) | PASS |
| **INV-5a input ergonomics** | Roots eliminates "guess featureId"; Elicitation eliminates "trial-and-error which param is missing"; invariants doc eliminates ideation-redirect cycle. Three independent INV-5a wins | PASS (+) |
| **INV-5b output contract** | Quality hint registers against `view.describe`; three-field correlation registers against every action's outputSchema `_meta` branch; sidecar IS the structured output contract for designs/plans | PASS (+) |
| **INV-5c Aspire verbs** | No new verbs; existing actions extended | PASS |
| **INV-5d action discriminator** | No new actions; extensions only. New event types live under existing `event.kind` discriminator | PASS |
| **INV-6 workflow-agnosticism** | Invariants doc is workflow-agnostic; sidecar is workflow-typed (`schema: design.v1` / `plan.v1`); handoff lint operates at the checkpoint substrate. Skills touched (`brainstorming`, `implementation-planning`) already declare `metadata.workflow-type` | PASS |

**Notable INV-5a/b consequence:** Wave A + D together realize the "agent-first authoring envelope" referenced in project memory ([extensibility design envelope](feedback_extensibility_design_envelope)). Both consume structured artifacts (sidecar, invariants frontmatter) and produce structured outputs (next_actions, elicitation schemas). The freeze line for RC is exactly the boundary where these contracts solidify.

## Conformance — Axiom Dimensions

| Dimension | Concern | Verdict |
|---|---|---|
| **DIM-1 topology** | Single dispatch entry mints all three correlation fields; sidecar replaces regex-scrape as gate input SoT; TaskStore is the unique task-state projection | PASS (+) |
| **DIM-2 observability** | Wave B adds three new event types (`dispatch.preflight`, `stash.detected`, `task.*`); Wave A's quality hint surfaces telemetry through next_actions; three-field correlation closes the cross-event reconstruction gap | PASS (+) |
| **DIM-3 contracts** | #1238 Zod discriminated union; #1274 elicitation schema derived via `.pick()`; #1298 sidecar IS the contract; #1260 invariants doc has structured frontmatter | PASS (+) |
| **DIM-4 test fidelity** | Tasks lifecycle reconstructable from event stream (#1272); both capability-on and capability-off paths covered (Wave A); sidecar+regex parity tested during co-existence (Wave D); cross-wave correlation threading verified end-to-end | PASS |
| **DIM-5 dead code** | Sidecar deprecates regex-scrape gates (removal scheduled v2.11 — WATCH); #1238 removes inline guards + Record casts; `INVALID_INPUT` for missing-required-param becomes elicitation-fallback (not dead, but narrower) | WATCH |
| **DIM-6 coupling** | All capability checks route through `CapabilityResolver` (Roots, Elicitation, Tasks share one entry point); correlation threading uses a single context object passed through dispatch | PASS |
| **DIM-7 error handling** | Elicitation replaces silent INVALID_INPUT with structured prompt; Roots multi-match returns `validTargets`; TaskStore TTL prevents unbounded growth; `dispatch.preflight` makes guard failures observable | PASS (+) |
| **DIM-8 prose** | Handoff lint enforces at write time; sidecar reduces prose surface; invariants doc has structured frontmatter | PASS (+) |

**DIM-5 WATCH:** the regex-scrape gate branch is scheduled for removal in v2.11; the preview.4 PR for #1298 must include a tracking issue + deprecation log message so the removal is concrete, not aspirational.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wave B correlation threading is broad-blast — every event-emit site touched | Per-task TDD with cross-cutting end-to-end test ([blast-radius gate gap](feedback_tdd_gate_blast_radius)); run full suite between PRs in the Wave B stack, not just per-task scope |
| Wave C Tasks dispatch-core is the largest single issue (~2000 LOC est.) | Split internally: PR 1 = dispatch-core Tasks-augmented path + tests against `EventSourcedTaskStore`; PR 2 = MCP adapter `tasks/*` methods; PR 3 = CLI `--follow` integration |
| Sidecar co-existence window risks indefinite stay | Removal tracked in a follow-up issue committed in the same PR as #1298 lands; deprecation log message names the removal version |
| Per-handshake Roots cache invalidation race | `roots/list_changed` notification invalidates atomically before the next dispatch reads; test the race explicitly |
| Subagent worktree stash hazard during 4-wave parallel dispatch | Per project memory [stash collision](feedback_subagent_stash_hazard): one stash namespace per worktree; pre-dispatch guard refuses to `git stash` if a sibling stash exists on the shared store. Already covered by Wave 1 #1388 — verify it survived |
| Plugin deployment lag — preview.4 MCP fixes won't load until rebundle | Bump `2.10.0-preview.4` version in `package.json` only after all 11 PRs merge; install/rebundle/restart cycle documented in PR template |
| #1298 sidecar emission requires every existing design/plan to backfill | Backfill scoped to v2.10 design/plan docs only; older docs grandfathered with a doc comment pointing to the new format |

## Acceptance criteria

Composed from the eleven issues' acceptance lists. Per-wave, each issue's full acceptance set must pass.

**Wave A — Output Contract Completion**
- [ ] **#1238**: `nextActionsFromResult` uses `safeParse()` against the discriminated union; fail-closed on no-match; no `Record<string, unknown>` casts remain.
- [ ] **#1262**: telemetry crossing threshold yields a `next_actions` entry `{ verb: 'checkpoint', reason: "output tokens at <pct>%" }`; below-threshold emits no hint; threshold configurable via `.exarchos.yml`; CLI + MCP envelopes identical.
- [ ] **#1290**: capability resolver snapshots `roots` at handshake; one-match resolves with `workspace.resolved { source: 'roots' }`; zero matches → cwd-walk fallback; multi-match → `INVALID_INPUT` with `validTargets`; no silent resolution.
- [ ] **#1274**: missing-required-param + `elicitation` capability → `elicitation/create` with `.pick()`-derived schema; no capability → fallback INVALID_INPUT; `elicitation.requested/fulfilled` events carry `operationId`.

**Wave B — Correlation + Event Topology**
- [ ] **#1291**: every event emitted within a single `dispatch()` carries identical `operationId`; `correlationId` inherits or self-binds; `causationId` resolves to upstream event when auto-dispatched.
- [ ] **#1261**: `dispatch.preflight` fires per guard pass-or-fail; `stash.detected` fires on shared-stash observation; both events carry the three-field correlation.
- [ ] **#1272**: TaskStore lifecycle reconstructable from event stream alone (replay test); TTL expiration removes from projection; no `InMemoryTaskStore` instances in production wiring.

**Wave C — Tasks Dispatch-Core**
- [ ] **#1273**: `exarchos_view --follow workflow` and `--follow shepherd` drive the in-process polling loop; MCP `tools/call` with `task: { ttl }` returns `CreateTaskResult`; `tasks/get` + `tasks/result` work end-to-end; cancellation parity via SIGINT (CLI) and `tasks/cancel` (MCP) emits `task.cancelled` identically.

**Wave D — Authoring Substrate**
- [ ] **#1260**: `docs/architecture/invariants.md` exists with structured frontmatter; `/ideate` first-turn output includes a constraint-acknowledgement section; vocabulary lint fails on undefined invariant references.
- [ ] **#1298**: design + plan sidecars exist for at least one preview.4 design (this one); gates consume sidecar when present; regex fallback logs deprecation; tracking issue for regex removal filed in same PR.
- [ ] **#1244**: handoff write at `handleCheckpoint` runs prose lint; soft-fail by default; hard-fail opt-in via `.exarchos.yml`; AI-pad detection covered by the `prose-lint.ts` rule set.

**All 11 PRs**
- [ ] `npm run typecheck && npm run test:run` clean.
- [ ] `npm run skills:guard` clean.
- [ ] Outcome-test tier clean.
- [ ] `servers/exarchos-mcp/npm run test:run` clean.
- [ ] No new regressions in `view telemetry.errors` or `view telemetry.actionErrors` per the preview.3 split.

## Out of scope (deferred to RC or v2.11+)

- **#1330 / #1329 / #1301 dogfood gate-fix cluster** — bugs in the orchestrator gate machinery; RC-eligible.
- **#1337 doctor-workflow test backfill** — pure test coverage; RC-eligible.
- **#1234 / #1233 / #1232 / #1170 / #1169 E2E infra** — CI matrix, conformance, platform probes; RC-eligible or v2.11 depending on Windows runner availability.
- **#1296 HandoffEntrySchemaV1 retirement** — depends on on-disk doc count; RC-eligible once retention horizon passes.
- **#1292 SDK pin** — likely stale post-#1366 migration to SDK 1.29; verify and close if redundant.
- **#1321 description-budget CI guard** — preventive gate; RC-eligible.
- **#1299 authoring templates round-trip** — CI gate; RC-eligible.
- **#1342 Marten primitive consumers epic** — substrate leverage; explicitly out of preview.4 per scope choice B; v2.11 candidate.
- **#1353 highWaterMark cursor refinement** — Wave A follow-up from preview.1; substrate; v2.11 candidate.
- **#1352 compensation operationId reuse** — saga refinement; v2.11 candidate.
- **#1339 compound-exit undefined compoundStateId** — bug; RC-eligible.
- **#1238 `RehydrationDocumentSchema` reuse** — already in scope as Wave A's #1238; listed here only to disambiguate from possible future doc-schema work.
- **#1365 eval-suite redesign** — explicit v2.11+ per [seed doc](../../docs/research/2026-05-15-eval-suite-redesign-seed.md).
- **URL-mode elicitation** (OAuth flows) — out of scope per #1274; v2.12+.
- **`tasks/*` server-push SSE** — polling-only in preview.4; SSE design clean enough to add later.

## References

- Parent epic: [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) — v3.0.0 P2: Agent Output Contract (HATEOAS + NDJSON)
- Milestone-16 design: [`docs/designs/2026-05-07-milestone-16-mcp-alignment.md`](2026-05-07-milestone-16-mcp-alignment.md) §4.3, §4.4, §4.5, §4.6
- Wave 0 carrier: PR #1369 (squash `8a732811`, 2026-05-15)
- Wave 1 data safety: PR #1388 (squash `224027b5`, 2026-05-15)
- Wave 2 + Wave 3 polish: [`docs/designs/2026-05-15-wave2-wave3-polish.md`](2026-05-15-wave2-wave3-polish.md)
- Preview.3 close-out: [`docs/designs/2026-05-15-v2-10-0-preview-3-closeout.md`](2026-05-15-v2-10-0-preview-3-closeout.md)
- Eval-suite redesign seed (out of scope): [`docs/research/2026-05-15-eval-suite-redesign-seed.md`](../research/2026-05-15-eval-suite-redesign-seed.md)
- Insights friction discovery: `docs/contexts/2026-05-07-insights-friction-discovery.md` F1, F2, F3
- Marten event-store lessons (Wave B correlation): `docs/research/2026-05-08-marten-event-store-lessons.md` R-3
- Design invariants skill: `.claude/skills/design-invariants/SKILL.md`
- Backend quality dimensions: `axiom:backend-quality`
