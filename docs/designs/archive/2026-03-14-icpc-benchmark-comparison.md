# Design: ICPC 2025 World Finals Benchmark Comparison

## Problem Statement

Exarchos claims to improve agent-driven software development through event-sourced governance, workflow coordination, and structured SDLC phases. But we have no objective, reproducible evidence comparing Exarchos-governed execution against vanilla Claude Code plan mode on a standardized problem set. Without this, the value proposition is anecdotal.

The 2025 ICPC World Finals problem set (10 problems, A-J) provides an ideal benchmark: problems have unambiguous correctness criteria, solutions must compile and produce exact output, and the difficulty spectrum ranges from approachable to extremely hard. This lets us measure not just "did it work" but "how efficiently did it get there."

## Chosen Approach

**Hybrid: Standalone Runner with Eval-Compatible Output (Approach C).** A `benchmarks/icpc-2025/` directory containing problem definitions, a TypeScript runner that executes Claude Code under three configurations, compiles and tests solutions, collects metrics, and produces a publishable comparison report. Output format is compatible with the existing `EvalResult` schema for future integration with the eval framework.

**Rationale:** The primary deliverable is an external-facing credibility artifact. Coupling to the eval framework (currently stale per issue #1000) would block shipping. The hybrid approach delivers the comparison now and preserves optionality for eval integration later.

## Requirements

### DR-1: Problem Corpus

A machine-readable representation of all 10 ICPC 2025 World Finals problems (A-J) with structured metadata.

Each problem definition includes: problem ID (letter), title, time limit, problem statement (markdown), sample inputs, sample outputs, and difficulty classification.

**Acceptance criteria:**
- All 10 problems (A-J) have a definition file in `benchmarks/icpc-2025/problems/`
- Each definition includes at minimum: problem statement, all sample inputs from the PDF, corresponding expected outputs
- Problem metadata (time limit, problem type tags) is machine-parseable
- Given a problem ID, the runner can locate all inputs and expected outputs without human intervention

### DR-2: Three-Arm Execution Model

Solutions are generated under three distinct configurations ("arms") that represent different levels of workflow governance:

1. **Exarchos** — Full Exarchos-governed workflow: `/exarchos:ideate` through `/exarchos:delegate` with TDD, code review, and quality gates
2. **Vanilla Plan Mode** — Claude Code `/plan` mode with no Exarchos tools, no workflow governance, just the model reasoning about the problem and writing a solution
3. **HN-Manual** — A structured but ungoverned process mimicking what a developer following common HN/competitive-programming advice would do: read problem, identify algorithm class, write solution, test against samples, iterate on failures

Each arm receives identical problem input and produces a solution file in a consistent language.

**Acceptance criteria:**
- Given a problem and an arm identifier, the runner spawns an isolated Claude Code session with the correct configuration
- The Exarchos arm has full MCP tool access and follows the standard workflow
- The Vanilla arm has no Exarchos MCP tools and uses only `/plan` mode
- The HN-Manual arm follows a defined prompt template that structures the manual process (algorithm identification, pseudocode, implementation, sample testing)
- All three arms use the same model (Claude Opus) and the same language for solutions
- Arms are executed in isolation — no cross-contamination of context between arms

### DR-3: Solution Execution and Correctness Verification

Generated solutions are compiled, executed against test inputs, and verified for correctness by comparing actual output to expected output.

**Acceptance criteria:**
- Given a solution file and problem ID, the runner compiles the solution (language-appropriate: `g++` for C++, `python3` for Python, etc.)
- The compiled solution is executed with each sample input, subject to the problem's time limit (with a configurable multiplier for overhead)
- Output is compared against expected output with whitespace normalization
- Results are recorded as: `pass` (correct output), `fail` (wrong output), `tle` (time limit exceeded), `rte` (runtime error), `ce` (compilation error)
- Given a solution that produces output `1 3 2 7 5 6 4` for Problem A Sample 1, and the expected output is `1 3 2 7 5 6 4`, the verdict is `pass`
- Given a solution that fails to compile, the verdict is `ce` and the compilation error is captured

### DR-4: Metric Collection

Each run collects quantitative metrics across multiple dimensions for cross-arm comparison.

**Metrics captured per problem per arm:**
- **Correctness**: pass/fail per sample case, overall verdict
- **Token economy**: total input tokens, total output tokens, total tokens (via Claude API usage tracking or estimation)
- **Wall-clock time**: seconds from session start to solution file written
- **Iteration count**: number of edit-compile-test cycles before final submission
- **Solution characteristics**: lines of code, language used, algorithm approach (tagged manually or via LLM classification)

**Acceptance criteria:**
- All metrics listed above are captured for every problem-arm combination
- Token counts are derived from actual API usage (not estimated) where possible
- Wall-clock time excludes compilation/testing overhead (measures only generation time)
- Metrics are written to a structured JSON results file (`benchmarks/icpc-2025/results/<run-id>.json`)
- Results include a `runMeta` block with: timestamp, model version, commit hash, arm configuration

### DR-5: Comparison Report Generation

A report generator produces a publishable comparison document from collected results.

**Acceptance criteria:**
- Given a results JSON file, the generator produces a markdown report
- The report includes:
  - Summary table: problem x arm matrix with pass/fail and key metrics
  - Per-problem detail sections with solution approach notes
  - Aggregate statistics: total problems solved, mean token usage, mean time
  - Methodology section describing the three arms and execution environment
- The report is suitable for inclusion in a README, blog post, or HN discussion
- Visualization-ready data (the JSON structure supports rendering charts externally)

### DR-6: Eval-Compatible Output Format

Results are structured to be importable into the existing eval framework's `EvalResult` schema, enabling future integration without rewriting the benchmark.

**Acceptance criteria:**
- Each problem-arm result maps to an `EvalResult`-compatible structure with: `id`, `passed`, `score`, `metadata`, `duration`
- A thin adapter script (`benchmarks/icpc-2025/eval-adapter.ts`) can convert results JSON to JSONL importable by `eval-run`
- The adapter is not required for the primary benchmark workflow — it's an optional integration path

### DR-7: HN-Manual Workflow Definition

A structured prompt template that defines the "HN-Manual" arm as a reproducible process, based on common competitive programming workflows discussed in developer communities.

**Acceptance criteria:**
- The workflow is defined as a prompt template in `benchmarks/icpc-2025/arms/hn-manual.md`
- The template includes explicit phases: (1) read and understand the problem, (2) identify algorithm class and complexity target, (3) write pseudocode, (4) implement solution, (5) test against samples, (6) debug failures
- The template does NOT use any Exarchos tools or structured workflow management
- The template is self-contained — a developer could follow it manually
- Given two independent runs with the same problem and template, the process structure is consistent (even if solutions differ)

### DR-8: Error Handling and Edge Cases

The benchmark must handle failures gracefully across all arms and problems.

**Acceptance criteria:**
- Given a problem where an arm produces no solution file (context exhaustion, model refusal, infinite loop), the result is recorded as `no_solution` with the failure reason captured
- Given a solution that passes some sample cases but fails others, partial results are recorded (not just overall pass/fail)
- Given a compilation failure, the error output is captured for post-hoc analysis
- The runner supports resuming a partial benchmark run (e.g., if 6/10 problems completed before interruption, re-running skips completed problems)
- Time limits are enforced with hard kill — a runaway process cannot block the benchmark
- All arms are sandboxed: a solution cannot modify the benchmark infrastructure or other solutions

## Technical Design

### Directory Structure

```
benchmarks/icpc-2025/
├── README.md                     # Methodology, how to run, how to interpret
├── problems/
│   ├── A-skew-ed-reasoning/
│   │   ├── problem.md            # Problem statement
│   │   ├── meta.json             # { title, timeLimit, tags }
│   │   └── samples/
│   │       ├── 1.in / 1.out
│   │       ├── 2.in / 2.out
│   │       └── 3.in / 3.out
│   ├── B-blackboard-game/
│   │   └── ...
│   └── ... (A through J)
├── arms/
│   ├── exarchos.md               # Arm config: full Exarchos workflow
│   ├── vanilla-plan.md           # Arm config: /plan mode only
│   └── hn-manual.md              # Arm config: structured manual process
├── runner/
│   ├── index.ts                  # CLI entry point
│   ├── executor.ts               # Spawns Claude Code sessions per arm
│   ├── compiler.ts               # Compile + run solutions
│   ├── verifier.ts               # Compare output to expected
│   ├── metrics.ts                # Token/time/iteration collection
│   ├── reporter.ts               # Markdown report generation
│   └── types.ts                  # Shared types
├── eval-adapter.ts               # Optional: results → EvalResult JSONL
├── results/
│   └── <run-id>.json             # Per-run results
└── reports/
    └── <run-id>.md               # Generated comparison reports
```

### Runner Execution Flow

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Load problem │────▶│ For each arm │────▶│ Spawn Claude │
│ corpus       │     │ config       │     │ Code session │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                                 ▼
                                      ┌──────────────────┐
                                      │ Collect solution  │
                                      │ + token metrics   │
                                      └────────┬─────────┘
                                               │
                                               ▼
                                      ┌──────────────────┐
                                      │ Compile + execute │
                                      │ against samples   │
                                      └────────┬─────────┘
                                               │
                                               ▼
                                      ┌──────────────────┐
                                      │ Record verdict +  │
                                      │ metrics to JSON   │
                                      └────────┬─────────┘
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                    ┌──────────────────┐              ┌──────────────────┐
                    │ Next problem/arm │              │ Generate report  │
                    │ (resume-safe)    │              │ (after all done) │
                    └──────────────────┘              └──────────────────┘
```

### Session Spawning

Each arm runs as an isolated Claude Code subprocess. The runner uses the Claude Code CLI (`claude`) with configuration flags:

- **Exarchos arm**: `claude --profile exarchos` (or default with MCP servers enabled) — full tool access
- **Vanilla arm**: `claude --profile vanilla` (MCP servers disabled, plan mode prompt) — or use `CLAUDE_MCP_SERVERS='{}'` to strip MCP
- **HN-Manual arm**: `claude --profile hn-manual` (MCP servers disabled, custom system prompt from `arms/hn-manual.md`)

The prompt for each session follows a consistent template:

```
Solve the following competitive programming problem. Write a complete,
compilable solution in [LANGUAGE]. Output only the solution code.

[PROBLEM STATEMENT]

Sample Input 1:
[INPUT]

Sample Output 1:
[OUTPUT]

[... more samples ...]
```

The Exarchos arm may use a richer prompt that invokes the full workflow, while vanilla and HN-manual arms get the direct problem statement.

### Token Tracking

Token usage is captured via Claude Code's built-in session metrics. After each session completes, the runner extracts:

- Total input tokens (prompt + context)
- Total output tokens (completions)
- Total cost (if available)

If programmatic access to token counts is unavailable, fall back to estimating from response byte lengths using the existing `bytes / 4` heuristic from the telemetry framework.

### Results Schema

```typescript
interface BenchmarkRun {
  runId: string;                    // UUID
  timestamp: string;                // ISO 8601
  model: string;                    // e.g., "claude-opus-4-6"
  commit: string;                   // git rev-parse HEAD
  language: string;                 // Solution language used
  arms: ArmConfig[];
  problems: ProblemResult[];
}

interface ProblemResult {
  problemId: string;                // "A", "B", ..., "J"
  title: string;
  arms: ArmResult[];
}

interface ArmResult {
  arm: "exarchos" | "vanilla-plan" | "hn-manual";
  verdict: "pass" | "fail" | "partial" | "tle" | "rte" | "ce" | "no_solution";
  sampleResults: SampleResult[];
  metrics: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    wallClockSeconds: number;
    iterationCount: number;
    linesOfCode: number;
  };
  solution?: string;                // Path to solution file
  notes?: string;                   // Algorithm approach, failure reason, etc.
}

interface SampleResult {
  sampleId: number;
  verdict: "pass" | "fail" | "tle" | "rte";
  actualOutput?: string;
  expectedOutput: string;
}
```

### Report Format

The generated markdown report follows this structure:

```markdown
# ICPC 2025 World Finals: Agent Workflow Comparison

## Methodology
[Three arms described, execution environment, model version]

## Summary

| Problem | Exarchos | Vanilla Plan | HN-Manual |
|---------|----------|-------------|-----------|
| A: A-Skew-ed Reasoning | PASS (1,200 tok) | PASS (2,400 tok) | FAIL |
| B: Blackboard Game | PASS (800 tok) | FAIL | PASS (1,600 tok) |
| ... | ... | ... | ... |
| **Total Solved** | **8/10** | **5/10** | **6/10** |

## Aggregate Metrics
[Token economy comparison, time comparison, iteration counts]

## Per-Problem Analysis
[Detailed breakdown for each problem]

## Conclusions
[Key findings, caveats, reproducibility notes]
```

## Integration Points

- **Existing `benchmarks/`**: The `baselines.json` file tracks MCP server performance benchmarks. The ICPC benchmark is a peer directory, not a child — it benchmarks workflow outcomes, not server performance.
- **Eval framework (future)**: `eval-adapter.ts` maps `ArmResult` to `EvalResult` for import into `eval-run`. This is a one-way bridge — the benchmark runs independently.
- **CI (future)**: A GitHub Actions workflow could run the benchmark on schedule (expensive — full 30-problem execution costs significant API tokens). More likely triggered manually.
- **Telemetry**: If the Exarchos arm runs with telemetry enabled, `_perf` data from tool calls provides additional granularity on where governance overhead is spent.

## Testing Strategy

**Unit tests (co-located):**
- `runner/verifier.test.ts` — Output comparison with whitespace normalization, partial pass handling
- `runner/compiler.test.ts` — Compilation and execution with timeout enforcement, error capture
- `runner/reporter.test.ts` — Report generation from fixture results
- `runner/metrics.test.ts` — Token estimation fallback, metric aggregation

**Integration tests:**
- End-to-end: run a single problem with a mock "arm" that returns a known solution, verify the full pipeline (compile, test, record, report)
- Resume behavior: interrupt after 3 problems, verify re-run skips completed

**No need to test:**
- The Claude Code sessions themselves (that's what the benchmark measures)
- The Exarchos workflow (tested by existing eval suites)

## Open Questions

1. **Language choice**: C++ is the ICPC standard and likely yields the most competitive solutions. Python is more readable for a blog post audience. **Recommendation:** C++ for all arms — it's what competitive programmers use and keeps the comparison fair on execution performance.

2. **Sample-only correctness**: We only have sample test cases from the PDF (2-3 per problem). A solution that passes samples may still be incorrect on edge cases. The report must include a prominent caveat about this. **Mitigation:** We can author additional test cases for simpler problems (A, B, H, J) where the problem structure makes edge cases predictable.

3. **Cost**: Running all 10 problems x 3 arms = 30 Claude Code sessions, likely 500K-1M+ tokens total. **Recommendation:** Budget this as a one-time marketing investment. Run once, publish results, re-run only on major Exarchos releases.

4. **Reproducibility**: LLM outputs are non-deterministic. The same run tomorrow may yield different results. **Mitigation:** Set temperature to 0 where possible. Run each arm 3 times and report best/median/worst. Document the exact model version and commit hash.

5. **HN-Manual workflow sources**: The "common manual process" needs to be defined concretely. **Recommendation:** Survey 3-5 HN threads about competitive programming with AI to extract the consensus process, then codify it as the arm template.

6. **Interactive Problem I (Slot Machine)**: This is an interactive problem requiring stdin/stdout dialogue with a judge. All three arms will likely struggle with this. **Recommendation:** Include it but expect `no_solution` across the board. Document why interactive problems are harder for all approaches.
