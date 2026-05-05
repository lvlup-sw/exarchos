# Exarchos `check_task_decomposition` — parser false-positives

**Severity:** Low (advisory check, doesn't block); but currently it is **noise that
crowds out real findings**, so reviewers either learn to ignore the check entirely
(losing its real signal) or waste cycles re-investigating known false positives every
revision. Ideally, fix.

**Repro reference:** Workflow `agency-csl-auto-pr`, plan
`docs/plans/2026-04-29-agency-csl-auto-pr.md` (33 tasks). Both revision 1 and revision 2
hit identical false-positive patterns. Plan structure is the standard
`@skills/implementation-planning` shape (Goal / TDD steps / Acceptance criteria /
Dependencies / Parallelizable / etc).

## Symptom

`exarchos_orchestrate check_task_decomposition` returned:

```
- Well-decomposed: 0/33 tasks
- Needs rework: 33/33 tasks
- Dependency: CYCLE DETECTED
- Parallel safety: 6 conflict(s)
**Result: FAIL** — 33 tasks need rework
```

Despite the plan having every task fully described with explicit `## Task <id>: <title>`
headers, multi-paragraph goal sections, TDD step lists, acceptance criteria, and
explicit `**Dependencies:**` and `**Parallelizable:**` lines.

## Three distinct parser bugs

### Bug 1 — Description detection always reports `0 words`

Every task gets `✗ (0 words)` for the Description column, even when the task body has
hundreds of words of substantive prose under headings like `**Goal:**`, `1. [RED]`,
`2. [GREEN]`, `**Acceptance criteria:**`, etc.

Likely cause: the parser is looking for a literal `Description:` field (or a paragraph
in a specific position relative to the title), and the implementation-planning skill's
output uses semantic section headers instead. The check should probably treat anything
between the task heading and the next `**Acceptance criteria:**` (or analogous boundary)
as the description, or simply count total words in the task block.

### Bug 2 — Dependency parser strips digits out of identifiers in narrative text

Reported: `CYCLE DETECTED: Unresolved dependency: 033 depends on unknown 24`.

T033's actual dependency line reads:

> **Dependencies:** T002 (`GetCslSloRollup24h` exposes sample size per SLO), T008 (...), T027 (...)

The parser appears to be tokenising on `T\d+` *anywhere* in the body, not just in the
`**Dependencies:**` line. It pulls `24` out of the Kusto function name `GetCslSloRollup24h`
and treats it as a dependency on a non-existent task `T024`.

Suggested fix: anchor the dependency parser to the `**Dependencies:**` line only, or
require a leading `T0+` prefix and a trailing word boundary that isn't a letter/digit
(so `T024` ≠ `Rollup24h`).

### Bug 3 — File-conflict detector treats narrative file references as modifications

Reported conflicts include:

- `001 and 026 both modify agency.json` — T001 *creates* `agency.json`; T026 *mentions*
  `agency.json` once in its README acceptance criteria but doesn't touch the file.
- `003 and 004 both modify imageProvenance.isFirstParty` and `mutatingTool.detected` —
  these are **field names from a TypeScript record**, not file paths. The parser is
  matching dotted identifiers in narrative prose as if they were file modifications.
- `009 and 033 both modify corpus.manifest.json` — T009 owns this file; T033's
  acceptance criteria links to T009 (the eval corpus manifest is a prereq for what T033
  visualises) but T033 doesn't write to it.

Suggested fixes:

1. Require file paths to appear under an explicit `**Files:**` (or `**Artifacts:**`)
   section to count as "this task modifies these files". Don't infer from narrative.
2. If inference must continue, exclude tokens containing `.` that aren't preceded by
   a path separator or wrapped in backticks/code spans, and require an extension
   matching a known file pattern.

## Why this matters

The two substantive plan-review gates (`check_plan_coverage` and
`check_provenance_chain`) PASSED 15/15 in both revisions. The deeper Framing-B human
review found 4 real depth gaps in revision 1 (closed in revision 2). The
`check_task_decomposition` advisory check, in its current state, contributed **zero
real signal** to either revision but produced 33+ false-positive findings each time.

When all three plan-review gates run together and one is reliably noisy, reviewers
learn to ignore it — which means a real future regression flagged by this check would
also be ignored. Fixing the three parser bugs would restore the signal.

## Suggested filing

- Repo: Exarchos MCP server repo (wherever `exarchos_orchestrate` lives)
- Title: `check_task_decomposition: parser false-positives crowd out real signal`
- Labels: `bug`, `mcp-tool`, `low-priority` (since it's advisory)
- Attach this document
