# Assay — Backend Quality Plugin

Composable backend quality skills for systematic architectural health assessment. The backend counterpart to impeccable's frontend design quality.

## Skills

| Skill | Purpose | Dimensions |
|-------|---------|-----------|
| `assay:audit` | Comprehensive backend audit (orchestrator) | All |
| `assay:critique` | Architecture review: SOLID, coupling, dependencies | Architecture, Topology |
| `assay:harden` | Error handling, resilience, observability | Observability, Resilience |
| `assay:distill` | Dead code, vestigial patterns, simplification | Hygiene, Topology |
| `assay:verify` | Test quality, mock fidelity, contract drift | Test Fidelity, Contracts |
| `assay:scan` | Deterministic pattern detection (grep/structural) | Pluggable (any) |

## Quality Dimensions

Seven canonical dimensions (DIM-1 through DIM-7) defined in `skills/backend-quality/references/dimensions.md`.

## Usage

Run individual skills for targeted assessment, or `assay:audit` for comprehensive analysis. All skills accept a `scope` argument (file, directory, or codebase).

## Integration

This plugin is standalone — no workflow dependencies. Workflow tools can consume findings via the standard finding format documented in `skills/backend-quality/references/findings-format.md`.
