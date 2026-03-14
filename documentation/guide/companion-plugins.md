---
outline: deep
---

# Companion Plugins

Companion plugins are standalone Claude Code plugins that add quality dimensions to Exarchos reviews. They install separately and integrate automatically -- no configuration required.

## Available plugins

### axiom (backend quality)

Seven dimensions covering general backend code quality:

| Dimension | Scope |
|-----------|-------|
| DIM-1 Topology | Module boundaries, dependency direction, coupling |
| DIM-2 Observability | Logging, metrics, tracing coverage |
| DIM-3 Contracts | API schemas, type safety at boundaries |
| DIM-4 Test Fidelity | Test isolation, assertion quality, coverage gaps |
| DIM-5 Hygiene | Dead code, TODOs, lint suppressions, formatting |
| DIM-6 Architecture | Pattern consistency, layer violations |
| DIM-7 Resilience | Error handling, retry logic, timeout coverage |

Install:

```bash
claude plugin add lvlup-sw/axiom
```

### impeccable (frontend design quality)

Covers design and UI concerns:

- UI consistency -- component reuse, spacing systems, visual rhythm
- Accessibility -- ARIA, keyboard navigation, color contrast
- Design system compliance -- token usage, component variants
- Responsive design -- breakpoints, layout shifts, touch targets

Install:

```bash
claude plugin add lvlup-sw/impeccable
```

## How detection works

Zero-config. During review, Exarchos checks whether the `axiom:audit` and `impeccable:critique` skills are available. If a skill is present (meaning the plugin is installed), Exarchos invokes it and merges the findings into the review.

No skill detected? Exarchos skips it silently. No errors, no warnings. The review runs with its native dimensions only.

## Configuration override

Both plugins are enabled by default when installed. To disable one, add a `plugins` section to `.exarchos.yml`:

```yaml
plugins:
  axiom:
    enabled: true
  impeccable:
    enabled: false
```

This is per-project. A backend-only repo might disable impeccable. A project happy with native dimensions can disable both.

## Dimension ownership

Each quality dimension belongs to exactly one owner:

| Owner | Dimensions |
|-------|-----------|
| axiom (optional) | DIM-1 Topology, DIM-2 Observability, DIM-3 Contracts, DIM-4 Test Fidelity, DIM-5 Hygiene, DIM-6 Architecture, DIM-7 Resilience |
| impeccable (optional) | UI consistency, accessibility, design system compliance, responsive design |
| exarchos (always) | D1 Spec Fidelity & TDD, D2 Static Analysis, D3 Context Economy, D5 Workflow Determinism |

Exarchos native dimensions (D1-D5) always run. Plugin dimensions only run when the plugin is installed and enabled.

## Three-tiered review model

What you get depends on what's installed:

**MCP-only (any client, no Claude Code):**
Exarchos native dimensions D1-D5. Convergence gates, verdicts, fix cycles. The full workflow engine minus the content layer.

**Claude Code (Exarchos plugin only):**
Everything above, plus skills, commands, agents, hooks, and the runbook protocol. The review process follows the two-stage structure (spec compliance, then code quality) with automated fixer dispatch.

**Claude Code + companion plugins:**
Everything above, plus axiom's 7 backend dimensions and impeccable's design quality checks. Plugin findings merge with native findings before verdict computation. All plugin findings are informational and do not add new blocking gates.
