# Design: SDLC Eval Framework — Eval Flywheel for Exarchos Prompt Surfaces

## Problem Statement

The Exarchos content layer (12 skills, 11 commands, 11 rules, 3 shared prompts, 2 spawn templates — ~43,500 words across 34 files) drives the entire SDLC workflow. Changes to any prompt surface can silently degrade workflow outcomes. Three failure modes exist with no measurement infrastructure:

1. **Workflow stalls** — Agents loop, call wrong tools, or require human intervention at non-checkpoint phases. Context exhaustion, phase confusion, and tool misuse cause stalls that the progressive-disclosure-hooks design mitigates mechanically but cannot measure.

2. **Output quality degradation** — Agents produce plans that miss design coverage, code that fails review, PRs that need rework. The work completes but poorly. No baseline exists to detect regression.

3. **Prompt fragility** — Model updates (Claude 4.5 → 5.0), skill edits, rule changes, or tool registry migrations cause regressions. Something that worked yesterday breaks today. Without regression evals, changes are validated by "vibes" — subjective manual inspection that doesn't scale.

These three failure modes map to the eval taxonomy from Anthropic's agent eval guide:
- **Reliability evals** → stalls (pass^k: does the workflow succeed every time?)
- **Capability evals** → quality (pass@k: can the workflow produce good output?)
- **Regression evals** → fragility (does a change break what previously worked?)

### Relationship to Existing Designs

| Design | Layer | Relationship |
|---|---|---|
| Progressive Disclosure & Hooks | MCP server (tools, hooks, registry) | Provides the tool registry, hook architecture, and CLI entry point consumed by this design |
| Skills Content Modernization | Content (skills, commands, rules) | Provides YAML frontmatter, split skills, and generated tool manifests that become eval surfaces |
| **This design** | **Measurement (evals, graders, datasets)** | **Measures the effectiveness of both layers above** |

### Theoretical Alignment

This design implements the **evaluation flywheel** (OpenAI) as the core methodology:

```
Analyze → Measure → Improve → (repeat)
```

And the **self-evolving agent** pattern (OpenAI) for automated prompt refinement:

```
Baseline Agent → Feedback (LLM judge) → Eval Score → Prompt Update → Updated Agent
```

Grounded in Anthropic's agent eval best practices:
- Grade **outcomes**, not paths (agents find creative solutions)
- Use **capability evals** (low pass rate, driving improvement) + **regression evals** (high pass rate, preventing backsliding)
- Start with **20-50 tasks from real failures**, not synthetic data
- **Read the transcripts** — invest in tooling for viewing eval traces

---

## Chosen Approach

**Hybrid: Promptfoo graders + custom Exarchos harness.**

Use Promptfoo's assertion library and grader ecosystem for the scoring engine, but wrap it in a custom eval harness that:
- Reads eval suites from `evals/` directories alongside skills
- Executes multi-turn workflow traces through the actual MCP server
- Grades with Promptfoo's assertion types (exact match, similarity, LLM rubric, custom JS)
- Emits results as `eval.*` events to the Exarchos event stream
- Materializes results into CQRS views for trend tracking and flywheel analysis

**Why Promptfoo:**
- Used by Anthropic internally for product evals
- Rich assertion library: 30+ types including `llm-rubric`, `is-json`, `contains-all`, `javascript`, `python`
- Model-agnostic: Claude (default judge), GPT (cross-validation), local models
- Built-in caching, concurrency, and comparison reporting
- Active open-source project with strong documentation

**Why custom harness:**
- Promptfoo's runner evaluates single prompt→response pairs. SDLC workflows are multi-turn, multi-agent, tool-using sequences that require trace-level evaluation.
- Results must flow through the Exarchos event stream for unified observability with workflow data.
- Eval suites must be aware of the tool registry and skill frontmatter.

---

## Technical Design

### 1. Eval Suite Structure

Each skill that needs evaluation gains an `evals/` directory:

```
skills/
├── brainstorming/
│   ├── SKILL.md
│   └── evals/
│       ├── suite.yaml          # Eval configuration (Promptfoo-compatible)
│       ├── datasets/
│       │   ├── golden.jsonl    # Golden dataset: input traces + expected outputs
│       │   └── regression.jsonl # Known-good outputs that must not regress
│       └── graders/
│           └── design-quality.js  # Custom JS grader for design doc evaluation
├── delegation/
│   ├── SKILL.md
│   ├── references/
│   └── evals/
│       ├── suite.yaml
│       ├── datasets/
│       │   ├── golden.jsonl
│       │   ├── regression.jsonl
│       │   └── seeded-defects.jsonl  # Intentionally flawed inputs for review testing
│       └── graders/
│           ├── task-decomposition.js
│           └── tool-call-verification.js
├── quality-review/
│   └── evals/
│       ├── suite.yaml
│       ├── datasets/
│       │   ├── golden.jsonl
│       │   └── defect-detection.jsonl  # Code with known defects; does review catch them?
│       └── graders/
│           ├── defect-recall.js    # What fraction of seeded defects were found?
│           └── false-positive-rate.js
```

**Suite configuration** (`suite.yaml`):

```yaml
# skills/delegation/evals/suite.yaml
description: Delegation skill evaluation suite
metadata:
  skill: delegation
  phase-affinity: delegate
  version: 1.0.0

# Grader definitions
assertions:
  - type: javascript
    name: task-decomposition-quality
    path: ./graders/task-decomposition.js
    threshold: 0.8

  - type: llm-rubric
    name: plan-coverage
    model: claude-sonnet-4-5-20250929
    rubric: |
      Evaluate whether the task decomposition covers all sections of the design document.
      Score 0 if major design sections are missing from the task list.
      Score 1 if all design sections have corresponding tasks.
      Partial credit for partial coverage.

  - type: javascript
    name: tool-call-correctness
    path: ./graders/tool-call-verification.js
    threshold: 1.0

# Dataset references
datasets:
  capability:
    path: ./datasets/golden.jsonl
    description: Complex decomposition scenarios testing edge cases
  regression:
    path: ./datasets/regression.jsonl
    description: Known-good outputs that must not regress
```

### 2. Dataset Format

Datasets are JSONL files where each line represents an eval case. The format supports both single-turn (prompt→response) and multi-turn (trace) evaluation:

```jsonl
{"id": "del-001", "type": "trace", "description": "Simple 3-task feature decomposition", "input": {"design_path": "docs/designs/example-simple.md", "design_content": "..."}, "expected": {"task_count_min": 3, "task_count_max": 5, "required_coverage": ["API endpoint", "data model", "tests"], "tool_calls": ["exarchos_workflow:set", "exarchos_orchestrate:team_spawn"]}, "tags": ["regression", "simple"]}
{"id": "del-002", "type": "trace", "description": "Complex feature with cross-cutting concerns", "input": {"design_path": "docs/designs/example-complex.md", "design_content": "..."}, "expected": {"task_count_min": 6, "parallel_groups_min": 2, "required_coverage": ["auth", "data model", "API", "frontend", "tests", "docs"]}, "tags": ["capability", "complex"]}
```

**Dataset sourcing strategy** (from Anthropic's guide: "start with 20-50 tasks from real failures"):

1. **Phase 1 — Capture real traces:** Instrument the existing workflow hooks to record traces (tool calls, responses, outcomes) for completed workflows. The `PostToolUse` hook emits structured trace events.
2. **Phase 2 — Expert annotation:** Developer reviews traces, marks pass/fail, adds failure mode labels (open coding → axial coding per the flywheel methodology).
3. **Phase 3 — Synthetic expansion:** Use dimensional generation (per receipt inspection cookbook) to create edge cases across key dimensions: `(workflow_type, task_complexity, language, domain)`.

### 3. Eval Harness

The eval harness is a TypeScript module in the Exarchos MCP server package that orchestrates eval runs.

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/evals/`

```
evals/
├── harness.ts          # Eval runner: discovers suites, executes, grades, emits events
├── graders/
│   ├── index.ts        # Grader registry and factory
│   ├── code-graders.ts # Deterministic graders (exact match, schema, tool calls)
│   ├── llm-graders.ts  # LLM-as-judge graders (Claude default, pluggable)
│   └── trace-graders.ts # Multi-turn trace analyzers
├── datasets/
│   ├── loader.ts       # JSONL dataset loader with validation
│   └── generator.ts    # Synthetic dataset generation helpers
├── reporters/
│   ├── event-reporter.ts  # Emits eval.* events to Exarchos event stream
│   ├── cli-reporter.ts    # Terminal output for local runs
│   └── ci-reporter.ts     # GitHub Actions annotation output
└── types.ts            # Shared type definitions
```

**Core interfaces:**

```typescript
interface EvalSuite {
  readonly description: string;
  readonly metadata: {
    readonly skill: string;
    readonly phaseAffinity: string;
    readonly version: string;
  };
  readonly assertions: readonly AssertionConfig[];
  readonly datasets: Record<string, DatasetConfig>;
}

interface EvalCase {
  readonly id: string;
  readonly type: 'single' | 'trace';
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
  readonly tags: readonly string[];
}

interface EvalResult {
  readonly caseId: string;
  readonly suiteId: string;
  readonly passed: boolean;
  readonly score: number;          // 0.0 - 1.0
  readonly assertions: readonly AssertionResult[];
  readonly duration: number;       // ms
  readonly tokenUsage: number;     // total tokens consumed by graders
  readonly trace?: TraceRecord[];  // Full trace for transcript review
}

interface IGrader<TInput = unknown, TExpected = unknown> {
  readonly name: string;
  readonly type: 'code' | 'llm' | 'trace';
  grade(input: TInput, output: unknown, expected: TExpected): Promise<GradeResult>;
}

interface GradeResult {
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
  readonly details?: Record<string, unknown>;
}
```

**Promptfoo integration point:**

The harness uses Promptfoo's assertion evaluation engine as a library rather than its CLI runner:

```typescript
import { evaluate } from 'promptfoo';

// Use Promptfoo's assertion evaluation for individual assertions
// but orchestrate the multi-turn trace execution ourselves
async function gradeCase(evalCase: EvalCase, output: unknown, suite: EvalSuite): Promise<EvalResult> {
  const assertionResults = await Promise.all(
    suite.assertions.map(assertion =>
      evaluateAssertion(assertion, evalCase.input, output, evalCase.expected)
    )
  );

  return {
    caseId: evalCase.id,
    suiteId: suite.metadata.skill,
    passed: assertionResults.every(r => r.passed),
    score: assertionResults.reduce((sum, r) => sum + r.score, 0) / assertionResults.length,
    assertions: assertionResults,
    duration: /* measured */,
    tokenUsage: /* accumulated */,
  };
}
```

### 4. Three Eval Layers

#### Layer 1: Regression Evals (Fragility Detection)

**Purpose:** Prevent backsliding. Expected pass rate: ~100%. Any failure is a signal that a prompt change broke existing behavior.

**What they test:**
- Known-good workflow traces still produce acceptable output after prompt changes
- Tool call patterns haven't changed unexpectedly
- Phase transitions still follow the state machine
- Output format/structure hasn't drifted

**Grader types:** Primarily code-based (exact match, schema validation, tool call verification). Fast, deterministic, cheap.

**When they run:**
- CI: On every PR that modifies files in `skills/`, `commands/`, `rules/`, or `shared/prompts/`
- Local: On-demand via `cli.ts eval-run --layer regression`

**Dataset construction:** Capture passing traces from stable workflows. Freeze as regression baselines. Graduate from capability evals when pass rate saturates (Anthropic's guidance).

#### Layer 2: Capability Evals (Quality Measurement)

**Purpose:** Drive improvement. Expected pass rate starts low — these test difficult scenarios that push the system's limits.

**What they test:**
- `/plan` produces task decompositions that fully cover design documents (LLM-graded coverage analysis)
- `/review` catches intentionally seeded defects (precision/recall on known bugs)
- `/delegate` correctly routes complex vs. simple tasks (tool call analysis)
- Spawn prompts produce agents that follow TDD, SOLID, and naming conventions (LLM rubric)
- Design docs from `/ideate` are actionable and complete (LLM rubric)

**Grader types:** Mix of LLM-as-judge (rubrics for subjective quality) and code-based (defect detection rates, coverage metrics).

**When they run:**
- CI: On PRs modifying content layer (alongside regression, but failures are advisory, not blocking)
- Local: During development iteration on skills

**Metrics:**
- `pass@1`: Does it succeed on first try? (reliability)
- `pass@3`: Does it succeed in at least 1 of 3 attempts? (capability ceiling)
- Per-assertion breakdown for targeted improvement

#### Layer 3: Reliability Evals (Stall Detection)

**Purpose:** Detect agent stalls, loops, and phase confusion. These evaluate workflow *liveness*, not output quality.

**What they test:**
- Workflow completes within budget (steps, tokens, wall time)
- No loop detection triggers (exact repetition, oscillation, no-progress)
- Tools called are valid for the current phase (phase guardrail compliance)
- Context checkpoint/resume cycle works (PreCompact → SessionStart roundtrip)
- Subagent context injection is correct (SubagentStart hook output)

**Grader types:** Primarily code-based (timeout checks, loop pattern detection, tool call validation against registry phase mappings).

**When they run:**
- CI: On PRs modifying MCP server code, hooks, or tool registry
- Local: After tool registry changes

### 5. Eval Event Schema

Results emit to the Exarchos event stream, enabling CQRS materialization and trend tracking.

```typescript
// Event types for eval results
interface EvalRunStarted {
  type: 'eval.run.started';
  runId: string;
  suiteId: string;
  layer: 'regression' | 'capability' | 'reliability';
  trigger: 'ci' | 'local' | 'scheduled';
  timestamp: string;
}

interface EvalCaseCompleted {
  type: 'eval.case.completed';
  runId: string;
  caseId: string;
  passed: boolean;
  score: number;
  assertions: Array<{ name: string; passed: boolean; score: number; reason: string }>;
  duration: number;
  tokenUsage: number;
}

interface EvalRunCompleted {
  type: 'eval.run.completed';
  runId: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgScore: number;
    duration: number;
    tokenUsage: number;
  };
  regressions: string[];  // Case IDs that previously passed but now fail
}
```

### 6. CQRS View: EvalResultsView

A materialized view projecting eval events into a queryable format.

```typescript
interface EvalResultsView {
  // Per-skill aggregate scores over time
  skills: Record<string, {
    latestScore: number;
    trend: 'improving' | 'stable' | 'degrading';
    lastRunId: string;
    lastRunTimestamp: string;
    regressionCount: number;
    capabilityPassRate: number;
  }>;

  // Per-run details
  runs: Array<{
    runId: string;
    suiteId: string;
    layer: string;
    trigger: string;
    summary: RunSummary;
    timestamp: string;
  }>;

  // Active regressions (cases that previously passed but now fail)
  regressions: Array<{
    caseId: string;
    suiteId: string;
    firstFailedRunId: string;
    consecutiveFailures: number;
  }>;
}
```

Accessed via the existing `exarchos_view` composite tool:

```typescript
// New action in the view composite
z.object({
  action: z.literal('eval_results'),
  skill: z.string().optional(),     // Filter by skill
  layer: z.enum(['regression', 'capability', 'reliability']).optional(),
  limit: z.number().optional(),
})
```

### 7. CLI Integration

The eval harness integrates with the existing CLI entry point from the progressive-disclosure-hooks design:

```typescript
// In cli.ts — new commands
case 'eval-run':
  // Run eval suites
  // --suite <name>: Run specific suite
  // --layer <regression|capability|reliability>: Run all suites in a layer
  // --skill <name>: Run all suites for a skill
  // --ci: CI mode (GitHub Actions annotations, exit code on regression failure)
  break;

case 'eval-capture':
  // Capture a workflow trace as an eval dataset entry
  // --workflow <featureId>: Capture from completed workflow
  // --output <path>: Write to dataset file
  break;

case 'eval-compare':
  // Compare two eval runs
  // --baseline <runId>: Baseline run
  // --candidate <runId>: Candidate run
  break;
```

### 8. CI Pipeline

GitHub Actions workflow triggered on content layer changes:

```yaml
# .github/workflows/eval-gate.yml
name: Eval Gate
on:
  pull_request:
    paths:
      - 'skills/**'
      - 'commands/**'
      - 'rules/**'
      - 'shared/prompts/**'
      - 'plugins/exarchos/servers/exarchos-mcp/src/**'

jobs:
  regression-evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
        working-directory: plugins/exarchos/servers/exarchos-mcp
      - run: node dist/cli.js eval-run --layer regression --ci
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      # Regression failures block merge

  capability-evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
        working-directory: plugins/exarchos/servers/exarchos-mcp
      - run: node dist/cli.js eval-run --layer capability --ci
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      # Capability results are advisory (annotations, not blocking)
```

### 9. Trace Capture Hook

A `PostToolUse` hook captures workflow traces for dataset construction:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__exarchos__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" trace-capture",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The capture script appends tool call metadata (tool name, action, input summary, output summary, timestamp) to a `.trace.jsonl` file alongside the workflow state. After workflow completion, `eval-capture` converts the trace into an eval dataset entry.

### 10. LLM Judge Configuration

The default LLM judge uses Claude Sonnet for cost efficiency, with Claude Opus available for cross-validation:

```typescript
interface JudgeConfig {
  readonly defaultModel: string;       // claude-sonnet-4-5-20250929
  readonly crossValidationModel: string; // claude-opus-4-6
  readonly temperature: number;         // 0.0 for deterministic grading
  readonly maxTokens: number;           // 1024 for grading responses
  readonly cacheEnabled: boolean;       // true — cache identical inputs
}
```

**Judge calibration** (from Anthropic guidance): Use human-graded gold standard to measure TPR (true positive rate) and TNR (true negative rate). Split into train (20%, few-shot examples in rubric), validation (40%, tune rubric), test (40%, final report card).

**Rubric design principles** (from both OpenAI and Anthropic):
- Binary pass/fail preferred over Likert scales (clearer signal)
- Encourage reasoning before verdict (ask judge to think first, discard reasoning)
- Isolated judges per dimension (not one judge scoring everything)
- Empirical rubrics with specific criteria, not vague qualitative descriptions

---

## Integration Points

### With Progressive Disclosure & Hooks

| Component | Integration |
|---|---|
| Tool Registry | Eval suites reference registry for valid tool/action mappings; reliability evals validate against registry phase constraints |
| CLI entry point | Gains `eval-run`, `eval-capture`, `eval-compare` commands |
| Hook architecture | `PostToolUse` hook captures traces; `PreCompact` checkpoint includes eval state |
| `SubagentStart` hook | Reliability evals verify correct context injection |
| Composite tools | `exarchos_view` gains `eval_results` action |

### With Skills Content Modernization

| Component | Integration |
|---|---|
| YAML frontmatter | `metadata.phase-affinity` determines which eval layer applies; frontmatter validation becomes a regression eval |
| Split skills | Each skill's `evals/` directory co-locates with `references/` |
| Generated tool manifests | Regression evals verify generated manifests match registry |
| Validation scripts | Quality gate scripts become code-based graders |

### With Basileus Backend (Future)

| Component | Integration |
|---|---|
| Marten Event Store | `eval.*` events sync to Marten via Exarchos outbox (dual mode) |
| CQRS Projections | Remote `EvalResultsView` aggregates across Exarchos instances |
| Agentic Coder | Remote coding agent evals share the same grader interfaces |

---

## Testing Strategy

### Unit Tests

- **Grader tests** — Each grader type produces correct scores for known inputs (pass, fail, partial credit)
- **Dataset loader** — JSONL parsing, validation, schema enforcement
- **Event emission** — Eval events match schema and appear in event stream
- **View materialization** — `EvalResultsView` correctly projects from event sequences
- **CLI command tests** — Each CLI command produces correct output for given inputs
- **Suite discovery** — Harness finds all `evals/suite.yaml` files in skill directories

### Integration Tests

- **End-to-end eval run** — Load a suite, execute cases, grade, emit events, materialize view
- **Regression detection** — Run baseline, introduce regression, verify detection
- **CI mode** — Verify GitHub Actions annotation output format
- **Trace capture → dataset** — Capture a workflow trace via hook, convert to eval case, run through grader
- **LLM judge consistency** — Same input graded multiple times produces consistent scores (temperature 0)

### Smoke Tests

- **Promptfoo assertion library** — Verify `llm-rubric`, `contains-all`, `is-json`, `javascript` assertion types work with the harness
- **Cross-model validation** — Same eval case graded by Claude Sonnet and Claude Opus produces concordant results

---

## Implementation Phases

### Phase 1: Foundation (No Dependencies)

1. Create `evals/` module structure in MCP server package
2. Implement core interfaces (`IGrader`, `EvalCase`, `EvalResult`, `EvalSuite`)
3. Implement code-based graders (exact match, schema validation, tool call verification)
4. Implement JSONL dataset loader with validation
5. Implement CLI reporter (terminal output)
6. Add `eval-run` CLI command
7. Create initial regression dataset for 2-3 skills from manually captured traces
8. Unit tests for all grader types

### Phase 2: LLM Grading + Events (After Phase 1)

9. Integrate Promptfoo assertion library (`npm install promptfoo`)
10. Implement LLM-as-judge graders with configurable model
11. Implement `eval.*` event schema and event emission
12. Implement `EvalResultsView` CQRS projection
13. Add `eval_results` action to `exarchos_view` composite tool
14. Create capability eval suites for delegation and quality-review skills
15. Judge calibration: human-grade 20 cases, measure TPR/TNR

### Phase 3: CI + Trace Capture (After Phase 2)

16. Implement CI reporter (GitHub Actions annotations)
17. Create `.github/workflows/eval-gate.yml`
18. Implement `PostToolUse` trace capture hook
19. Implement `eval-capture` CLI command (trace → dataset conversion)
20. Implement `eval-compare` CLI command
21. Create reliability eval suites (stall detection, phase compliance)
22. Expand regression datasets from captured traces

### Phase 4: Flywheel (Ongoing)

23. Analyze eval failures (open coding → axial coding methodology)
24. Expand capability evals for remaining skills
25. Synthetic dataset generation for edge cases
26. Cross-model judge validation
27. Eval-driven prompt refinement cycle (measure → change → re-measure)

---

## Open Questions

1. **Promptfoo as library vs. CLI** — Can Promptfoo's assertion evaluation engine be used as a programmatic library (`import { evaluate } from 'promptfoo'`), or must it run via CLI? The harness design assumes library usage. If CLI-only, the harness would shell out to `promptfoo eval` and parse output. **Action:** Verify Promptfoo's programmatic API surface.

2. **Trace granularity** — How much of each tool call should the `PostToolUse` hook capture? Full input/output risks large traces; summaries risk losing signal. **Recommendation:** Capture full tool name + action + input keys + output status + duration. Full input/output only when `EVAL_TRACE_VERBOSE=true`.

3. **LLM judge cost budget** — Capability evals with LLM rubrics consume API tokens. A suite of 50 cases with 3 LLM-graded assertions each at ~1K tokens/grading = ~150K tokens per run. At Claude Sonnet pricing (~$3/1M input, $15/1M output), that's ~$2-3 per full eval run. **Recommendation:** Acceptable for CI; cache aggressively for local runs.

4. **Eval dataset versioning** — Should datasets be versioned alongside the skills (git), or managed separately? **Recommendation:** Git-tracked in the skill's `evals/datasets/` directory. Tag dataset versions with the skill version from YAML frontmatter.

5. **Multi-turn trace evaluation** — The harness needs to replay traces through the MCP server to evaluate multi-turn behavior. Should this be a full replay (actually calling the MCP server) or a mock replay (evaluating the recorded trace against graders without re-execution)? **Recommendation:** Mock replay for regression/capability evals (deterministic, fast). Full replay only for reliability evals that test actual tool execution paths.

6. **Eval result retention** — How long should eval events be retained in the event stream? **Recommendation:** Same retention as workflow events. Snapshot every 50 eval events to keep the stream manageable.
