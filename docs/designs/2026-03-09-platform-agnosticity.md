# Design: Closing the Platform Agnosticity Gap

**Date:** 2026-03-09
**Feature ID:** `platform-agnosticity`
**Spike:** `docs/designs/2026-03-09-platform-agnosticity-spike.md`
**Depends on:** PRs #982, #986, #988 (tool introspection phases 1-4)

## Problem

Plugin-free MCP clients (Cursor, Copilot, etc.) can navigate Exarchos workflows mechanically via the describe API but make poor judgment calls: when to escalate, when to switch tracks, how to frame subagent prompts, how to detect rationalization. 60-75% of skill content is strategic/decisional, not mechanical.

**Design constraint:** We will NOT ship content layers for other tools. We want the minimum platform-layer enhancements that let plugin-free clients make reasonable decisions without replicating the full methodology.

## Approach

Three complementary levers shipped in priority order. Each lever is independently valuable — no lever depends on another.

## Lever 1: Enriched compactGuidance

### Current State

24 playbook phases each have a `compactGuidance` string averaging 3.6 sentences (55-281 chars). Content is purely mechanical: "Use X to do Y. Transition to Z when done."

### Design

Expand `compactGuidance` from recipe to compact methodology. Each guidance string includes four sections:

1. **What you're doing** (1-2 sentences) — current content, keep as-is
2. **Key decisions** (1-2 sentences) — the most impactful decision criteria for this phase
3. **Critical anti-pattern** (1 sentence) — top mistake to avoid
4. **Escalation trigger** (1 sentence) — when to stop and involve the human

**Length budget (D3-aligned):** ~500 char soft cap per phase. Complex phases (delegate, review, synthesize) may stretch to ~750 chars. Total playbook response grows from ~2KB to ~4KB — a 2x increase, acceptable for a describe response that bootstraps an entire workflow.

### Targets

| Metric | Current | Target |
|--------|---------|--------|
| Avg chars | ~150 | ~450 |
| Escalation criteria mentioned | 1/24 (4%) | ~18/24 (75%) |
| Anti-patterns mentioned | 2/24 (8%) | ~18/24 (75%) |
| Decision criteria (X vs Y) | 8/24 (33%) | ~20/24 (83%) |

### Requirements

**DR-1: Enrich all feature workflow compactGuidance strings**
Expand 9 feature workflow playbook phases (ideate, plan, plan-review, delegate, review, synthesize, completed, cancelled, blocked) with the four-section format.
**Acceptance criteria:**
- Each non-terminal phase includes all 4 sections (what/decisions/anti-pattern/escalation)
- No guidance string exceeds 750 chars
- Terminal phases (completed, cancelled) remain unchanged
- Existing playbook tests pass without modification to assertions about structure

**DR-2: Enrich all debug workflow compactGuidance strings**
Expand 10 debug workflow playbook phases with the four-section format.
**Acceptance criteria:**
- Each non-terminal phase includes all 4 sections
- Track-selection phases (investigate, hotfix-validate) include explicit track decision criteria
- No guidance string exceeds 750 chars

**DR-3: Enrich all refactor workflow compactGuidance strings**
Expand 11 refactor workflow playbook phases with the four-section format.
**Acceptance criteria:**
- Each non-terminal phase includes all 4 sections
- Track-selection phase (brief) includes polish vs overhaul decision criteria
- No guidance string exceeds 750 chars

**DR-4: compactGuidance drift test**
Add a test that validates structural properties of all compactGuidance strings.
**Acceptance criteria:**
- Test verifies no guidance string exceeds 750 chars
- Test verifies non-terminal, non-blocked phases mention at least one tool or action
- Test covers all registered playbooks (not a hardcoded list — iterates registry)
- Test fails if a new playbook is added without compactGuidance

## Lever 2: Decision Runbooks

### Current State

6 runbooks covering 3 phases (delegate, review, synthesize). All are linear step sequences with `onFail: stop | continue`. No conditional branching, no decision encoding.

### Design

Add a new runbook category — decision runbooks — that encode phase-entry decision trees as queryable advisory metadata. Advisory-only: the agent reads the decision tree and follows the guidance. The platform does not execute branches (D5-aligned: structured enough for determinism, no execution coupling).

Extend `RunbookStep` with an optional `decide` field:

```typescript
interface DecisionBranch {
  readonly label: string;
  readonly guidance: string;
  readonly nextStep?: string;
  readonly escalate?: boolean;
}

interface DecisionField {
  readonly question: string;
  readonly source: 'state-field' | 'gate-result' | 'event-count' | 'human';
  readonly field?: string;
  readonly branches: Record<string, DecisionBranch>;
}

interface DecisionRunbookStep extends RunbookStep {
  readonly decide?: DecisionField;
}
```

Decision runbooks are authoritative for decision logic. Skills reference them instead of encoding their own decision trees (D2-aligned, same pattern as PR #986's skill refactoring for schemas).

### Coverage

| Phase | Decision Runbook | Key Decision |
|-------|-----------------|--------------|
| triage (debug) | `triage-decision` | Hotfix vs thorough track |
| investigate (debug) | `investigation-decision` | When to escalate to RCA |
| explore (refactor) | `scope-decision` | Polish vs overhaul track |
| delegate (feature/refactor) | `dispatch-decision` | Parallel vs sequential, team size |
| review (all) | `review-escalation` | Fix cycle vs block vs pass |
| synthesize (all) | `shepherd-escalation` | Keep iterating vs escalate to user |

### Requirements

**DR-5: Extend RunbookStep type with optional decide field**
Add `DecisionField` and `DecisionBranch` interfaces to the runbook types. Extend `RunbookStep` (or create `DecisionRunbookStep` that extends it) with an optional `decide` field.
**Acceptance criteria:**
- New types compile under strict TypeScript
- Existing runbook definitions remain valid without modification
- `decide` field is optional — linear runbooks are unaffected

**DR-6: Implement 6 decision runbook definitions**
Create the 6 decision runbooks listed in the coverage table above.
**Acceptance criteria:**
- Each runbook has at least 2 decision steps with branches
- Each runbook includes at least one `escalate: true` branch
- Branch guidance strings are actionable (not generic)
- All runbooks are registered in `ALL_RUNBOOKS` (or equivalent registry)

**DR-7: Serve decision runbooks via existing runbook action**
Decision runbooks are queryable via `exarchos_orchestrate({ action: "runbook", id: "<id>" })` — same as existing linear runbooks. No new tool actions.
**Acceptance criteria:**
- `runbook` action returns decision runbooks with `decide` fields intact
- Response includes `steps[].decide.question`, `steps[].decide.branches`
- Existing linear runbook responses are unchanged (backward compatible)

**DR-8: Skill refactoring — replace inline decision logic with runbook references**
Update skills that currently encode decision trees inline (debug, refactor, delegation, quality-review) to reference decision runbooks instead.
**Acceptance criteria:**
- At least 4 skills updated with "Decision Runbook" reference sections
- Inline decision trees in skill prose are replaced with runbook references
- Skills that had track-selection logic now reference the corresponding decision runbook

## Lever 3: Schema Field Descriptions

### Current State

`exarchos_event describe(eventTypes: ['team.spawned'])` returns full JSON Schema via `zodToJsonSchema`. Field types and constraints are present, but no human-readable descriptions. Zero `.describe()` calls in `schemas.ts`.

### Design

Add `.describe()` annotations to Zod schema fields for model-emitted event types. `zodToJsonSchema` automatically propagates `.describe()` into the JSON Schema `description` field — no handler changes needed.

Scope: 25 model-emitted event types only (D3-aligned: these are the events agents must construct manually). System-emitted events have auto-populated payloads and are lower priority.

### Requirements

**DR-9: Annotate all model-emitted event schema fields with .describe()**
Add `.describe()` to every field in the ~25 model-emitted event type Zod schemas.
**Acceptance criteria:**
- Every field in model-emitted event schemas has a `.describe()` annotation
- Descriptions are 5-20 words — concise, not verbose
- `zodToJsonSchema` output includes `description` for every annotated field
- No handler code changes — schema file changes only

**DR-10: Schema description drift test**
Add a test that verifies model-emitted event schemas have descriptions on all fields.
**Acceptance criteria:**
- Test iterates all model-emitted event schemas (based on emission catalog from PR #982)
- Test verifies each field in the JSON Schema output has a `description` property
- Test fails if a new model-emitted event type is added without field descriptions

## Error Handling & Edge Cases

**DR-11: Graceful degradation for decision runbook queries**
When a decision runbook references a state field or gate result that doesn't exist yet, the response should still be useful.
**Acceptance criteria:**
- Decision runbook responses include the full tree regardless of current state
- `source: 'state-field'` branches include the field path so agents can query it
- No runtime errors when querying a decision runbook before any state exists

## Architecture Notes

### What We Explicitly Do NOT Build
- Full skill serving via MCP (would replicate the content layer)
- Prompt template serving (implementer/fixer prompts stay in skills)
- Rationalization-refutation catalogs via MCP (too Claude-Code-specific)
- Automatic decision execution in runbooks (agents decide, platform advises)

### D1-D5 Alignment Summary
- **D1 (Spec Fidelity):** Every DR has testable acceptance criteria
- **D2 (Pattern Compliance):** Decision runbooks follow the same describe-reference pattern established by PR #986. Skills reference platform metadata, not the reverse
- **D3 (Context Economy):** ~500 char cap on compactGuidance, model-emitted events only for Lever 3, advisory-only runbooks (no extra round-trips)
- **D4 (Operational Resilience):** All changes are additive — no breaking changes to existing describe responses. Drift tests catch maintenance regressions
- **D5 (Workflow Determinism):** Structured decision branches replace prose-based decision logic. Advisory model preserves agent autonomy while increasing determinism

## Success Criteria

A plugin-free client (Cursor/Copilot with MCP) should be able to:

1. **Bootstrap:** `describe(playbook: "feature")` → read enriched compactGuidance → know what to do, what to avoid, and when to escalate for every phase
2. **Emit events:** `_eventHints` with `requiredFields` + `describe(eventTypes)` with field descriptions → construct correct payloads without trial-and-error
3. **Make decisions:** `runbook({ id: "triage-decision" })` → structured decision tree → choose correct track with documented rationale
4. **Recover:** `describe(topology)` + guard descriptions → understand why a transition failed and what's needed to satisfy it

**Measurable target:** Plugin-free client completes a feature workflow end-to-end with <= 2x the tool call count of a Claude Code client with full content layer.

## Shipping Order

| Priority | Lever | DRs | Effort | Impact |
|----------|-------|-----|--------|--------|
| P0 | Lever 1: Enriched compactGuidance | DR-1 through DR-4 | Low | High |
| P1 | Lever 3: Schema field descriptions | DR-9, DR-10 | Low | Medium |
| P2 | Lever 2: Decision runbooks | DR-5 through DR-8, DR-11 | Medium | High |
