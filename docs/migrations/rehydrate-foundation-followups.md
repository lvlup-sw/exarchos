# Rehydrate-foundation: deferred migration items

This document is a registry of work that was scoped out during the rehydrate-foundation TDD wave (tasks T001–T061, branch `rehydrate-foundation-integration`). Each item has a brief description of the current state, the gap that remains, a scope estimate (S = half-day, M = 1–2 days, L = 3+ days), and the task that surfaced the deferral. None of these items are blocking the foundation merge; all represent planned follow-up work.

Design reference: `docs/designs/2026-04-23-rehydrate-foundation.md` DR-16.

---

### 1. `decisions` section reducer (T025)

- **State:** `rehydrationReducer` includes a `decisions` field initialized to an empty array. The `fold` function has a TODO comment noting that no `decision.*` event source is registered.
- **Gap:** No event type emits into the `decisions` slice. The reducer fold is a stub. Consumers reading `document.decisions` always receive `[]`.
- **Scope:** M — requires defining a `workflow.decision_recorded` (or equivalent) event schema, registering it in the event store, and wiring the reducer fold.
- **Linked task:** T025

---

### 2. `applyCacheHints` composite wiring (T051) — RESOLVED on PR #1178

- **State:** Resolved during the PR #1178 review cycle. `DispatchContext` now carries a `capabilityResolver`; `core/context.ts` and `index.ts` both construct one defaulting to `[ANTHROPIC_NATIVE_CACHING]`, gated by `EXARCHOS_DISABLE_CACHE_HINTS=1` as a kill switch. `workflow/composite.ts` introduces a rehydrate-only `envelopeWrapWithCacheHints` that applies the helper after `wrap()` and before the `wrapWithPassthrough` finalisation. Other workflow actions remain on the plain `envelopeWrap` so cache annotations don't leak into mutating dispatches.
- **Coverage:** Four new behavioural tests in `workflow/composite.test.ts` cover the four resolver cases (capability + no resolver + empty resolver + non-rehydrate-actions-never-emit), plus two `core/context.test.ts` cases for the env kill switch.
- **Linked task:** T051 (closed)

---

### 3. CI workflow wiring for `check-golden-fixture-note.mjs` (T053)

- **State:** `scripts/check-golden-fixture-note.mjs` exists, exports `checkGoldenFixtureNote`, and is unit-tested via `scripts/check-golden-fixture-note.test.ts`.
- **Gap:** No `.github/workflows/` job invokes the script. The PR-body marker check (`GOLDEN-FIXTURE-UPDATE:`) never runs in CI; load-bearing fixture edits can land silently.
- **Scope:** S — add a `pr-body-check` job (or extend an existing workflow) that runs `node scripts/check-golden-fixture-note.mjs` on `pull_request: [synchronize, edited]`, passing `GITHUB_EVENT_PATH` for changed-files and PR body.
- **Linked task:** T053

---

### 4. `deliveryPath` arg unused upstream (T031)

- **State:** `handleRehydrate` accepts a `deliveryPath` argument (`'direct' | 'ndjson' | 'snapshot'`) and surfaces it in the `workflow.rehydrated` event payload. The argument is accepted and stored correctly.
- **Gap:** No caller passes a non-default value. CLI entrypoint, MCP composite, and the `session-start` hook all omit `deliveryPath`, so it defaults to `'direct'` unconditionally. The `--via=ndjson` flag and snapshot-on-start path are not threaded through.
- **Scope:** M — thread `deliveryPath` from (a) the CLI `rehydrate` command (`--via` flag), (b) the MCP `exarchos_workflow` composite, and (c) the session-start hook; add per-path integration tests.
- **Linked task:** T031

---

### 5. `nextAction` field omitted from `rehydrationReducer.initial` (T025)

- **State:** The `rehydrationReducer` initial state does not include a `nextAction` field. The envelope's `next_actions` array is populated on fold, but the singular `nextAction` convenience field is absent.
- **Gap:** Consumers that expect a top-level `nextAction` (mirroring `next_actions[0]`) in the document body receive `undefined`. The schema marks the field optional, so no validation error surfaces, but the omission may silently degrade consumer UX.
- **Scope:** S — derive `nextAction = next_actions[0] ?? null` on each fold step; or explicitly document that `next_actions` is the canonical field and consumers must not rely on a singular mirror.
- **Linked task:** T025

---

### 6. EventStore polling adapter (T042)

- **State:** `pollingEventSource` (default 500 ms interval) is wired into the `event query --follow` path because the EventStore does not expose a native subscribe or watch API. The implementation is functional and tested.
- **Gap:** Polling introduces latency proportional to the interval and generates unnecessary I/O under low-event conditions. No native subscribe/watch API exists. Throughput ceilings under high-event load are unmeasured.
- **Scope:** L — design and implement a real subscribe API on the EventStore (likely a callback registry or async-iterator interface); benchmark polling vs. subscribe; or formally document that 500 ms polling is acceptable and gate on a load-test result.
- **Linked task:** T042

---

### 7. Spec drift: design-doc `deliveryPath` enum (T031)

- **State:** The registered `workflow.rehydrated` schema uses the vocabulary `direct | ndjson | snapshot`. The implementation follows the registered schema.
- **Gap:** The design document (`docs/designs/2026-04-23-rehydrate-foundation.md`) specifies the enum as `command | mcp | cli | session-start`, which describes the *caller* not the *delivery mechanism*. The two vocabularies are semantically distinct and both partially correct; they are currently inconsistent.
- **Scope:** S — either (a) reconcile the design doc to match the registered schema vocabulary (`direct | ndjson | snapshot`) and close the drift, or (b) re-register the schema with a richer enum that encodes both caller identity and delivery mechanism, and update `handleRehydrate` accordingly.
- **Linked task:** T031

---

### 8. SessionStart `.checkpoint.json` reader is stale (T059)

- **State:** `cli-commands/session-start.ts:113` scans for `<featureId>.checkpoint.json` files at session boot, reads them, and uses them to construct context. T059 replaced the writer (pre-compact) with `handleCheckpoint`, which now writes `<featureId>.projections.jsonl` instead.
- **Gap:** The reader and writer are no longer producing/consuming the same file. SessionStart now never finds checkpoint files in real use (only in `session-start.test.ts`, which writes `.checkpoint.json` fixtures by hand). The two integration tests in `cli-commands/context-reload.integration.test.ts` are skipped for this reason. Rehydration via `session-start` hook is currently a no-op.
- **Scope:** M — update `session-start.ts` to read the latest snapshot via `readLatestSnapshot(stateDir, featureId, "rehydration@v1", "1")` from T019 (or equivalently dispatch to `exarchos_workflow.rehydrate`); migrate `session-start.test.ts` fixtures from `.checkpoint.json` to `.projections.jsonl`; un-skip the two integration tests in `context-reload.integration.test.ts`.
- **Linked task:** T059

---

### 9. Legacy `workflow/next-action.ts` deletion (T060)

- **State:** T060 extracted the pure logic into a registered `next-action@v1` reducer at `projections/next-action/`. The legacy `workflow/next-action.ts` was kept because its `handleNextAction` MCP handler and `HUMAN_CHECKPOINT_PHASES` table are still imported by `workflow/tools.ts`, `cli-commands/pre-compact.ts`, `cli-commands/assemble-context.ts`, and three `__tests__/workflow/*.test.ts` files.
- **Gap:** Two parallel sources of truth for "what's next" remain: the legacy `handleNextAction` and the new `next-action@v1` reducer + T040 `computeNextActions` + T041 envelope `next_actions`. Future drift between them is likely without intervention.
- **Scope:** M — migrate each caller to the new reducer / envelope path; relocate `HUMAN_CHECKPOINT_PHASES` to a shared workflow-state module; delete `workflow/next-action.ts`; update the three legacy `__tests__` files.
- **Linked task:** T060
