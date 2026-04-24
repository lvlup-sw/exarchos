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

### 2. `applyCacheHints` composite wiring (T051)

- **State:** `applyCacheHints` helper exists in `servers/exarchos-mcp/src/format.ts` and is unit-tested. It annotates high-priority fields with MCP cache-control hints.
- **Gap:** No composite tool calls `applyCacheHints`. The `envelopeWrap` path in `workflow/composite.ts` does not invoke it at the rehydrate dispatch path, so cache hints are never applied in production responses.
- **Scope:** S — wire `applyCacheHints(envelope)` into `workflow/composite.ts`'s `envelopeWrap` at the rehydrate dispatch path; add an integration-level assertion.
- **Linked task:** T051

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
