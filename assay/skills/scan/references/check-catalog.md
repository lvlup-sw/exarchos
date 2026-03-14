# Check Catalog — Scan Execution Guidance

Scan-specific guidance for executing the deterministic checks defined in the canonical catalog at `@skills/backend-quality/references/deterministic-checks.md`. This document covers execution order, performance strategies, and result interpretation.

## Execution Order

Run checks from cheapest to most expensive. This lets you fail fast on simple violations before investing time in structural analysis.

1. **Simple grep patterns** (fast, single-pass text matching) — string literals, regex against individual files
2. **Multi-file grep patterns** (fast, but touches more files) — cross-file import checks, naming conventions
3. **Structural analysis** (slower, requires parsing or counting) — nesting depth, cyclomatic complexity proxies, file size checks
4. **Cross-reference checks** (slowest, requires building dependency graphs) — unused exports, circular imports, missing test coverage mapping

Within each tier, run checks in dimension order (DIM-1 through DIM-7) for predictable output grouping.

## Timeout Guidance

- **Per-check timeout:** 30 seconds for any individual grep or structural check. If a single pattern takes longer, report it as a timeout finding rather than blocking the entire scan.
- **Total scan timeout:** 5 minutes for a full "all dimensions" scan on a typical repository. For monorepos or very large codebases, recommend running dimension-by-dimension.
- **Early termination:** If a scope contains more than 10,000 files after exclusions, warn the user and suggest narrowing the scope before proceeding.

## Batch Strategies

Running patterns one at a time is wasteful when scanning large codebases. Use these strategies to reduce I/O overhead:

- **Combined grep:** Where multiple patterns target the same file set and dimension, combine them into a single grep invocation using alternation (`pattern1\|pattern2\|pattern3`). Parse the output to attribute matches back to individual checks.
- **File-type grouping:** Group checks by their `--include` glob (e.g., all `*.ts` checks together, all `*.py` checks together) to avoid re-traversing the directory tree.
- **Scope pre-filtering:** Resolve the file list once via `find` or glob expansion, then run all grep patterns against the pre-filtered list rather than letting each grep re-walk the tree.
- **Parallel execution:** When the check set is large, run independent dimension groups in parallel. D1 checks have no dependency on D3 checks, so they can execute concurrently.

## Default Exclusions

Always exclude these paths and file types from scanning unless the user explicitly overrides:

- `node_modules/` — third-party dependencies, not project code
- `dist/` — build output, generated from source
- `.git/` — version control internals
- `build/` — alternative build output directory
- `coverage/` — test coverage reports
- `*.min.js`, `*.min.css` — minified assets
- Binary files (images, fonts, compiled artifacts) — not scannable as text
- Generated files (`*.generated.ts`, `*.g.ts`, `*.pb.ts`) — produced by code generators, not authored

These exclusions prevent false positives from non-authored code and keep scan times reasonable.

## Interpreting Results

### True Positives

A match against a catalog pattern in authored code is a true positive. Report it with the full context: file path, line number, matched text, and the remediation hint from the catalog entry.

### False Positives

Some patterns intentionally cast a wide net. Common false positive scenarios:

- **Test files:** Patterns that detect anti-patterns in production code may match intentional test doubles or test assertions. The catalog should tag checks with `exclude-tests: true` where appropriate.
- **Comments and documentation:** A grep pattern may match a comment explaining why a pattern is avoided. Context lines (-B/-A) help the user distinguish these.
- **Legacy code with suppression markers:** If a file contains `// assay-ignore-next-line` or `// assay-ignore: <check-id>`, skip that specific match. This is the project-level false positive suppression mechanism.

When in doubt, report the match. It is better to surface a false positive that the user can dismiss than to silently hide a true violation. Users can add exclusions to `.assay/checks.md` to suppress recurring false positives.

### Zero Matches

A check that produces zero matches is a passing check. Record it in the summary as passed — this gives the user confidence that the dimension was actually evaluated, not just skipped.

## Cross-Reference

The canonical check definitions (patterns, dimensions, severities, remediation hints) live in `@skills/backend-quality/references/deterministic-checks.md`. This file is the single source of truth for what to check. The scan skill does not define its own patterns — it only defines how to execute them efficiently.
