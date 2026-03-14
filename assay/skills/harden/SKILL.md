---
name: harden
description: "Strengthen backend resilience by finding silent catches, missing error context, resource leaks, and operational fragility. Use when hardening error handling or preparing for production deployment. Triggers: 'harden code', 'check error handling', 'resilience review', or /assay:harden. Do NOT use for dead code — use assay:distill instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - observability
    - resilience
---

# Harden Skill

## Overview

Resilience-focused assessment skill covering DIM-2 (Observability) and DIM-7 (Resilience) from the backend quality dimension taxonomy. Finds error handling gaps, silent catches, resource leaks, and operational fragility that could cause cascading failures under stress.

This skill combines deterministic pattern detection (via `assay:scan`) with qualitative judgment to assess how well code handles failure, communicates errors, and manages resources.

## Triggers

### Positive Triggers

Activate this skill when:
- User says "harden code", "harden this", or "resilience review"
- User says "check error handling" or "audit error handling"
- User runs `/assay:harden`
- Preparing code for production deployment
- After an incident exposed error handling gaps

### Negative Triggers

Do NOT use this skill when:
- Looking for dead code or vestigial patterns — use `assay:distill` instead
- Reviewing architecture or SOLID compliance — use `assay:critique` instead
- Checking test quality or mock fidelity — use `assay:verify` instead
- Running a comprehensive audit — use `assay:audit` instead

## Process

### Step 1: Load Dimension Definitions

Load the relevant dimensions from the shared taxonomy:

- `@skills/backend-quality/references/dimensions.md` — read the DIM-2 (Observability) and DIM-7 (Resilience) sections for invariants, signals, and severity guides.

### Step 2: Run Deterministic Checks

Invoke `assay:scan` for mechanical pattern detection on the Observability and Resilience dimensions:

- DIM-2 checks: empty catch blocks, log-only catches, swallowed promise rejections
- DIM-7 checks: unbounded collections, missing timeouts, unbounded retry loops

Collect all deterministic findings. These form the baseline that qualitative assessment builds upon.

### Step 3: Qualitative Assessment

Layer judgment-based analysis on top of the deterministic results. For each area, review the flagged code regions and nearby context:

#### 3a. Empty Catch Audit

Classify every catch block in scope into one of four categories:

| Category | Definition | Action |
|----------|-----------|--------|
| **Silent** | Empty catch body, no logging, no recovery | HIGH — must add handling or documented rationale |
| **Log-only** | Logs the error but takes no recovery action | MEDIUM — evaluate whether recovery is needed |
| **Recovery** | Catches, logs, and takes corrective action | OK — verify recovery is correct |
| **Intentional** | Documented rationale for swallowing (e.g., `// Intentional: probe-only, failure is expected`) | OK — verify comment is accurate |

Consult `@skills/harden/references/error-patterns.md` for the full silent catch taxonomy and classification guidance.

#### 3b. Error Context Propagation

For each error path, evaluate whether errors include sufficient context:

- **What** failed? (operation name, inputs, resource identifier)
- **Why** did it fail? (root cause, constraint violation)
- **How to fix?** (retry guidance, configuration check, escalation path)
- **Cause chain?** (is the original error preserved via `{ cause: e }`?)

Generic error messages like "Something went wrong" or "Operation failed" are a MEDIUM finding.

#### 3c. Fallback Behavior Analysis

Identify all fallback paths and evaluate visibility:

- Are fallbacks logged or metriced so operators know degraded mode is active?
- Do fallbacks silently switch behavior modes without signaling?
- Is best-effort behavior clearly documented and visible in monitoring?

Silent degradation — where the system quietly switches to a less capable mode — is a HIGH finding.

#### 3d. Resource Lifecycle

Verify open/close symmetry and acquire/release patterns:

- File handles opened in try blocks — are they closed in finally?
- Database connections — are they released on both success and error paths?
- Event listeners — are they removed when no longer needed?
- Streams — are they properly ended/destroyed on error?

Consult `@skills/harden/references/resilience-checklist.md` for the full resource management checklist.

#### 3e. Timeout and Retry Evaluation

For every external call (HTTP, database, file system, IPC):

- Is there a timeout? (missing timeout = MEDIUM)
- Is the timeout reasonable for the operation? (60s for a health check = LOW)
- Are retries bounded? (unbounded retry = HIGH)
- Is there backoff? (no backoff = MEDIUM)

#### 3f. Cache Bound Verification

For every in-memory collection that persists beyond a single request:

- Is there a maximum size? (unbounded Map/Set/Array = HIGH)
- Is there an eviction policy? (LRU, TTL, or manual clear)
- Do collections grow monotonically without cleanup?

### Step 4: Output Findings

Format all findings per the standard finding schema: `@skills/backend-quality/references/findings-format.md`

Group findings by severity (HIGH, MEDIUM, LOW). Each finding must include:
- Dimension (DIM-2 or DIM-7)
- Evidence (file:line references)
- Explanation (what is wrong and why it matters)
- Suggestion (how to fix, when actionable)
- Whether it was found deterministically or qualitatively

## Error Handling

### Empty Scope

If the provided scope is empty or contains no files to analyze, return an informative message:

> "No files found in the provided scope. Specify a file path, directory, or glob pattern. Example: `/assay:harden src/` or `/assay:harden src/events/`."

Do not return an empty finding set without explanation.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Flag every catch block as a problem | Classify — many catches are correct and intentional |
| Ignore log-only catches | Evaluate whether the error needs recovery, not just logging |
| Treat all fallbacks as bad | Evaluate whether degradation is visible and documented |
| Skip resource lifecycle in test code | Test helpers leak resources too |
| Assume timeouts are always present | Verify each external call individually |
| Report cache concerns for request-scoped collections | Only flag persistent/growing collections |

## References

- `@skills/backend-quality/references/dimensions.md` — DIM-2 and DIM-7 definitions
- `@skills/backend-quality/references/findings-format.md` — finding output schema
- `@skills/harden/references/error-patterns.md` — silent catch taxonomy and error context checklist
- `@skills/harden/references/resilience-checklist.md` — resource management, timeouts, retries, concurrency checklist
