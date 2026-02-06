# Workflow State MCP Server — Known Issues

Discovered during the `agent-teams-bridge` feature workflow on 2026-02-05.

---

## Bug 1: `workflow_set` updates overwrite sibling artifact keys

**Severity:** High — breaks workflow progression

**Reproduction:**
1. Initialize a workflow — `artifacts` starts as `{ design: null, plan: null, pr: null }`
2. Set design artifact: `workflow_set({ updates: { artifacts: { design: "path/to/design.md" } } })`
3. Result: `artifacts` becomes `{ design: "path/to/design.md" }` — `plan` and `pr` keys are **deleted**
4. Any subsequent phase transition that validates `artifacts.plan` or `artifacts.pr` fails with `STATE_CORRUPT: Schema validation failed`

**Root Cause:** The `workflow_set` handler does a shallow merge of `updates` into state. Setting `updates.artifacts` replaces the entire `artifacts` object rather than deep-merging into it. The Zod schema requires all three keys (`design`, `plan`, `pr`), so the missing keys cause validation failure on next read.

**Location:** `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts` — the update application logic

**Expected Behavior:** Setting `updates.artifacts.design` should merge into the existing `artifacts` object, preserving `plan` and `pr`.

**Workaround:** Always include ALL artifact keys when updating any artifact:
```json
{ "updates": { "artifacts": { "design": "path", "plan": null, "pr": null } } }
```
Or edit the state file directly.

---

## Bug 2: Zod schema strips dynamic fields, breaking guard evaluation

**Severity:** High — blocks `plan-review` → `delegate` transition

**Reproduction:**
1. Transition to `plan-review` phase
2. Set `planReview.approved = true` via `workflow_set({ updates: { planReview: { approved: true } } })`
3. The field IS written to the JSON file (verified by reading raw file)
4. Attempt transition: `workflow_set({ phase: "delegate" })`
5. **Fails** with `GUARD_FAILED: Guard 'plan-review-complete' failed`

**Root Cause:** Two different code paths read state differently:

| Code Path | How State Is Read | Has `planReview`? |
|-----------|-------------------|-------------------|
| `workflow_set` (phase transition) | `readStateFile()` → `WorkflowStateSchema.safeParse()` → strips unknown keys | **No** |
| `workflow_next_action` | `JSON.parse(rawFile)` → preserves all keys | **Yes** |

The `readStateFile()` function at `state-store.ts:151` uses `WorkflowStateSchema.safeParse(migrated)`, which returns `result.data` — Zod's default behavior strips keys not in the schema. The `planReview` field is not in the Zod schema (it's a dynamic workflow-specific field), so it gets stripped.

When `workflow_set` calls `executeTransition()` at `tools.ts:166`, it passes the Zod-parsed `mutableState` (without `planReview`). The guard at `state-machine.ts:291-293` evaluates `state.planReview?.approved === true` against this stripped object and returns `false`.

Meanwhile, `workflow_next_action` at `tools.ts:737` reads raw JSON and correctly sees `planReview.approved === true`.

**Location:**
- `plugins/workflow-state/servers/workflow-state-mcp/src/state-store.ts:151` — `safeParse` strips unknown keys
- `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts:160-166` — passes stripped state to guard
- `plugins/workflow-state/servers/workflow-state-mcp/src/state-machine.ts:288-294` — guard expects dynamic field

**Expected Behavior:** Guard evaluation should use the full state (including dynamic fields), not the Zod-stripped state.

**Fix Options:**
1. **Use `.passthrough()` on the Zod schema** — `WorkflowStateSchema.passthrough()` preserves unknown keys during parsing. Simplest fix.
2. **Read raw JSON for guard evaluation** — Like `workflow_next_action` does at line 737, read raw JSON and pass it to `executeTransition()` for guard evaluation.
3. **Add `planReview` to the schema** — Make it a known optional field. Most type-safe but requires schema changes for every new dynamic field.

**Workaround:** Edit the state file directly to change the `phase` field, bypassing the MCP tool's guard evaluation.

---

## Bug 3: `workflow_set` updates field silently dropped when not in schema

**Severity:** Medium — related to Bug 2 but distinct

**Reproduction:**
1. Call `workflow_set({ updates: { planReview: { approved: true, gapsFound: false, gaps: [] } } })`
2. The MCP tool returns `success: true` with the data including `planReview`
3. Call `workflow_get({ query: "planReview" })` immediately after
4. Returns empty — `planReview` is not in the response

**Root Cause:** The `workflow_set` handler applies updates to `mutableState` (Zod-parsed, already stripped). The dynamic `planReview` field gets added to `mutableState` in memory, which is why the tool response includes it. But when `writeStateFile()` serializes the state, it writes the in-memory object which DOES have it (since JavaScript objects accept arbitrary keys). The issue is that `readStateFile()` strips it again on the next read.

Wait — actually, re-reading the file directly showed `planReview` IS persisted. The `workflow_get` query returning empty may be a separate issue with the dot-path query not finding it in the Zod-parsed state.

**Clarification:** The field IS written to disk. It's stripped on read. So `workflow_get` returns empty because it reads via `readStateFile()` which strips unknown keys. This is the same root cause as Bug 2.

---

## Bug 4: `workflow_init` creates `artifacts` with only `design: null`

**Severity:** Low — triggers Bug 1 on first artifact update

**Reproduction:**
1. Call `workflow_init({ featureId: "test", workflowType: "feature" })`
2. The created state file has `"artifacts": { "design": null, "plan": null, "pr": null }`
3. Call `workflow_set({ updates: { artifacts: { design: "path.md" } } })`
4. State now has `"artifacts": { "design": "path.md" }` — `plan` and `pr` lost

**Root Cause:** Same as Bug 1 — shallow merge. The init creates the correct shape, but the first update destroys it.

---

## Summary of Fixes Needed

| Bug | Priority | Fix |
|-----|----------|-----|
| Bug 2 (Zod strips dynamic fields) | **P0** | Add `.passthrough()` to `WorkflowStateSchema` or read raw JSON for guards |
| Bug 1 (shallow artifact merge) | **P1** | Deep-merge `updates` into state, at least for known nested objects |
| Bug 3 (query returns empty for dynamic fields) | **P1** | Same fix as Bug 2 |
| Bug 4 (init shape destroyed on update) | **P2** | Resolves automatically when Bug 1 is fixed |
