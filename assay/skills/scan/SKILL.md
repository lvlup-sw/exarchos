---
name: scan
description: "Run deterministic pattern checks against backend code. Use when you need mechanical detection of known anti-patterns, code smells, or structural issues. Triggers: 'scan code', 'check patterns', 'run checks', or /assay:scan. Do NOT use for qualitative architecture review — use assay:critique instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - pluggable
---

# Scan Skill

## Overview

Deterministic check engine that runs grep patterns and structural analysis against backend code. Accepts a `scope` argument (file path, directory path, or cwd) and a `dimensions` argument (comma-separated dimension list or "all") to control which checks execute.

This skill performs purely mechanical detection — it matches known patterns, counts structural violations, and reports findings with exact file locations. It does not make qualitative judgments about architecture or design. Other skills (like `assay:critique`) handle subjective assessment and invoke `scan` when they need deterministic evidence.

See `@skills/scan/references/check-catalog.md` for scan-specific execution guidance including ordering, batching, and exclusions.

## Triggers

Activate this skill when:
- User says "scan code", "check patterns", "run checks", or "detect anti-patterns"
- User runs `/assay:scan`
- Another assay skill requests deterministic pattern detection
- User wants mechanical verification of known code smells

Do not activate this skill when:
- User wants qualitative architecture review — use `assay:critique` instead
- User wants a full quality audit — use `assay:audit` instead
- User needs subjective design feedback rather than pattern matching

## Process

### Step 1: Load Check Catalog

Load the canonical check definitions from `@skills/backend-quality/references/deterministic-checks.md`. This file defines every grep pattern, structural check, and their associated dimensions and severities.

### Step 2: Load Project-Specific Checks (Optional)

If `.assay/checks.md` exists in the project root, load additional project-specific check definitions. These follow the same format as the canonical catalog and are merged into the check set. If the file does not exist, silently skip this step.

### Step 3: Filter by Requested Dimensions

Apply the `dimensions` argument to filter the merged check set:
- If `dimensions` is `"all"` or omitted, run every check in the catalog
- If `dimensions` is a comma-separated list (e.g., `"topology,observability"`), only run checks tagged with those dimensions
- Invalid dimension names produce an actionable error message listing valid dimensions

### Step 4: Execute Checks

For each check in the filtered set, run the grep or structural pattern against the resolved `scope`:
- Execute grep patterns using the exact expressions from the catalog
- Run structural analysis checks (file counts, nesting depth, import graphs)
- Collect all matches with file path, line number, and matched content
- Record checks that produced zero matches as passing

### Step 5: Format Findings

Format each match as a finding per `@skills/backend-quality/references/findings-format.md`. Every finding produced by this skill is marked `deterministic: true` to distinguish mechanical detections from qualitative assessments.

### Step 6: Group and Output

Output findings grouped by dimension, then by severity (HIGH, MEDIUM, LOW) within each dimension. Include:
- Total checks run and total findings
- Per-dimension summary with finding counts
- Individual findings with file location, matched pattern, and remediation hint

## Error Handling

- **Invalid patterns:** If a grep pattern from the catalog fails to compile or execute, report the specific pattern and error message. Do not silently skip — the user needs to know which check is broken so they can fix the catalog entry.
- **Empty scope:** If the resolved scope contains no files to scan (empty directory, nonexistent path), return a "nothing to scan" message with the resolved path. Do not treat this as a failure.
- **Missing `.assay/checks.md`:** Silently skip project-specific check loading. This file is optional and its absence is expected for projects that have not customized their check set.
- **Permission errors:** If a file cannot be read due to permissions, log the file path and continue scanning remaining files.

## Output Format

All findings use the standard format from `@skills/backend-quality/references/findings-format.md` with one addition: every finding includes `deterministic: true` to signal that it was produced by mechanical pattern matching, not qualitative judgment.

```yaml
dimension: observability
severity: MEDIUM
deterministic: true
file: src/handlers/query.ts
line: 42
pattern: readEvents
match: "const items = await readEvents(stream)"
remediation: "Move raw event reads out of query handlers — use a read model projection instead"
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Make qualitative judgments about matches | Report the match and let critique/review skills interpret |
| Skip checks that produce many matches | Report all matches — downstream skills handle prioritization |
| Suppress false positives silently | Report them and let the user tune exclusions in `.assay/checks.md` |
| Run checks outside the requested scope | Respect the scope boundary strictly |
| Invent patterns not in the catalog | Only run checks defined in the canonical or project-specific catalogs |
