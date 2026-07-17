# Design: Pipeline Pruning & Tech Debt Audit

Combined design for GitHub issues #1010 and #1013.

## Problem Statement

Two related operational gaps in the Exarchos workflow system:

**Pipeline staleness (#1010):** The pipeline view accumulates workflows that are never completed or cancelled. Running `exarchos_view pipeline` returns 56+ workflows, many inactive for days or weeks. Root causes: (a) workflows are abandoned without cancelling, (b) cleanup isn't run after PR merges. There's no built-in way to bulk-clear stale workflows, and no lifecycle mechanism to prevent recurrence.

**Architectural debt invisibility (#1013):** Issue #1009 exposed a class of bug that no existing review tooling can detect — an event tools module silently created a separate EventStore instance without the SQLite backend, making events invisible across module boundaries. This was masked by silent `catch {}` fallbacks and tests that used the same instance for both sides. The existing quality-review and convergence gates evaluate individual features, not systemic cross-cutting architectural health. A dedicated `/tech-debt-audit` skill is needed to systematically identify these classes of debt.

## Chosen Approach

**#1010 — Approach B: Prune Action + Lifecycle Hardening.** A `prune` action on `exarchos_workflow` (MCP self-service) bulk-cancels stale workflows. Pipeline view enrichment adds staleness visibility and cleanup nudges. Thin `commands/prune.md` wrapper for Claude Code UX. Per #1007 platform-agnosticity principle: MCP server is self-sufficient, content layer is augmentative.

**#1013 — Approach C: Hybrid Layered Assessment.** Deterministic scripts (distributed via `scripts/`, MCP self-service via `run_script`) establish a reproducible baseline. Runbook entry encodes dimension taxonomy and execution model for any MCP client. Repo-local skill at `.claude/skills/tech-debt-audit/` (like feature-audit) provides Claude Code optimization. Each finding tagged with provenance (`automated` or `qualitative`).

---

## Requirements

### DR-1: Prune command

A new `/prune` command that composes existing MCP primitives to bulk-cancel stale workflows from the pipeline.

The command:
1. Calls `exarchos_view pipeline` (with `includeCompleted: true`) to list all workflows
2. Computes staleness from `lastEventTimestamp` (see DR-2) against a configurable threshold (default: 7 days)
3. Applies safeguards: never prunes workflows with open PRs on their branch, or workflows in `completed`/`cancelled` terminal states
4. Shows a dry-run preview table: featureId, phase, workflowType, daysSinceActivity, safeguard status
5. After user confirmation, calls `exarchos_workflow cancel` for each with `reason: "pruned-stale"`
6. Reports summary: count pruned, count skipped (safeguarded), count already terminal

**Acceptance criteria:**
- Given a pipeline with 10 workflows, 6 stale beyond threshold, 2 with open PRs, 2 active
  When the user runs `/prune`
  Then the dry-run preview shows 6 candidates, 2 with safeguard flags
  And after confirmation, 4 are cancelled (the 6 stale minus 2 safeguarded)
  And the 2 active and 2 safeguarded workflows remain untouched
- Given a pipeline with no stale workflows
  When the user runs `/prune`
  Then the output says "No stale workflows found" with no confirmation prompt
- Given a stale workflow with an open PR (detected via `gh pr list --head <branch>`)
  When the user runs `/prune`
  Then that workflow is listed with a safeguard flag and skipped during cancellation

### DR-2: Pipeline view staleness surfacing

Enhance the pipeline view projection to include temporal metadata, enabling staleness detection without requiring a separate data source.

Changes to `PipelineViewState`:
- Add `lastEventTimestamp: string` — ISO timestamp of the most recent event in the workflow's stream
- Add `startedAt: string` — ISO timestamp from `workflow.started` event

Changes to `pipelineProjection.apply`:
- Track `lastEventTimestamp` by updating it on every event (the projection already processes all events)
- Capture `startedAt` from `workflow.started` event data

Changes to `handleViewPipeline`:
- Compute `minutesSinceActivity` and `daysSinceActivity` from `lastEventTimestamp` at query time (not in the projection — keeps the projection deterministic)
- Add a `staleThresholdDays` parameter (default: 7) to the view action
- Annotate each workflow in the response with `isStale: boolean` when `daysSinceActivity > staleThresholdDays`

**Acceptance criteria:**
- Given a workflow with its last event 10 days ago and a threshold of 7 days
  When `exarchos_view pipeline` is called
  Then the workflow includes `lastEventTimestamp`, `minutesSinceActivity`, `daysSinceActivity`, and `isStale: true`
- Given a workflow with its last event 2 hours ago
  When `exarchos_view pipeline` is called
  Then `isStale` is `false` and `daysSinceActivity` is `0`
- The projection remains deterministic — `minutesSinceActivity` is computed at query time, not stored in the materialized view

### DR-3: Cleanup lifecycle nudge

After a workflow reaches the `synthesize` phase and a PR is merged, if cleanup isn't run within the same session, a warning surfaces on the next `pipeline` view.

Implementation:
- When the pipeline view detects a workflow in `synthesize` phase with `daysSinceActivity > 1`, annotate it with `nudge: "PR may be merged — run /cleanup to resolve this workflow"`
- This is advisory only — no auto-cancellation, no forced transitions
- The nudge disappears when cleanup or cancel is run

**Acceptance criteria:**
- Given a workflow in `synthesize` phase with last activity 2 days ago
  When `exarchos_view pipeline` is called
  Then the workflow includes a `nudge` field with cleanup guidance
- Given a workflow in `ideate` phase with last activity 2 days ago
  When `exarchos_view pipeline` is called
  Then no nudge is shown (nudge only applies to `synthesize` phase)

### DR-4: Tech debt audit skill structure

A new skill at `skills/tech-debt-audit/SKILL.md` following the Anthropic skill-building guide and existing Exarchos skill conventions.

Frontmatter:
```yaml
name: tech-debt-audit
description: >-
  Systematic architectural debt identification across the codebase using 7 dimensions.
  Use when user says 'tech debt audit', 'architecture review', 'debt scan', 'find tech debt',
  or runs /tech-debt-audit. Runs deterministic scripts first, then qualitative agent analysis.
  Do NOT use for feature-scoped review (use quality-review), debugging (use /debug),
  or refactoring (use /refactor).
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: standards
```

Skill body sections:
1. Overview — purpose, distinction from feature-scoped audit
2. Triggers and negative triggers
3. Dimension taxonomy summary (detail in references)
4. Execution model — two-pass hybrid
5. Output format — structured findings
6. State management — emit findings as events
7. Anti-patterns table

References directory (`skills/tech-debt-audit/references/`):
- `dimensions.md` — full taxonomy with all 7 dimensions, definitions, signals, severity model
- `deterministic-checks.md` — script inventory, what each checks, how to interpret results
- `report-template.md` — structured output template for findings
- `feature-audit-distinction.md` — clear boundary with quality-review/convergence gates

**Acceptance criteria:**
- Skill triggers on: "tech debt audit", "architecture review", "debt scan", "find tech debt", `/tech-debt-audit`
- Skill does NOT trigger on: "review this PR", "fix this bug", "refactor the module", "feature audit"
- Frontmatter includes `mcp-server: exarchos`
- SKILL.md body is under 5,000 words
- References directory contains all 4 files listed above
- Description is under 1,024 characters

### DR-5: Dimension taxonomy

Seven dimensions for systematic architectural debt identification, grounded in industry frameworks (Fowler's Quadrant, SQALE, ISO 25010, SOLID, Ousterhout's complexity model, event sourcing literature).

| ID | Dimension | What it catches | Theoretical basis |
|----|-----------|----------------|-------------------|
| TD1 | Dependency Wiring Integrity | Hidden ambient state, manual wiring, lazy fallbacks | DIP (SOLID), Clean Architecture, Ousterhout's information leakage |
| TD2 | Instance Identity & Shared State | Components that should share an instance but don't | Singleton problems, ISO 25010 Reliability |
| TD3 | Error Observability & Failure Propagation | Silent catches, swallowed results, best-effort fallbacks | Ousterhout's exception handling, ISO 25010 Analysability |
| TD4 | Schema & Contract Drift | Fields removed from schema but still read, type assertion bypasses | Event sourcing schema evolution, contract testing |
| TD5 | Test Fidelity & Production Parity | Tests that don't exercise production wiring paths | Google SWE Book Ch.13, SQALE testability hierarchy, Vitest mocking pitfall |
| TD6 | Dead Code & Vestigial Patterns | Evolutionary leftovers, unreachable code, unused exports | Dead code detection, noUnusedLocals |
| TD7 | Complexity & Module Depth | Shallow modules, pass-through methods, god modules | Ousterhout deep/shallow modules, SQALE changeability |

Audit order follows SQALE's hierarchical dependency: TD5 (testability) first, then TD3 (observability), then TD1/TD2 (wiring), then TD4 (schemas), then TD6/TD7 (structural).

Severity model per finding:
- **CRITICAL**: Can cause silent data loss, invisible state corruption, or undetectable production failures
- **HIGH**: Creates significant maintenance burden or masks failure modes
- **MEDIUM**: Increases cognitive load or creates unnecessary risk
- **LOW**: Cosmetic or minor optimization opportunity

Each finding also classifies by Fowler Quadrant (deliberate/inadvertent x reckless/prudent) to inform remediation tone — prudent/inadvertent debt (the most common in mature codebases) emphasizes learning, not blame.

**Acceptance criteria:**
- All 7 dimensions are documented in `references/dimensions.md` with: definition, invariant statement, detectable signals, example grep/analysis patterns, severity model with concrete examples
- Audit execution order is explicitly specified and follows SQALE hierarchy
- Each dimension has at least 3 detectable signals
- Severity model is consistent across all dimensions (same 4 levels, same criteria)

### DR-6: Deterministic check scripts

Bash scripts for automatable dimensions, following existing script conventions (`set -euo pipefail`, exit codes 0/1/2, Markdown output, co-located `.test.sh`).

Scripts to create:

| Script | Dimensions | What it checks |
|--------|-----------|---------------|
| `check-td1-wiring.sh` | TD1 | Module-global `let` + `configure*()` patterns, fallback instantiation outside composition root, import depth violations |
| `check-td3-error-observability.sh` | TD3 | Empty catch blocks, silent `catch {}` with only comments, `.catch(() => {})` promise swallowing, fire-and-forget without logging |
| `check-td4-schema-drift.sh` | TD4 | `as` type assertions bypassing Zod, `z.any()` usage, `.passthrough()` schemas |
| `check-td6-dead-code.sh` | TD6 | TODO/FIXME/HACK archaeology, orphan files (via import analysis), unused exports |
| `check-td7-complexity.sh` | TD7 | Files over 500 lines, functions with >5 parameters, deeply nested conditionals |

Dimensions TD2 and TD5 are primarily qualitative (require runtime/graph analysis) and are handled by the agent pass.

Each script:
- Accepts `--path <dir>` to scope the scan (default: `servers/exarchos-mcp/src/`)
- Accepts `--format json|markdown` (default: markdown)
- Outputs structured findings with file path, line number, pattern matched, severity
- Exits 0 if no findings, 1 if findings exist, 2 for usage errors
- Has a co-located `.test.sh` with fixture-based tests

**Acceptance criteria:**
- 5 scripts created, each following existing script conventions (header, `set -euo pipefail`, argument parsing, exit codes)
- Each script has a co-located `.test.sh`
- `--format json` output is parseable by `jq`
- Scripts are invocable via `exarchos_orchestrate({ action: "run_script" })`
- Running all 5 scripts on the current Exarchos codebase produces at least 1 finding per script (validates they detect real patterns)

### DR-7: Hybrid execution model

Two-pass execution with provenance tagging:

**Pass 1 — Deterministic (scripts):**
1. Run all `check-td*.sh` scripts via `exarchos_orchestrate({ action: "run_script" })`
2. Collect structured findings (JSON format)
3. Each finding tagged `provenance: "automated"`

**Pass 2 — Qualitative (agent):**
1. Agent reviews Pass 1 findings for context and false positives
2. Agent reads flagged code regions for dimensions that resist automation (TD2, TD5)
3. Agent adds judgment-based findings the scripts can't detect
4. Each agent finding tagged `provenance: "qualitative"`

**Synthesis:**
1. Merge Pass 1 and Pass 2 findings, deduplicate by file:line
2. Sort by SQALE dimension order, then severity
3. Generate report using `references/report-template.md`
4. Emit `tech-debt.audit-completed` event with summary metrics

**Acceptance criteria:**
- Pass 1 runs all deterministic scripts and collects findings
- Pass 2 reviews Pass 1 results and adds qualitative findings for TD2 and TD5
- Every finding in the final report has a `provenance` tag (`automated` or `qualitative`)
- Findings are grouped by dimension, sorted by severity within each group
- The audit emits a summary event to the workflow event store

### DR-8: Audit output format

Structured report with actionable findings, suitable for both human review and programmatic consumption.

Finding schema:
```typescript
interface TechDebtFinding {
  id: string;                    // e.g., "TD1-001"
  dimension: string;             // e.g., "TD1: Dependency Wiring Integrity"
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  provenance: 'automated' | 'qualitative';
  file: string;                  // relative path
  line?: number;                 // line number if applicable
  pattern: string;               // what was detected
  evidence: string;              // code snippet or grep match
  rootCause: string;             // why this is debt
  suggestedFix: string;          // how to remediate
  estimatedEffort: string;       // e.g., "30min", "2h", "1d"
  fowlerQuadrant?: string;       // e.g., "prudent/inadvertent"
}
```

Report sections:
1. Executive summary — total findings by severity, top 3 highest-risk areas
2. Dimension summaries — per-dimension counts with trend indicator (if prior audit exists)
3. Detailed findings — grouped by dimension, sorted by severity
4. Remediation roadmap — suggested ordering based on SQALE hierarchy
5. Appendix — raw script output for reproducibility

**Acceptance criteria:**
- Report template exists at `skills/tech-debt-audit/references/report-template.md`
- Finding schema is documented and used consistently
- Every finding has all required fields (id, dimension, severity, provenance, file, pattern, evidence, rootCause, suggestedFix)
- Executive summary is generated from finding data, not manually written
- Report is renderable as Markdown

### DR-9: Error handling and edge cases

**Acceptance criteria:**
- Given a script that fails with exit code 2 (usage error)
  When the audit runs
  Then the script failure is reported in the output but does not abort the entire audit
  And remaining scripts continue to execute
- Given a codebase with no findings for a dimension
  When the audit completes
  Then that dimension shows "No findings" rather than being omitted
- Given a script path that doesn't exist (not yet installed)
  When the audit attempts to run it
  Then a clear error message is shown: "Script not found — run installer to sync scripts"
- Given the audit is run on a non-TypeScript directory
  When scripts search for patterns
  Then they gracefully produce empty results rather than erroring
- Given a very large codebase (>10,000 files)
  When deterministic scripts run
  Then they complete within 60 seconds (no unbounded recursion or full-file reads)

---

## Technical Design

### Pipeline View Changes (DR-2)

```typescript
// pipeline-view.ts — additions to PipelineViewState
export interface PipelineViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  stackPositions: StackPosition[];
  hasMore: boolean;
  // New fields:
  startedAt: string;           // from workflow.started event timestamp
  lastEventTimestamp: string;  // updated on every event
}

// pipeline-view.ts — projection changes
export const pipelineProjection: ViewProjection<PipelineViewState> = {
  init: () => ({
    // ... existing fields ...
    startedAt: '',
    lastEventTimestamp: '',
  }),
  apply: (view, event) => {
    // Track lastEventTimestamp on EVERY event (before the switch)
    const updated = { ...view, lastEventTimestamp: event.timestamp ?? view.lastEventTimestamp };

    switch (event.type) {
      case 'workflow.started': {
        // ... existing logic ...
        return { ...result, startedAt: event.timestamp ?? '' };
      }
      // ... rest unchanged, but operating on `updated` ...
    }
  },
};

// tools.ts — handleViewPipeline enrichment
// After materialization, compute temporal fields at query time:
const now = Date.now();
const enriched = workflows.map(w => {
  const lastMs = new Date(w.lastEventTimestamp).getTime();
  const minutesSinceActivity = Math.floor((now - lastMs) / 60000);
  const daysSinceActivity = Math.floor(minutesSinceActivity / 1440);
  return {
    ...w,
    minutesSinceActivity,
    daysSinceActivity,
    isStale: daysSinceActivity > (args.staleThresholdDays ?? 7),
    nudge: w.phase === 'synthesize' && daysSinceActivity > 1
      ? 'PR may be merged — run /cleanup to resolve this workflow'
      : undefined,
  };
});
```

### Prune Command (DR-1)

New file: `commands/prune.md`

The command instructs the agent to:
1. Call `exarchos_view pipeline { includeCompleted: true }` to get all workflows with staleness metadata
2. Filter to `isStale: true` workflows not in terminal states
3. For each candidate, check for open PRs via `gh pr list --head <branch> --state open --json number`
4. Present a dry-run table
5. After confirmation, loop `exarchos_workflow cancel` for each approved candidate

Also needs a new skill registration in `skills/` with `SKILL.md` (following existing command → skill pattern seen in cleanup), or can remain as a pure command if it's simple enough. Given the prune logic is straightforward composition, a command alone suffices.

### Tech Debt Audit Skill (DR-4 through DR-8)

Directory structure:
```
skills/tech-debt-audit/
  SKILL.md                              # Main skill (< 5,000 words)
  SKILL.md.test.sh                      # Structural tests
  references/
    dimensions.md                        # Full TD1-TD7 taxonomy
    deterministic-checks.md              # Script inventory and interpretation
    report-template.md                   # Output template
    feature-audit-distinction.md         # Boundary with quality-review

scripts/
  check-td1-wiring.sh                   # + .test.sh
  check-td3-error-observability.sh       # + .test.sh
  check-td4-schema-drift.sh             # + .test.sh
  check-td6-dead-code.sh                # + .test.sh
  check-td7-complexity.sh               # + .test.sh
```

### Dimension Detection Patterns (key examples)

**TD1 — Dependency Wiring Integrity:**
```bash
# Module-global mutable state with lazy init
grep -rn 'let module\w*\(Store\|Materializer\|Backend\).*= null' "$TARGET_DIR"
# Fallback instantiation outside composition root
grep -rn 'new EventStore\|new SnapshotStore\|new SqliteBackend' "$TARGET_DIR" | grep -v '\.test\.' | grep -v 'context\.ts\|index\.ts'
# configure* surface area count
grep -c 'export function configure' "$TARGET_DIR"/**/*.ts
```

**TD3 — Error Observability:**
```bash
# Empty catch blocks (various forms)
grep -Prn 'catch\s*\([^)]*\)\s*\{\s*\}' "$TARGET_DIR" --include='*.ts' | grep -v '\.test\.'
# fire-and-forget without logging
grep -rn 'fire-and-forget\|best.effort\|graceful.degradation' "$TARGET_DIR" --include='*.ts' | grep -v '\.test\.'
# Promise swallowing
grep -rn '\.catch\(\(\)\s*=>\s*\{\s*\}\)' "$TARGET_DIR" --include='*.ts' | grep -v '\.test\.'
```

**TD5 — Test Fidelity (qualitative checklist for agent):**
- Do tests create their own EventStore instances? (grep `new EventStore(` in test files)
- Do tests use `configure*()` but never test the `getOrCreate*()` fallback path?
- Are there integration tests that exercise the full composition root?
- Do any `vi.mock` calls mock the exact module whose behavior is under test?

---

## Integration Points

1. **Pipeline view** — `servers/exarchos-mcp/src/views/pipeline-view.ts` (projection changes), `servers/exarchos-mcp/src/views/tools.ts` (query-time enrichment)
2. **Prune command** — `commands/prune.md` (new), composes `exarchos_view pipeline` + `exarchos_workflow cancel`
3. **Tech debt audit skill** — `skills/tech-debt-audit/SKILL.md` (new), references directory
4. **Deterministic scripts** — `scripts/check-td*.sh` (new), invoked via `exarchos_orchestrate run_script`
5. **Event emission** — `tech-debt.audit-completed` event type (needs registration in event schema)
6. **Installer** — New skill and scripts must be registered for symlink installation

---

## Testing Strategy

### Pipeline View (DR-2, DR-3)

- Unit tests for `pipelineProjection` — verify `lastEventTimestamp` updates on every event, `startedAt` captured from `workflow.started`
- Unit tests for query-time enrichment — verify `minutesSinceActivity`, `daysSinceActivity`, `isStale` computation
- Unit tests for nudge logic — only appears for `synthesize` phase workflows with `daysSinceActivity > 1`
- Existing pipeline view tests updated to include new fields

### Prune Command (DR-1)

- Integration test: create multiple workflows at various staleness levels, run prune flow, verify correct ones cancelled
- Safeguard test: mock `gh pr list` to return open PRs, verify safeguarded workflows are skipped

### Deterministic Scripts (DR-6)

- Each script has co-located `.test.sh` with fixture directories containing known patterns
- Fixtures include both positive (should detect) and negative (should not detect) cases
- Test both `--format markdown` and `--format json` output

### Tech Debt Audit Skill (DR-4, DR-7)

- `SKILL.md.test.sh` for structural validation (frontmatter, sections, references)
- Integration test: run the full two-pass audit on a fixture codebase, verify findings from both passes appear with correct provenance tags

---

## Open Questions

1. **Event type registration for `tech-debt.audit-completed`**: Should this be a new top-level event type in the schema registry, or a generic `skill.completed` event with audit-specific data? Leaning toward dedicated type for queryability.

2. **Trend analysis**: The design mentions trend indicators ("if prior audit exists"). Should we store audit results in the event store as individual `tech-debt.finding` events (enabling per-finding trend tracking), or as a single summary event? Individual events are more powerful but potentially high volume.

3. **Prune threshold configurability**: The command uses a 7-day default. Should this be configurable via environment variable (like `STALE_AFTER_MINUTES` in checkpoint.ts) or only via command argument? Leaning toward command argument only to keep it simple.

4. **Script scope**: Should deterministic scripts scan only `servers/exarchos-mcp/src/` (the MCP server) or the entire repo? The MCP server is where the architectural debt lives, but root `src/` has the installer. Leaning toward MCP server only as default with `--path` override.
