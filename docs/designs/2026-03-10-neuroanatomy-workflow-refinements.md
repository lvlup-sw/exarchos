# Design: Neuroanatomy-Informed Workflow Refinements

> Apply transformer neuroanatomy research patterns to Exarchos workflows — multi-pass
> refinement, effort budgeting, cognitive function isolation, phase transition compression,
> and self-consistency gates.
>
> *2026-03-10*

---

## 1. Problem Statement

Two persistent pain points motivate this work:

1. **Spec drift**: Requirements are lost or distorted as they pass through the workflow pipeline
   (ideate → plan → delegate → review). Despite provenance tracking and convergence gates,
   the transformation from abstract design requirements to concrete implementation tasks
   introduces information loss at each boundary.

2. **Token budget**: The workflow consumes more tokens than necessary because:
   - All subagents run at the same model tier regardless of task complexity
   - Phase transitions carry forward uncompressed artifacts
   - Reviews run single-pass, catching some issues but missing others
   - No effort differentiation between cognitively simple and complex operations

Three research sources (Curse of Depth, RYS/LLM Neuroanatomy, Huginn) converge on actionable
principles that directly address these problems. The existing applied document
(`docs/adrs/transformer-neuroanatomy-applied-agent-tooling.md`) translates the research into
seven patterns. This design applies those patterns concretely to the Exarchos workflow while
correcting technical inaccuracies in the applied document.

---

## 2. Design Requirements

### ADR Document Corrections

- **DR-1**: Correct Pattern 7 (Prompt Structure) mechanism explanation — prompt order affects
  attention patterns, not layer zone activation
- **DR-2**: Correct Pattern 4 (Self-Consistency) attribution — acknowledge Wang et al. (2022)
  as independent prior art; reframe Huginn connection as analogical reinforcement
- **DR-3**: Correct Pattern 6 (Model Tiering) mechanism — model tiers differ in architecture,
  training, and optimization, not just "reasoning circuit depth"
- **DR-4**: Add nuance to the three-zone anatomy — acknowledge it as a useful simplification
  with cross-zone computation and attention head specialization within circuits
- **DR-5**: Add API-level implementation details for effort parameter (`output_config.effort`:
  `low` | `medium` | `high` | `max`) and adaptive thinking (`thinking: {type: "adaptive"}`),
  cross-referenced with official Anthropic documentation
- **DR-6**: Add Claude Code integration specifics — model selection as primary lever, prompt-based
  effort steering as secondary, since Claude Code's Agent tool does not expose an `effort` parameter

### Multi-Pass Refinement (Pattern 2)

- **DR-7**: Design phase produces reasoning and formatting in separate passes — the first call
  focuses on architectural decisions, the second on document generation
- **DR-8**: Planning phase uses three-stage decomposition — logical units → concrete tasks →
  parallelization plan (with context packages per subagent)
- **DR-9**: Both review stages (spec-review, quality-review) use two-pass evaluation — high-recall
  pass followed by high-precision filtering pass

### Effort Budgeting (Patterns 1 + 6)

- **DR-10**: Agent specs include effort-appropriate system prompt guidance — scaffolding agents
  receive conciseness instructions, complex reasoning agents receive thoroughness instructions
- **DR-11**: Delegation skill classifies tasks by cognitive complexity and assigns model tier
  accordingly: `haiku` for scaffolding/formatting, `sonnet` for standard implementation,
  `opus` for complex reasoning and edge cases
- **DR-12**: Agent spec type (`AgentSpec`) extended with optional `effort` field for
  platform-agnostic API integrations, with documentation noting Claude Code uses model
  selection + prompt steering instead

### Phase Transition Compression (Pattern 5)

- **DR-13**: Every phase transition includes an explicit compression step — previous phase output
  is summarized to the minimum context the next phase needs
- **DR-14**: Compression is documented in skill instructions with specific carry-forward budgets
  (e.g., "carry forward ~200-token summary, not the full brainstorming transcript")

### Self-Consistency Gate (Pattern 4)

- **DR-15**: Plan-review boundary includes a self-consistency check — the plan-to-design coverage
  analysis runs 2-3 times with prompt variation, and disagreements are surfaced for human attention

### Platform Abstraction

- **DR-16**: All changes are structured as platform-agnostic patterns with Claude Code-specific
  implementation notes — the patterns work with any model API, but the Claude Code integration
  layer uses the levers available (model selection, prompt steering, multi-pass orchestration)

---

## 3. Technical Design

### 3.0 Architecture: Platform-Agnostic First

Per the platform-agnosticity direction (PRs #982, #986, #993), workflow logic lives in the
**infrastructure layer** (playbooks, decision runbooks, handlers, agent specs), not in the
content layer (skills). Skills are a Claude Code-specific UX wrapper that references
infrastructure via `describe` and `runbook` calls.

The neuroanatomy patterns must be encoded at the infrastructure layer so plugin-free clients
(Cursor, Copilot, etc.) receive the same guidance via `describe(playbook: "feature")` and
`runbook({ id: "..." })`.

```
┌─────────────────────────────────────────────────────────────┐
│  Infrastructure Layer (TypeScript — platform-agnostic)       │
│                                                              │
│  Playbooks:     compactGuidance enriched with patterns       │
│  Runbooks:      task-classification, review-strategy          │
│  Agent specs:   scaffolder + effort field                     │
│  Handlers:      prepare_delegation → effort recommendations  │
│  ADR docs:      corrected mechanism explanations              │
├─────────────────────────────────────────────────────────────┤
│  Content Layer (Skills — Claude Code only, thin wrappers)    │
│                                                              │
│  Skills:        reference new runbooks/playbooks via describe │
│                 minimal prose updates, not logic-bearing      │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 ADR Document Corrections

The following corrections apply to `docs/adrs/transformer-neuroanatomy-applied-agent-tooling.md`.
These are factual corrections — not infrastructure code.

#### Pattern 4 — Self-Consistency (DR-2)

**Current (incorrect):** Frames self-consistency entirely as an application-layer analog of
Huginn's latent convergence.

**Corrected:** Self-consistency via multiple independent model calls is established prior art
(Wang et al., "Self-Consistency Improves Chain of Thought Reasoning in Language Models," 2022).
The Huginn convergence observation *reinforces* why this works — independent calls trigger the
same reasoning circuits, which produce consistent outputs when the problem is well-defined — but
the technique is independently validated. The practical implementation and decision matrix are
unchanged.

#### Pattern 6 — Model Tiering (DR-3)

**Current (oversimplified):** Claims model tiers correspond to "depth and sophistication of
reasoning circuits."

**Corrected:** Model tiers differ in architecture, training data, optimization targets, and
capability profiles — not solely in reasoning circuit depth. The practical mapping (cheap models
for encoding/decoding, expensive for reasoning) holds empirically. The mechanism is empirical
capability matching, not a direct layer-count relationship.

#### Pattern 7 — Prompt Structure (DR-1)

**Current (incorrect mechanism):** Claims prompt order matters because different sections
"activate" different layer zones (encoding, reasoning, decoding).

**Corrected:** All tokens pass through all layers — there is no selective layer activation.
Prompt order matters because of the **autoregressive attention mask**: each token attends to all
preceding tokens. Placing context before the question allows the model's attention heads to
attend to relevant context when processing the question. Placing output format specifications
last means they are closest to the generation point, where they have maximum influence on
decoding behavior. The practical advice is identical; the mechanism is attention pattern
optimization, not layer-zone activation.

#### Three-Zone Anatomy Nuance (DR-4)

**Addition to Section 5.1:** The three-zone anatomy (encoder, reasoning cortex, identity
collapse, decoder) is a useful simplification that captures the dominant organizational pattern.
In practice: attention heads within circuits specialize for different functions, some cross-zone
computation occurs (early layers do lightweight reasoning-adjacent work), and the exact
boundaries vary by architecture, input, and task. The model is most useful as a design heuristic
for agent orchestration, not as a precise anatomical map.

#### New Section: Effort Control Across Platforms (DR-5, DR-6)

**New section after Pattern 7** — Documents the `effort` API parameter and Claude Code mapping.

**API-level (platform-agnostic):**

```
output_config: { effort: "low" | "medium" | "high" | "max" }
thinking: { type: "adaptive" }   // recommended for Opus 4.6, Sonnet 4.6
```

| Effort | Thinking behavior | Task fit |
|--------|-------------------|----------|
| `low` | May skip thinking entirely | Scaffolding, formatting, routing |
| `medium` | Moderate thinking, skips on simple queries | Standard implementation, integration |
| `high` (default) | Almost always thinks deeply | Complex reasoning, architecture, edge cases |
| `max` (Opus 4.6 only) | Unconstrained depth | Hardest problems requiring deepest analysis |

Key principle from Anthropic: "Effort is a behavioral signal, not a strict token budget."

**Claude Code integration:** Agent tool does not expose `effort`. Levers: model selection
(`haiku`/`sonnet`/`opus`), prompt-based effort steering (Anthropic confirms adaptive thinking is
promptable), and multi-pass orchestration.

---

### 3.2 Playbook Enrichment (compactGuidance)

The primary mechanism for encoding neuroanatomy patterns platform-agnostically. Each feature
workflow playbook gets enriched compactGuidance that includes the pattern-specific guidance.
These are served via `describe(playbook: "feature")` to any MCP client.

#### 3.2.1 Ideate Phase — Two-Step Design + Compression (DR-7, DR-13)

**Current guidance:** "Use exarchos_workflow set to record design decisions..."

**Enrichment:** Add to compactGuidance: "Separate design reasoning from document formatting —
first determine architectural decisions, trade-offs, and requirements (DR-N), then format into
the document template. Before design generation, compress brainstorming discussion into a
~300-token summary (problem statement, key decisions, chosen approach, constraints) and use that
as design input, not the full transcript."

#### 3.2.2 Plan Phase — Three-Stage Decomposition + Context Packaging (DR-8, DR-14)

**Current guidance:** "Break work into parallelizable TDD tasks..."

**Enrichment:** Add: "Decompose in three stages: (1) logical work units with dependency graph,
(2) concrete TDD tasks per unit, (3) parallelization plan with self-contained context packages
per task. Each context package (~500 tokens) quotes the relevant DR-N requirements and design
sections inline — subagent prompts must not reference external documents."

#### 3.2.3 Plan-Review Phase — Self-Consistency (DR-15)

**Current guidance:** "Wait for user approval or revision feedback..."

**Enrichment:** Add: "Before presenting for approval, run coverage analysis with 3 varied
framings: (1) which DR-N are NOT covered, (2) does each DR-N have a fully-addressing task,
(3) are there orphan tasks or partial coverage. If all 3 agree: present verdict. If they
disagree on a specific DR-N: surface the disagreement to the human reviewer — ambiguous
requirements caught here prevent downstream spec drift."

#### 3.2.4 Delegate Phase — Effort Classification + Context Scoping (DR-10, DR-11, DR-14)

**Current guidance:** "Each subagent prompt must be self-contained..."

**Enrichment:** Add: "Classify each task by cognitive complexity before dispatch. Use the
`task-classification` decision runbook to select agent spec (scaffolder for low-complexity,
implementer for medium/high). Pass per-task context packages from the plan, not the full design
document. For API integrations, map complexity to effort parameter (low/medium/high)."

#### 3.2.5 Review Phase — Two-Pass Evaluation (DR-9)

**Current guidance:** "Running two-stage code review (spec + quality)..."

**Enrichment:** Add: "Each review stage uses two passes: Pass 1 (high-recall) flags every
potential issue including uncertain ones. Pass 2 (high-precision) filters Pass 1 findings —
classifying each as confirmed, acceptable, or false positive. The two-pass structure catches
requirements that single-pass review misses. Use the `review-strategy` decision runbook to
determine when two-pass is warranted vs single-pass."

---

### 3.3 Decision Runbooks

New decision runbooks encode the neuroanatomy patterns as queryable advisory structures. These
extend the existing runbook infrastructure from PR #993.

#### 3.3.1 Task Classification Runbook (DR-10, DR-11)

```typescript
export const TASK_CLASSIFICATION: RunbookDefinition = {
  id: 'task-classification',
  phase: 'delegate',
  description: 'Classify task cognitive complexity and select agent spec + effort level.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the task description indicate scaffolding (test stubs, boilerplate, type definitions, interfaces)?',
        source: 'state-field',
        field: 'tasks[].title',
        branches: {
          'yes': { label: 'Scaffolding', guidance: 'Use scaffolder agent spec (model: sonnet, effort: low). Prompt: be concise, create exactly what is specified, follow existing patterns.' },
          'no': { label: 'Not scaffolding', guidance: 'Proceed to complexity assessment.', nextStep: 'check-complexity' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-complexity',
      decide: {
        question: 'Does the task involve edge cases, error handling, algorithms, or multi-module dependencies?',
        source: 'state-field',
        field: 'tasks[].blockedBy',
        branches: {
          'yes': { label: 'High complexity', guidance: 'Use implementer agent spec (model: opus, effort: high). Prompt: be thorough, consider failure modes, boundary conditions, and interaction effects.' },
          'no': { label: 'Standard complexity', guidance: 'Use implementer agent spec (model: inherit, effort: medium). Default prompt — no additional effort guidance needed.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the task context package from the plan exceed 500 tokens?',
        source: 'human',
        branches: {
          'yes': { label: 'Large context', guidance: 'Compress the context package. Quote only the directly relevant DR-N requirements and the specific design section — not adjacent sections.', escalate: false },
          'no': { label: 'Right-sized context', guidance: 'Context package is appropriately scoped. Pass it directly to the subagent prompt.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};
```

#### 3.3.2 Review Strategy Runbook (DR-9)

```typescript
export const REVIEW_STRATEGY: RunbookDefinition = {
  id: 'review-strategy',
  phase: 'review',
  description: 'Decide between two-pass and single-pass review based on change characteristics.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the diff touch more than 5 files or span multiple modules?',
        source: 'state-field',
        field: 'tasks.length',
        branches: {
          'yes': { label: 'Large change', guidance: 'Use two-pass review. Pass 1: flag everything (high-recall). Pass 2: filter to confirmed issues with severity ratings (high-precision). Large changes benefit from the refinement pass.', nextStep: 'check-prior-failures' },
          'no': { label: 'Small change', guidance: 'Single-pass review is sufficient for small, focused changes.', nextStep: 'check-prior-failures' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-prior-failures',
      decide: {
        question: 'Has this feature had a prior review failure (fix cycle)?',
        source: 'event-count',
        field: 'workflow.fix-cycle',
        branches: {
          'yes': { label: 'Prior failures', guidance: 'Use two-pass review regardless of change size. The fix cycle indicates the first review missed something — a refinement pass is needed to catch what was missed.', escalate: false },
          'no': { label: 'First review', guidance: 'Proceed with the strategy selected above.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is this a spec-review or quality-review stage?',
        source: 'state-field',
        field: 'reviews',
        branches: {
          'spec-review': { label: 'Spec review', guidance: 'For two-pass: Pass 1 focuses on requirement coverage and TDD compliance. Pass 2 filters false positives and rates severity.' },
          'quality-review': { label: 'Quality review', guidance: 'For two-pass: Pass 1 focuses on bugs, security, SOLID, maintainability. Pass 2 drops low-confidence findings and prioritizes remainder.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};
```

---

### 3.4 Agent Spec Extensions (DR-10, DR-11, DR-12)

**New agent spec: `scaffolder`**

For tasks classified as low-complexity (test stubs, boilerplate, type definitions):

```typescript
export const SCAFFOLDER: AgentSpec = {
  id: 'scaffolder',
  description: 'Low-complexity scaffolding tasks — test stubs, boilerplate, type definitions.',
  systemPrompt: `You are a scaffolding agent. Be concise and efficient.
Focus on the specific task. Do not over-engineer or add extras.

## Task
{{taskDescription}}

## Files
{{filePaths}}

## Rules
- Create exactly what is specified, nothing more
- Follow existing patterns in the codebase
- Output a completion report when done

## Completion Report
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<created/modified files>"]
}
\`\`\``,
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  disallowedTools: ['Agent'],
  model: 'sonnet',
  effort: 'low',
  isolation: 'worktree',
  skills: [],
  validationRules: [
    { trigger: 'post-test', rule: 'All tests must pass', command: 'npm run test:run' },
  ],
  resumable: false,
  mcpServers: ['exarchos'],
};
```

**AgentSpec type extension:**

```typescript
export type AgentSpecId = 'implementer' | 'fixer' | 'reviewer' | 'scaffolder';

export interface AgentSpec {
  // ... existing fields ...
  readonly effort?: 'low' | 'medium' | 'high' | 'max';
}
```

The `effort` field is advisory metadata. For API integrations it maps to
`output_config.effort`. For Claude Code it documents intent (the model selection + system
prompt do the work).

---

### 3.5 Handler Enhancement: prepare_delegation (DR-11, DR-16)

Extend the existing `prepare_delegation` handler to return per-task effort recommendations.

**Current return shape:** `{ ready, worktrees, qualityHints }`

**Extended return shape:**
```typescript
{
  ready: boolean,
  worktrees: [...],
  qualityHints: [...],
  taskClassifications: [
    {
      taskId: string,
      complexity: 'low' | 'medium' | 'high',
      recommendedAgent: 'scaffolder' | 'implementer',
      effort: 'low' | 'medium' | 'high',
      reason: string,  // e.g., "task title contains 'stub'"
    }
  ]
}
```

Classification logic (pure TypeScript, deterministic):
- Title/description contains scaffolding indicators → `low` / `scaffolder`
- Task has 2+ dependencies (`blockedBy.length >= 2`) → `high` / `implementer`
- Task targets 3+ files → `high` / `implementer`
- Otherwise → `medium` / `implementer`

This is advisory — the agent can override. But it provides a deterministic starting point that
plugin-free clients can follow without interpreting prose.

---

### 3.6 Playbook compactGuidance: Compression Guidance (DR-13, DR-14)

Phase transition compression is encoded in compactGuidance strings at phase boundaries:

| Phase | Compression guidance added to compactGuidance |
|-------|-----------------------------------------------|
| `ideate` | "Compress brainstorming to ~300-token summary before design generation" |
| `plan` | "Each task gets a ~500-token self-contained context package quoting relevant DR-N sections" |
| `delegate` | "Pass per-task context packages, not the full design document" |
| `review` | "Review receives integration diff (not full files) + ~300-token summary per task" |

These are embedded in the compactGuidance strings updated in §3.2. No separate mechanism needed.

---

## 4. Changes Summary

### Infrastructure Layer (TypeScript)

| File | Change | DRs |
|------|--------|-----|
| `servers/exarchos-mcp/src/workflow/playbooks.ts` | Enrich 5 feature phase compactGuidance strings | DR-7, DR-8, DR-9, DR-10, DR-11, DR-13, DR-14, DR-15 |
| `servers/exarchos-mcp/src/runbooks/definitions.ts` | Add TASK_CLASSIFICATION + REVIEW_STRATEGY runbooks | DR-9, DR-10, DR-11 |
| `servers/exarchos-mcp/src/agents/types.ts` | Add `effort` field + `'scaffolder'` to AgentSpecId | DR-11, DR-12 |
| `servers/exarchos-mcp/src/agents/definitions.ts` | Add SCAFFOLDER agent spec | DR-11 |
| `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` | Return taskClassifications in output | DR-11, DR-16 |

### ADR Documents

| File | Change | DRs |
|------|--------|-----|
| `docs/adrs/transformer-neuroanatomy-applied-agent-tooling.md` | Correct Patterns 4, 6, 7 + anatomy nuance + new effort section | DR-1 through DR-6 |

### Content Layer (skill markdown — thin updates)

| File | Change | DRs |
|------|--------|-----|
| `skills/delegation/SKILL.md` | Add Schema Discovery section referencing task-classification runbook | DR-11 |
| `skills/spec-review/SKILL.md` | Add Schema Discovery section referencing review-strategy runbook | DR-9 |
| `skills/quality-review/SKILL.md` | Add Schema Discovery section referencing review-strategy runbook | DR-9 |

---

## 5. What This Design Does NOT Include

- **Dynamic budget estimation** (TALE-like classifier) — Deferred. The `prepare_delegation`
  handler uses simple heuristics (title keywords, dependency count, file count). A trained
  classifier can replace the heuristics later without changing the interface.
- **Self-consistency at all gates** — Only at plan-review via playbook guidance. May expand
  to review→synthesize boundary in a future iteration.
- **Formal compression contracts** — Compression budgets are advisory in compactGuidance
  strings, not enforced by schema validation.
- **HSM sub-states** — Multi-pass review and three-stage planning are encoded as guidance in
  playbooks and runbooks, not as new HSM states. Adding sub-states is a future option if
  the advisory approach proves insufficient.

---

## 6. Testing Strategy

- **Playbook enrichment**: Drift tests verify compactGuidance length bounds (<=750 chars) and
  that non-terminal phases mention tools/actions. Existing drift tests from PR #993.
- **Decision runbooks**: Structural invariant tests (at least 2 decision steps with branches,
  at least one escalation branch). Same pattern as existing runbook tests.
- **Agent specs**: Co-located unit tests in `agents.test.ts`. Verify scaffolder config, effort
  field, unique IDs, valid tools.
- **Handler enhancement**: Unit test for `prepare_delegation` with task fixtures. Verify
  classification output matches expected complexity levels.
- **ADR corrections**: Manual review for factual accuracy.

---

## 7. Open Questions

1. **Scaffolder model**: `sonnet` vs `haiku`? Sonnet is safer; Haiku is cheaper. Start with
   sonnet, measure error rate, downgrade if acceptable.

2. **Two-pass review cost**: Worth the latency? The review-strategy runbook lets agents
   *decide* — two-pass for large/failed changes, single-pass for small/first reviews. This
   is self-regulating rather than always-on.

3. **prepare_delegation classification accuracy**: The heuristic (title keywords, dep count,
   file count) may misclassify. It's advisory, so agents can override. Track override rate
   to calibrate.

4. **compactGuidance length budget**: Enriched guidance may approach the ~750 char cap.
   Measure actual lengths and trim if needed.
