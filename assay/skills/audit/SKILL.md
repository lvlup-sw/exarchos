---
name: audit
description: "Run a comprehensive backend quality audit across all seven dimensions. Orchestrates scan, critique, harden, distill, and verify skills, deduplicates findings, and produces a unified report with verdict. Use when assessing overall codebase health. Triggers: 'audit backend', 'full quality check', 'run audit', or /assay:audit. Do NOT use for targeted checks — use individual skills instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - all
---

# Audit — Comprehensive Backend Quality Assessment

## Overview

The anchor skill that orchestrates all other assay skills to produce a comprehensive backend quality report. Runs deterministic checks and qualitative assessments across all 7 dimensions, deduplicates findings, computes per-dimension metrics, and delivers a unified verdict.

## Triggers

**Use when:**
- Assessing overall codebase or module health
- Preparing for a release or major refactor
- Onboarding to understand existing technical debt
- User says "audit", "full quality check", "assess quality"

**Do NOT use when:**
- Targeting a specific concern (use `assay:critique`, `assay:harden`, `assay:distill`, or `assay:verify` directly)
- Running only deterministic checks (use `assay:scan`)
- Performing workflow-specific review (workflow tools orchestrate assay, not the reverse)

## Process

### Step 1: Scope Resolution

Determine the assessment scope from the `scope` argument:
- **File:** Assess a single file
- **Directory:** Assess all files in a directory (recursive)
- **Codebase:** Assess the entire project (default: current working directory)

Exclude by default: `node_modules/`, `dist/`, `.git/`, binary files, generated files.

### Step 2: Deterministic Scan

Run `assay:scan` with `dimensions: all` for the resolved scope. This produces the mechanical findings that ground the qualitative assessment.

### Step 3: Qualitative Assessment

Run each specialized skill in sequence, passing the scope:

1. **`assay:critique`** — Architecture (DIM-6) + Topology (DIM-1)
2. **`assay:harden`** — Observability (DIM-2) + Resilience (DIM-7)
3. **`assay:distill`** — Hygiene (DIM-5) + Topology (DIM-1)
4. **`assay:verify`** — Test Fidelity (DIM-4) + Contracts (DIM-3)

Each skill produces findings in the standard format: `@skills/backend-quality/references/findings-format.md`

### Step 4: Deduplicate and Aggregate

Merge findings from all skills using these rules:
- **Same evidence + same dimension:** Merge into single finding (keep most detailed explanation)
- **Same evidence + different dimensions:** Keep both (finding genuinely spans two concerns)
- **Same pattern + different files:** Keep as separate findings
- **Deterministic + qualitative for same issue:** Merge, mark as `deterministic: true`

### Step 5: Coverage Check

Verify all 7 dimensions were assessed. If any dimension has zero findings and zero checks:
- **Warning:** "DIM-N ({name}) was not assessed — no checks or findings produced"
- This may indicate the scope doesn't contain code relevant to that dimension

### Step 6: Compute Verdict

Apply the verdict exactly as defined in `@skills/backend-quality/references/scoring-model.md` (single source of truth). Do not redefine thresholds here; compute and report the inputs required by the model (HIGH/MEDIUM/LOW counts).

Compute per-dimension metrics:
- Pass rate (deterministic checks only)
- Finding count (all findings)
- Severity distribution (HIGH / MEDIUM / LOW)

### Step 7: Produce Report

Output the structured report per the template in `@skills/backend-quality/references/scoring-model.md`:

```markdown
# Backend Quality Report

**Scope:** [assessed scope]
**Verdict:** [CLEAN | NEEDS_ATTENTION]
**Date:** [current date]

## Summary
[Per-dimension table with findings, severity counts, pass rates]

## HIGH-Priority Findings
[Findings requiring immediate attention]

## MEDIUM-Priority Findings
[Findings to address soon]

## LOW-Priority Findings
[Polish and minor items]

## Dimensional Coverage
[Which dimensions assessed, any gaps]

## Recommendations
[Top 3-5 prioritized action items]
```

## Error Handling

- **Empty scope (no files to assess):** Return "Nothing to assess — no files found in scope" with verdict CLEAN
- **Partial skill failure:** If one skill errors, continue with the remaining skills. Report the error in the output: "assay:{skill} encountered an error: {message}. Results from other skills are still valid."
- **Scope validation:** Verify file/directory exists before starting. If not found: "Scope not found: {path}"

## Composition Guide

For details on how audit discovers skills, handles deduplication, and formats reports, see `@skills/audit/references/composition-guide.md`.

## References

- Dimension taxonomy: `@skills/backend-quality/references/dimensions.md`
- Finding format: `@skills/backend-quality/references/findings-format.md`
- Scoring model: `@skills/backend-quality/references/scoring-model.md`
- Composition details: `@skills/audit/references/composition-guide.md`
