---
name: backend-quality
description: "Core reference skill defining the backend quality dimension taxonomy, finding format, scoring model, and deterministic check catalog. Not user-invokable — referenced by all assay skills as the shared foundation."
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: reference
  dimensions:
    - all
---

# Backend Quality — Foundation Reference

This skill defines the shared foundation for all assay backend quality skills. It is NOT user-invokable — it exists to be referenced by the specialized skills.

## Dimension Taxonomy

Seven canonical quality dimensions: `@skills/backend-quality/references/dimensions.md`

| ID | Name | What it assesses |
|----|------|-----------------|
| DIM-1 | Topology | Dependency graphs, wiring, ambient state |
| DIM-2 | Observability | Error visibility, logging, failure transparency |
| DIM-3 | Contracts | Schema integrity, API consistency, type safety |
| DIM-4 | Test Fidelity | Test-production divergence, mock quality |
| DIM-5 | Hygiene | Dead code, vestigial patterns, evolutionary leftovers |
| DIM-6 | Architecture | SOLID, coupling, cohesion, dependency direction |
| DIM-7 | Resilience | Resource management, timeouts, failure handling |

## Finding Format

Standard schema for all skill output: `@skills/backend-quality/references/findings-format.md`

## Scoring Model

Verdict computation and health thresholds: `@skills/backend-quality/references/scoring-model.md`

## Deterministic Checks

Grep patterns and structural checks per dimension: `@skills/backend-quality/references/deterministic-checks.md`
