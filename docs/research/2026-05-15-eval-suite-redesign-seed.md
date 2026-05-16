# Eval-Suite Redesign — Context Seed for Next Ideation Pass

**Status:** Pre-ideate seed. Captures the framing decided during preview.3 plan-review on 2026-05-15. Inputs for a future `/exarchos:ideate` workflow on the eval-suite redesign.
**Author:** rsalus + Claude (preview.3 plan-review session)
**Supersedes:** the original #1365 step-1+2 design (versioned datasets + HTML dashboard) — pulled from preview.3 because it builds on an architecture we now intend to replace.

---

## TL;DR

The eval suite needs a fundamental redesign, not just elevation. Our `{{TOKEN}}` placeholder system in `skills-src/` encodes **harness mechanics** (tool names, command verbs, hook surfaces), not behavioral intent. Today's runtime-agnostic JSONL trace-replay tier conflates two distinct concerns — *did the agent pick the right behavior?* and *did the harness substitution produce a runnable form?* — and as a result tests neither cleanly. Six of 17 skills are covered (the `skills-src/` tree has 19 entries: 17 actual skill directories plus `_shared` (cross-skill helpers) and `SKILL_AUTHORING.md` (an authoring doc), both excluded from the skill count); the missing 11 include every operator-facing surface that ships PRs.

Reshape into **two distinct suites**:

- **Tier A — Harness-surface tests** (objective, runtime-specific, no LLM): schema-validate each rendered `skills/<runtime>/<skill>/SKILL.md` against a versioned harness manifest (tools, commands, hooks, paths). Deterministic. Fast. Catches rendering drift across all 6 runtimes.
- **Tier B — Behavioral evals** (runtime-agnostic, dotnet/skills pattern): one eval suite per skill, live LLM sessions, pairwise judging (with-skill vs baseline), overfitting detection. Measures behavioral *impact*, not just trace conformance.

The trickiest design problem is **harness versioning** — each runtime ships catalog updates independently; the manifest needs to be pinned, drift-detectable, and bidirectional.

---

## Why now

The 2026-05-13 Windows dogfood session surfaced 8 findings; every gate verified that the code matched the spec. Nothing verified that the spec matched reality. Wave 1 (#1358) introduced the outcome-tier to catch operator-visible behavior. The next thing to land was #1365 — eval-suite elevation steps 1–2 (versioned dataset baselines + HTML dashboard from CI), modeled on `github.com/dotnet/skills`.

During preview.3 plan-review three observations converged:

1. **Catalog gap was bigger than expected.** Measuring against `skills-src/`: 6 of 17 actual skill directories have eval suites (the `skills-src/` listing contains 19 entries — 17 skill dirs plus `_shared` and `SKILL_AUTHORING.md` which are not skills). The missing 11 include `synthesis` (PR creation), `shepherd` (CI review and merge), `merge-orchestrator` (heaviest skill at 12 KB), `cleanup`, `oneshot-workflow`, `workflow-state`. Filing #1397 surfaced this scale.

2. **`{{TOKEN}}` placeholders are harness mechanics.** Looking at `runtimes/<runtime>.yaml` substitutions, the tokens are tool names (`Edit` vs `apply_patch`), command verbs (`Bash` vs `shell`), hook surfaces, filesystem paths, permission rules. **The behavioral intent of a skill is unchanged across runtimes; only the harness-facing verbs change.** Evaluating each rendered SKILL.md with a live LLM is triple-counting the same behavior under different vocabularies — wasteful, and worse, it muddles "did the skill teach the right behavior?" with "did the harness substitution produce a runnable form?"

3. **dotnet/skills doesn't have our templating problem.** Their skills are single-form: one `SKILL.md` per skill, ships to GitHub Copilot (and other runtimes via plugin manifests) unchanged. Their evals can test "the rendered prose" because there's only one rendering. We render to 6 runtimes from one source; our evals have to either test the abstract behavior (current approach, no rendering verification) or test all 6 renderings (six-fold cost). Neither is right.

Shipping #1365 steps 1+2 against the current eval format means migrating both immediately after the redesign lands. Pull from preview.3, design the right thing once, ship it once.

---

## Current state inventory

### What exists at HEAD (2026-05-15)

**Eval data files:**
```
evals/
├ <skill>/suite.json + datasets/{regression,capability,golden}.jsonl  (6 skills only)
├ datasets/                  (does not exist yet — was the #1365 step 1 target)
├ captured/                  (trace recordings — *.trace.jsonl)
├ calibration/gold-standard.jsonl
└ reliability/datasets/{regression,compaction-behavioral}.jsonl
```

**Runtime:** `servers/exarchos-mcp/src/evals/`
- `harness.ts` — orchestrator; runs `runAll()` across suites.
- `dataset-loader.ts` — JSONL parser, schema-validates each line against `EvalCaseSchema`.
- `comparison.ts` — trace-comparison primitives.
- `graders/` — assertion-grader implementations (tool-call, trace-pattern, exact-match, llm-rubric, llm-similarity).
- `calibration-metrics.ts` + `calibration-split.ts` — grader agreement tracking.
- `reporters/` — `cli-reporter.ts` + `ci-reporter.ts` (GitHub Actions `::error::` / `::notice::`).
- `auto-triage.ts`, `deduplication.ts`, `trace-capture.ts` — meta machinery.
- `run-evals-cli.ts` — stdin-JSON entrypoint, invoked by CI.

**CI:** `.github/workflows/eval-gate.yml`
- Triggers on `pull_request` with path-filter on `skills/`, `commands/`, `rules/`, `evals/`, `servers/exarchos-mcp/src/{workflow/playbooks.ts,cli-commands,orchestrate/prepare-delegation.ts,evals}`, the workflow file itself.
- Two layers — `regression` (blocking exit code), `capability` (advisory; `continue-on-error: true`).
- Runs `bun dist/evals/run-evals-cli.js` with `{ci: true, layer: <name>}` over stdin.
- Self-hosted runner; `ANTHROPIC_API_KEY` secret; 15-minute timeout.
- **No fork-PR security model.** **No daily schedule.** **No Pages publication.**

### Skill catalog (18 source dirs)

```
WITH evals (6):     brainstorming, debug, delegation, implementation-planning,
                    quality-review, refactor
WITHOUT evals (11): cleanup, discovery, dogfood, git-worktrees, merge-orchestrator,
                    oneshot-workflow, prune-workflows, shepherd, spec-review,
                    synthesis, workflow-state
```

(`_shared` and `SKILL_AUTHORING.md` excluded as non-skills.)

### Existing assertion types

From the 6 live suites:

- `tool-call` (correctness, required calls in trace)
- `trace-pattern` (event-sequence match, ordered/unordered)
- `exact-match` (artifact paths)
- `llm-rubric` (LLM judge against a written rubric)
- `llm-similarity` (LLM-judged similarity between actual and expected output)

All assertions run against simulated traces in the JSONL `input.tool_calls + input.trace_events` segments — **not** against live LLM responses. The two `llm-*` types call the LLM for grading, not for behavior production.

---

## dotnet/skills implementation (verified from `github.com/dotnet/skills` 2026-05-15)

### Architecture

**Eval data:** `tests/<plugin>/<skill>/eval.yaml` (canonical) + `eval.vally.yaml` (Vally adapter). YAML, not JSONL. Each carries `scenarios` (or `stimuli`) with free-text `prompt`, an `assertions` array, and a `rubric` array.

Example (`tests/dotnet-ai/mcp-csharp-create/eval.yaml`):

```yaml
scenarios:
  - name: "Implement MCP tools with proper attributes and DI"
    prompt: |
      I have a new C# MCP server project. I need to implement a tool class that...
    assertions:
      - type: "output_matches"
        pattern: "\\[McpServerTool[\\],\\(]"
      - type: "output_matches"
        pattern: "(AddHttpClient|HttpClient)"
    rubric:
      - "Shows a tool class with [McpServerTool] attributes"
      - "Injects HttpClient via DI..."
    timeout: 360
```

**Runner:** `eng/skill-validator/` — .NET CLI with `Evaluate/` package containing:
- `AgentRunner.cs` — for each scenario, spins up a **live LLM session** with the skill loaded and the prompt as input. Captures response + metrics.
- `Judge.cs` — sends captured response + rubric to an LLM judge (currently `claude-opus-4.6`). Returns per-rubric-item pass/fail with reasoning. **Denies all tool permissions during judging** (`onPermissionRequest` returns deny) — judging must be a pure LLM task with no file or tool side effects.
- `PairwiseJudge.cs` — runs the scenario TWICE: with-skill and baseline-without-skill. Asks the judge which is better. **Position-swap bias mitigation: A-then-B and B-then-A, checks consistency.**
- `OverfittingJudge.cs` — analyzes the skill content + eval cases together. Detects when an eval is testing the literal SKILL.md prose instead of the underlying behavior. Anti-cheat at the eval-design level. 48 KB skill-content cap (~12K tokens).
- `Reporter.cs` + `SessionDatabase.cs` + `Statistics.cs` — persist runs, time-series, surface in dashboard.

**CI:** `.github/workflows/evaluation.yml`
- Multi-trigger: `pull_request`, `pull_request_target` (for fork security), `issue_comment` (`/evaluate` command, requires write-permission), `schedule: '0 0 * * *'` (daily).
- PR-status job posts "success" (no skill changes) or "pending" (needs `/evaluate`) so required-check doesn't dangle.
- **Fork security model is explicit and two-tier:** workflow YAML always loaded from `main`; validator binary built from `main` for forks, from PR branch for same-repo PRs; skill content checked out from the fork PR as untrusted data.
- Model pinning: `MODEL: claude-opus-4.6`, `JUDGE_MODEL: claude-opus-4.6` as env vars.
- Daily scheduled runs.

**Dashboard:** `eng/dashboard/dashboard.html` + `dashboard.js` + `token-usage.js`. Generated by `generate-benchmark-data.ps1`. Published to GitHub Pages with 14-day retention via `DASHBOARD_RETENTION_DAYS: 14`.

**Validator self-tests:** `eng/skill-validator/tests/Check/` + `tests/Evaluate/` — unit tests of the eval framework itself. Coverage includes `EvalDiscoveryTests`, `EvalSchemaTests`, `FailureIsolationTests`, `JudgeTests`, `OverfittingJudgeTests`, `AssertionsTests`, `ComparatorTests`.

### Where dotnet/skills is ahead of us

| Capability | dotnet/skills | exarchos |
|---|---|---|
| Live LLM session per case | ✅ Every scenario | ❌ Only `llm-*` assertion grading |
| Pairwise judging (proof-of-skill vs baseline) | ✅ With position-swap bias mitigation | ❌ |
| Overfitting detection | ✅ Dedicated judge | ❌ |
| Versioned datasets | Implicit (PR YAML diffs) | ❌ (was #1365 step 1) |
| HTML dashboard | ✅ Pages-published, 14-day retention | ❌ (was #1365 step 2) |
| Daily scheduled runs | ✅ | ❌ |
| Fork-PR security model | ✅ Two-tier | ❌ |
| Self-tests of the framework | ✅ `eng/skill-validator/tests/` | Partial (`*.test.ts` co-located) |

### Where exarchos has a harder problem

| Dimension | dotnet/skills | exarchos |
|---|---|---|
| Multi-runtime templating | ❌ Single SKILL.md per skill | ✅ 6 runtime variants from `{{TOKEN}}` substitution |
| Multi-tier composition | Test pyramid + eval | Unit / integration / process / outcome / eval |
| Calibration mechanics | Implicit (judge consistency) | Explicit (`calibration-metrics.ts`) |
| Trace-based assertion replay | Not used | Used everywhere |

---

## The `{{TOKEN}}` insight (sharpening)

A representative substitution map (from `runtimes/<runtime>.yaml`):

| Concept | claude | codex | copilot | cursor | opencode | generic |
|---|---|---|---|---|---|---|
| Edit a file | `Edit` | `apply_patch` | `editFile` | `edit_file` | `edit_file` | `<file_edit>` |
| Run shell | `Bash` | `shell` | `terminal` | `run_terminal_cmd` | `bash` | `<shell>` |
| Plugin path | `~/.claude/plugins/` | `~/.codex/plugins/` | `…` | `…` | `…` | `<plugin_dir>` |

**Observation:** these are *injective renames* — Edit always becomes apply_patch in codex; Bash always becomes shell. They don't change *what* the agent does (modify a file, run a command); they only change *the verb used to express it*.

**Implication:** an eval that says "the agent should edit a file when asked to fix a bug" tests the same behavior in all 6 runtimes. There's exactly one behavioral assertion to make. But there are 6 surface-level vocabulary checks to make — does the rendered prose reference the verb correctly in each runtime?

**Right architecture:**

1. **Tier A — Harness-surface tier.** For each rendered `skills/<runtime>/<skill>/SKILL.md`, schema-validate every harness-primitive reference against the runtime's declared catalog. Deterministic. Fast. Unit-tier speed. Catches the entire rendering-drift class without one LLM call.

2. **Tier B — Behavioral tier.** Test against a single canonical rendering (probably `skills/claude/<skill>/SKILL.md` since that's the primary author target, or a designated "behavioral source" derived from `skills-src/<skill>/SKILL.md`). LLM-based, dotnet/skills pattern: live sessions + pairwise judging + overfitting detection. **One eval suite per behavioral skill, not per runtime.**

---

## Tier A — Harness-surface tests (proposed)

### What the manifest looks like

Extend `runtimes/<runtime>.yaml` with a harness-catalog block:

```yaml
# runtimes/claude.yaml
name: claude
harnessVersion: "claude-code@2.x"   # pinned version range
harnessLockfile: claude-harness-2x.lock.json  # sibling file with exact catalog

# In claude-harness-2x.lock.json:
{
  "harnessVersion": "claude-code@2.4.1",
  "lockedAt": "2026-05-15T00:00:00Z",
  "tools": [
    { "name": "Edit", "description": "...", "params": [...] },
    { "name": "Read", ... },
    ...
  ],
  "commands": [
    { "name": "/clear", ... },
    { "name": "/help", ... },
    ...
  ],
  "hooks": ["TaskCreate", "TaskUpdate", ...],
  "permissions": {...},
  "paths": {
    "pluginDir": "~/.claude/plugins/",
    "skillsDir": ".claude/skills/",
    ...
  }
}
```

### What Tier A asserts

For each `skills/<runtime>/<skill>/SKILL.md`:

1. **Tool references resolve.** Every backticked `Tool` or `<tool>` reference matches an entry in the runtime's `tools[]`.
2. **Command references resolve.** Every `/command` reference appears in `commands[]`.
3. **Hook references resolve.** Every hook-name reference appears in `hooks[]`.
4. **Path conventions hold.** Every `~/foo` or `.bar/baz` path matches the runtime's `paths[]` conventions.
5. **No drift between source and rendered.** `npm run build:skills` produces output identical to what's committed (this is the existing `skills:guard` check; pair it with Tier A).

### Bidirectional drift detection

Tier A flags two failure modes:

- **Skill references a token not in the manifest** — the substitution table is missing a verb; or the skill author hand-typed a verb that doesn't exist; or the harness deprecated something we still cite.
- **Manifest declares a token no skill uses** — informational; surfaces "harness added something; should we be using it?" Doesn't fail CI by default.

### Harness versioning protocol

- Each runtime's `harnessLockfile` is the source of truth for the catalog AT a pinned version.
- **Update path:** when upstream ships a new version, run a maintenance command (e.g., `npm run runtimes:sync claude`) that re-fetches the catalog and produces a diff. Authors review and merge.
- **CI sync job (optional):** scheduled weekly to re-fetch upstream and open an automated PR if drift detected. Or manual-trigger only.
- **Multiple harness versions:** support range pinning — e.g., `claude-code@2.x` validates against the latest 2.x catalog, but the lockfile records the exact version that was current at sync time. Major version bumps trigger explicit author review.

### Where Tier A code lives

```
servers/exarchos-mcp/src/harness-surface/
├ manifest-loader.ts         (loads runtime YAML + lockfile)
├ skill-scanner.ts           (extracts harness-primitive references from SKILL.md)
├ validator.ts               (cross-references scanner output against manifest)
├ reporter.ts                (human-readable + CI annotation output)
└ sync-command.ts            (fetches upstream catalog → lockfile diff)

tests/harness-surface/
├ <runtime>/<skill>.test.ts  (one per skill × runtime = ~108 tests for 17 skills × 6 runtimes)
```

CI integration: new workflow `.github/workflows/harness-surface.yml` runs on every PR. Fast (no LLM, no network); blocking on red.

---

## Tier B — Behavioral evals (proposed)

### Pattern: dotnet/skills, adapted

**Eval data file:** one YAML per skill at `evals/<skill>/eval.yaml` (replaces today's `suite.json + datasets/*.jsonl` split):

```yaml
name: synthesis
description: Evaluates the synthesis skill (PR creation)
type: capability
config:
  timeout: 6m
scenarios:
  - name: "Synthesize a feature PR with no test plan section"
    prompt: |
      I have a feature branch with one new file (feat.ts) and three new tests.
      The user said to create the PR. Walk through synthesis.
    graders:
      - type: tool-call
        config:
          required:
            - tool: exarchos_orchestrate
              action: synthesize
      - type: pairwise        # with-skill vs baseline-without-skill
      - type: judge           # rubric-graded
    rubric:
      - "Notices missing test_plan section and either generates one or asks user"
      - "Does not create a PR with empty body"
      - "Mentions all three new test files in the PR body"
  - name: "Refuse to synthesize from a dirty worktree"
    prompt: |
      I have uncommitted changes in two files and asked you to create the PR.
    graders:
      - type: tool-call
        config:
          forbidden:
            - tool: exarchos_orchestrate
              action: synthesize    # MUST NOT call synthesize on dirty tree
      - type: judge
    rubric:
      - "Explicitly notices the dirty worktree"
      - "Refuses to proceed and explains why"
      - "Suggests either committing or stashing"
```

**Runner:** new TS module at `servers/exarchos-mcp/src/behavioral-evals/`:
- `agent-runner.ts` — spins live LLM session with skill loaded, runs prompt, captures response + metrics. (Equivalent to dotnet's `AgentRunner.cs`.)
- `judge.ts` — rubric-grading LLM call; permissions denied. (Equivalent to dotnet's `Judge.cs`.)
- `pairwise-judge.ts` — runs scenario twice (with-skill, baseline), judges with A-then-B + B-then-A. (Equivalent to dotnet's `PairwiseJudge.cs`.)
- `overfitting-judge.ts` — analyzes eval against skill content for over-tuning. (Equivalent to dotnet's `OverfittingJudge.cs`.)

**Eval source:** for runtime-agnosticism, evals run against a designated canonical rendering — likely `skills/claude/<skill>/SKILL.md` since Claude is the primary author target. Alternative: a "behavioral source" pre-substitution form that strips harness verbs entirely (treats them as opaque tokens). First decision point for the next ideation pass.

**Migration:** the 6 existing eval suites get rewritten to the new format. Trace-replay assertions don't carry over — Tier B is live-LLM only. Some of today's capability cases may collapse into a single richer scenario; others may split.

---

## Cross-cutting concerns

### 1. Harness version migrations

When a harness ships a new version with renamed or removed verbs:

- Tier A's lockfile sync surfaces the diff.
- Authors edit `runtimes/<runtime>.yaml`'s substitution map to point at the new verb.
- `npm run build:skills` regenerates `skills/<runtime>/**`.
- `skills:guard` passes; Tier A passes against the new lockfile.
- Tier B is **unaffected** because it tests behavioral intent, not verb names.

This is the key property: harness churn doesn't touch Tier B. Authoring effort is roughly O(skills) once, not O(skills × harness versions × runtimes).

### 2. Multiple model evaluations

dotnet/skills pins one model (`claude-opus-4.6`). For Tier B, we have a choice:

- Pin one model (operating cost lowest; reflects production posture).
- Run across a small panel (Opus + Sonnet + Haiku) and surface per-model pass rates (catches model regressions; ~3x cost).
- Hybrid: pin one model in CI; run the panel weekly on a schedule.

Recommendation: pin one in CI; panel weekly on schedule. Second decision point.

### 3. Fork-PR security

dotnet/skills' two-tier model is sophisticated and worth borrowing wholesale:

- Workflow YAML always from `main` (enforced by `issue_comment` and `pull_request_target` trigger semantics).
- Tier A binary built from `main` for forks, from PR branch for same-repo PRs.
- Tier B binary same posture.
- Skill content checked out from fork PR as untrusted data; never executed, only loaded as text.
- Secret access (LLM API keys) gated by write-permission check.

### 4. Existing 6 eval suites — migration plan

Wave A (paired with Tier B framework): rewrite the 6 existing suites (`brainstorming`, `debug`, `delegation`, `implementation-planning`, `quality-review`, `refactor`) to the new `eval.yaml` format. Drop trace-replay; lift the rubric items into LLM-judged form.

Wave B+C: the 11 missing skills get suites in the new format (this is the original #1397 scope, redirected).

### 5. The captured-traces directory

`evals/captured/*.trace.jsonl` exists today as a side-channel for behavior recording. Under the new architecture this is **unused for assertion purposes**. Keep it for diagnostic / offline analysis, or retire it. Decision point.

---

## Migration sequencing (rough)

A four-phase migration is plausible:

**Phase 1 — Tier A foundation (Linux-only, no LLM cost):**
- Build `harness-surface/` module.
- Author manifests for all 6 runtimes (snapshot current catalogs).
- Generate the ~108 tests (17 skills × 6 runtimes).
- Wire CI workflow.
- Land on its own — gates rendering drift immediately.

**Phase 2 — Tier B foundation (LLM cost begins):**
- Build `behavioral-evals/` runner with `AgentRunner` + `Judge`.
- Migrate ONE existing suite (probably `delegation` since it's the canonical workflow skill) to the new format as the proof-of-concept.
- Wire CI workflow for Tier B; pin one model.

**Phase 3 — Wave A migration:**
- Migrate remaining 5 existing suites.
- Add `PairwiseJudge` + `OverfittingJudge`.
- Add HTML dashboard against new format.
- Add fork-PR security model.

**Phase 4 — Wave B+C catalog completion:**
- Write Tier B suites for the 11 missing skills.
- Add daily scheduled runs.
- Pages publication of dashboard.

Each phase is plausibly 1-2 weeks. Total 6-8 weeks of focused work; likely longer with interleaved review cycles. Target: v2.11 substrate, possibly slipping into v2.12.

---

## Open questions for the next ideate pass

1. **Where does the behavioral source live?** Three options:
   - (a) `skills/claude/<skill>/SKILL.md` as the canonical rendering (pins to Claude's vocabulary).
   - (b) A new "behavioral-only" pre-substitution form (verb tokens explicit but unresolved).
   - (c) Test against the AST/structured form of the skill (not prose).

2. **Tier A scope decisions:**
   - Strict matching vs fuzzy? (`Edit` vs `edit_file` — do we normalize first?)
   - Mention vs invocation? (Does a backtick mention count, or only verb-pattern invocations?)
   - Strict or advisory on the "manifest declares something no skill uses" direction?

3. **Tier B graders:** which subset of dotnet/skills' judges to ship in phase 2?
   - Minimum: `Judge` (rubric grading).
   - Recommended: + `PairwiseJudge` (proof-of-skill).
   - Stretch: + `OverfittingJudge` (anti-cheat).

4. **Pairwise judging baseline definition:** what does "without skill" mean exactly?
   - No SKILL.md loaded at all? (Tests skill presence vs absence.)
   - SKILL.md loaded but rubric items stripped? (Tests guidance vs no guidance.)
   - SKILL.md replaced with a generic "be helpful" prompt? (Tests skill-specific vs baseline guidance.)

5. **Storage model for runs:** dotnet/skills uses `SessionDatabase.cs` (probably SQLite). We have the Marten event store. Do we record Tier B runs as events? Or use a separate sidecar SQLite?

6. **Model pinning policy:** single-model CI + panel-weekly is the recommendation, but the panel composition needs to be decided (Opus+Sonnet+Haiku, or include open-weight models, or include older Claude versions for regression detection).

7. **Migration semantics for the 6 existing suites:** strict 1:1 case mapping, or open license to redesign? Some current `llm-similarity` assertions don't make sense in a live-LLM world — they test if simulated output matches expected output; live LLM produces actual output, which is what's being graded.

8. **Cost gating:** Tier B is genuinely expensive (live LLM per scenario × N scenarios × pairwise = 2N+ calls per skill). What's the cost ceiling per CI run? Per scheduled run? Where do we draw the line on which evals are blocking vs advisory?

9. **Outcome-tier interaction:** today the outcome tier (`tests/outcome/*`) is binary-correctness; Tier B is behavioral; Tier A is rendering. Is the three-tier picture stable, or does Tier A subsume some current process-tier checks?

10. **Calibration mechanics:** `calibration-metrics.ts` is bespoke. dotnet/skills uses judge-consistency as the calibration signal (when A↔B swap disagrees, the judge is uncalibrated). Keep our explicit calibration, replace it with judge-consistency, or run both?

---

## Cross-references

### Existing issues touched by this redesign

- **#1365** — original "eval-suite elevation (steps 1-2)" issue. Will be retargeted or superseded by the redesign epic. Don't close — measured data still useful.
- **#1387** — calibration drift gate. Subsumed by Tier B's judge-consistency or supplemented by it. Re-scope.
- **#1396** — cross-runtime smoke coverage. **Becomes Tier A directly.** This is essentially Tier A under a different name.
- **#1397** — F5 catalog audit (11 missing skills). **Becomes Wave B+C of the migration** — add Tier B suites for the missing skills in the new format.

All four should get a comment linking to this seed doc + the eventual design doc. Don't close; let the redesign supersede them with new tracking issues.

### Related substrate

- **`evals/captured/`** — trace recordings. Useful as a behavioral baseline for designing scenarios; retire as an assertion source.
- **`servers/exarchos-mcp/src/evals/calibration-*`** — calibration machinery. May migrate to Tier B's judge stack.
- **`runtimes/<runtime>.yaml`** — substitution maps. Tier A extends these with harness-catalog blocks.
- **`skills-src/<skill>/SKILL.md`** — source-of-truth skill prose. Tier B's canonical rendering input.
- **`skills/<runtime>/<skill>/SKILL.md`** — rendered variants. Tier A's validation target.

### Documentation pointers

- dotnet/skills repository: `github.com/dotnet/skills`
- dotnet/skills validator: `eng/skill-validator/src/Evaluate/`
- dotnet/skills CI: `.github/workflows/evaluation.yml`
- exarchos current eval gate: `.github/workflows/eval-gate.yml`
- exarchos current eval source: `servers/exarchos-mcp/src/evals/`

---

## Suggested next steps

1. **Run `/exarchos:ideate`** on this seed doc when ready to start the redesign workflow. Inputs are this file + the open questions above. Expected output: design doc at `docs/designs/YYYY-MM-DD-eval-suite-redesign.md`.
2. **File a tracking epic** before the ideate pass (or as its first artifact) — "epic: eval-suite redesign — two-tier architecture (harness-surface + behavioral)". Link #1365, #1387, #1396, #1397 as inputs.
3. **Comment on #1365, #1396, #1397** with a pointer to this seed doc (already planned as part of the preview.3 reshape).
4. **Target milestone:** v2.11.0 — Autonomous Orchestration, or v2.12.0 — Process Lifecycle Verbs, depending on the cost ceiling and time investment the team is willing to commit. Preview.3 close-out itself unblocks the path.