# Spike: Closing the Platform Agnosticity Gap

**Date:** 2026-03-09
**Context:** PRs #982, #986, #988 shipped tool introspection (describe, topology, playbooks, autoEmits, requiredFields). Plugin-free MCP clients can now execute workflows mechanically. This spike explores closing the _decision quality_ gap without shipping content layers for non-Claude-Code tools.

## Problem Statement

The describe API provides the **mechanical layer** — schemas, phases, guards, event catalogs. Skills provide the **methodology layer** — decision frameworks, escalation criteria, anti-patterns, prompt templates. 60-75% of skill content is strategic/decisional, not mechanical.

A plugin-free client today can navigate the state machine correctly but makes poor judgment calls: when to escalate, when to switch tracks, how to frame subagent prompts, how to detect rationalization.

**Design constraint:** We will NOT ship content layers for other tools. We want the minimum platform-layer enhancements that let plugin-free clients make _reasonable_ decisions without replicating the full methodology.

## Three Levers

### Lever 1: Enriched compactGuidance

**Current state:** 24 playbook phases each have a compactGuidance string averaging 3.6 sentences (55-281 chars). Content is purely mechanical: "Use X to do Y. Transition to Z when done."

| Metric | Current | Target |
|--------|---------|--------|
| Avg sentences | 3.6 | 8-12 |
| Escalation criteria mentioned | 1/24 (4%) | ~15/24 (63%) |
| Anti-patterns mentioned | 2/24 (8%) | ~12/24 (50%) |
| Decision criteria (X vs Y) | 8/24 (33%) | ~18/24 (75%) |

**Proposed:** Expand compactGuidance from recipe to _compact methodology_. Each should include:

1. **What you're doing** (1-2 sentences) — current content, keep as-is
2. **Key decisions** (2-3 sentences) — the most impactful decision criteria for this phase
3. **Critical anti-patterns** (1-2 sentences) — top 1-2 mistakes to avoid
4. **Escalation trigger** (1 sentence) — when to stop and involve the human

**Example — delegate phase (current):**
> You are dispatching implementation tasks. Use exarchos_event to emit task.assigned for each dispatch. Use exarchos_workflow set to mark tasks complete. Run post-delegation-check.sh when all tasks finish. Transition to review phase when all tasks complete.

**Example — delegate phase (proposed):**
> You are dispatching implementation tasks to subagents in isolated worktrees. Each subagent prompt MUST be self-contained with full task description, file paths, and acceptance criteria — never reference "the plan" or prior context. Dispatch independent tasks in parallel using separate worktrees; never share a worktree between agents. Use exarchos_event to emit task.assigned per dispatch, team.spawned after creating the team, team.disbanded after collection. After each task completes, run the task-completion runbook (check_tdd_compliance → check_static_analysis → task_complete) before marking complete. Do NOT trust subagent self-assessment — verify test output independently. Escalate to user if the same task fails 3 times or if a task requires changes outside its declared module scope. Transition to review when all tasks[].status = 'complete'.

**Effort:** Low. String changes in `playbooks.ts`. No schema changes.

**Impact:** High for plugin-free clients. The enriched guidance encodes the top ~20% of strategic content that prevents ~80% of decision errors.

**Risk:** compactGuidance becomes a maintenance surface. Mitigation: drift tests can validate that guidance mentions tools/events that exist in the registry.

### Lever 2: Decision Runbooks

**Current state:** 6 runbooks covering 3 phases (delegate, review, synthesize). All are linear step sequences with `onFail: stop | continue`. No conditional branching, no composition, no escalation encoding.

**Gap:** Runbooks can't express "if convergence score < 0.6, escalate to user; if >= 0.6 and < 0.8, add quality hints to prompts; if >= 0.8, proceed normally." This decision logic lives entirely in skills.

**Proposed:** Add a new runbook category — _decision runbooks_ — that encode phase-entry decision trees as queryable metadata.

#### Option A: Structured Decision Steps (recommended)

Extend `RunbookStep` with an optional `decide` field:

```typescript
interface DecisionRunbookStep extends RunbookStep {
  readonly decide?: {
    readonly question: string;                    // "Is the bug reproducible?"
    readonly source: 'state-field' | 'gate-result' | 'event-count' | 'human';
    readonly field?: string;                      // state field path or gate name
    readonly branches: Record<string, {
      readonly label: string;                     // "yes", "no", ">= 3"
      readonly guidance: string;                  // what to do
      readonly nextStep?: string;                 // jump to step by id
      readonly escalate?: boolean;                // escalate to human
    }>;
  };
}
```

**Example — triage decision runbook:**
```typescript
{
  id: 'triage-decision',
  phase: 'triage',
  description: 'Decide between hotfix and thorough investigation tracks',
  steps: [
    {
      id: 'check-reproducibility',
      tool: 'none', action: 'decide',
      decide: {
        question: 'Is the bug reproducible with a specific test case?',
        source: 'human',
        branches: {
          'yes': { label: 'Reproducible', guidance: 'Write the failing test first, then proceed to hotfix-implement.', nextStep: 'check-scope' },
          'no': { label: 'Not reproducible', guidance: 'Investigate further — add logging, check error patterns.', nextStep: 'thorough-track' },
        }
      }
    },
    {
      id: 'check-scope',
      tool: 'none', action: 'decide',
      decide: {
        question: 'Does the fix touch more than 3 files or cross module boundaries?',
        source: 'human',
        branches: {
          'yes': { label: 'Large scope', guidance: 'Switch to thorough track — this needs RCA.', nextStep: 'thorough-track' },
          'no': { label: 'Small scope', guidance: 'Proceed with hotfix. Apply minimal targeted fix. 15-minute time limit.', nextStep: 'hotfix-track' },
        }
      }
    },
    // ...
  ]
}
```

**Queryable via:** `exarchos_orchestrate({ action: "runbook", id: "triage-decision" })`

**Key property:** Decision runbooks are _advisory_, not executable. The agent reads the decision tree and follows the guidance. The platform doesn't execute branches — it provides the structure for the agent to reason about.

**Coverage targets:**
| Phase | Decision Runbook | Key Decision |
|-------|-----------------|--------------|
| triage | `triage-decision` | Hotfix vs thorough track |
| investigate | `investigation-decision` | When to escalate to RCA |
| explore (refactor) | `scope-decision` | Polish vs overhaul track |
| delegate | `dispatch-decision` | Parallel vs sequential, agent-team vs subagent |
| review | `review-escalation` | Fix cycle vs block vs pass |
| synthesize | `shepherd-escalation` | Keep iterating vs escalate to user |

**Effort:** Medium. Extend RunbookStep type, add ~6 new decision runbook definitions, update handler to serve them.

**Impact:** High. Encodes the decision trees that are currently buried in 800+ lines of skill references. Plugin-free clients get structured decision guidance without needing skills.

**Risk:** Decision runbooks could diverge from skill guidance. Mitigation: skills reference decision runbooks instead of encoding their own decision logic (Phase 4-style refactoring).

#### Option B: Annotated Transitions (lighter alternative)

Instead of new runbooks, attach decision metadata to the existing topology transitions:

```typescript
// In topology describe response
{
  from: 'investigate',
  to: 'hotfix-implement',
  guard: { id: 'hotfix-track-selected', description: '...' },
  decisionCriteria: {
    question: 'Is this a simple, reproducible fix touching <= 3 files?',
    factors: ['reproducibility', 'scope', 'urgency'],
    antiPattern: 'Do not choose hotfix for intermittent bugs or cross-module issues',
    escalationTrigger: '15 minutes elapsed without root cause identification'
  }
}
```

**Effort:** Low-medium. Extends topology serialization, no new tool actions.

**Impact:** Medium. Less structured than Option A, but zero new API surface.

### Lever 3: Schema Field Descriptions

**Current state:** `exarchos_event describe(eventTypes: ['team.spawned'])` returns full JSON Schema via `zodToJsonSchema`. Field types and constraints are present, but no human-readable descriptions.

**Proposed:** Add `.describe()` to Zod schema fields:

```typescript
// Before
export const TeamSpawnedData = z.object({
  teamSize: z.number().int(),
  teammateNames: z.array(z.string()),
  taskCount: z.number().int(),
  dispatchMode: z.string(),
});

// After
export const TeamSpawnedData = z.object({
  teamSize: z.number().int().describe('Number of agents spawned in this team'),
  teammateNames: z.array(z.string()).describe('Names assigned to each teammate agent'),
  taskCount: z.number().int().describe('Number of tasks to distribute across the team'),
  dispatchMode: z.string().describe('Dispatch mechanism: "subagent" or "agent-team"'),
});
```

`zodToJsonSchema` automatically propagates `.describe()` into the JSON Schema `description` field. No handler changes needed.

**Coverage:** ~65 event types, ~300 fields. Prioritize model-emitted events (25 types) since those are the ones agents must construct manually.

**Effort:** Low. Mechanical annotation work. No code changes beyond schema file.

**Impact:** Medium. Eliminates "what does this field mean?" guesswork. Combined with #988's `requiredFields` in eventHints, agents get field names + types + descriptions in a single hint.

## Recommendation

**Ship in this order:**

| Priority | Lever | Effort | Impact | Rationale |
|----------|-------|--------|--------|-----------|
| P0 | Lever 1: Enriched compactGuidance | Low | High | Highest ROI. String changes only. Encode top decision criteria directly into the playbook response every client already queries. |
| P1 | Lever 3: Schema field descriptions | Low | Medium | Mechanical `.describe()` annotations. Zero handler changes. Immediate improvement to event emission UX. |
| P2 | Lever 2A: Decision runbooks | Medium | High | Most architectural value but requires type extensions and new definitions. Should follow Lever 1 since compactGuidance handles the common case. |

**What we explicitly do NOT build:**
- Full skill serving via MCP (would replicate the content layer)
- Prompt template serving (implementer/fixer prompts stay in skills)
- Rationalization-refutation catalogs via MCP (too Claude-Code-specific)
- Automatic decision execution in runbooks (agents decide, platform advises)

## Success Criteria

A plugin-free client (Cursor/Copilot with MCP) should be able to:

1. **Bootstrap:** `describe(playbook: "feature")` → read enriched compactGuidance → know what to do, what to avoid, and when to escalate for every phase
2. **Emit events:** `_eventHints` with `requiredFields` + `describe(eventTypes)` with field descriptions → construct correct payloads without trial-and-error
3. **Make decisions:** `runbook({ id: "triage-decision" })` → structured decision tree → choose correct track with documented rationale
4. **Recover:** `describe(topology)` + guard descriptions → understand why a transition failed and what's needed to satisfy it

**Measurable target:** A plugin-free client completes a feature workflow end-to-end with <= 2x the tool call count of a Claude Code client with full content layer. (Current estimate without enhancements: 3-5x due to trial-and-error.)

## Open Questions

1. **compactGuidance length budget:** Should we cap at ~500 chars? ~1000? Current playbook responses are ~2KB; enriched guidance would push to ~5-8KB. Is that acceptable for a describe response?
2. **Decision runbook execution model:** Advisory-only (agent reads and decides) vs. interactive (agent calls back with answers, platform routes to next step)? Advisory is simpler but less deterministic.
3. **Skill ↔ runbook drift:** If we encode decisions in runbooks AND skills, which is authoritative? Should skills reference decision runbooks (like they reference describe for schemas)?
4. **Scope of Lever 3:** Annotate all 65 event types or just the 25 model-emitted ones?
