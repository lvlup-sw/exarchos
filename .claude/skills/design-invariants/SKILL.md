---
name: design-invariants
description: "Audit a design proposal or diff against Exarchos's architectural invariants — event-sourcing integrity (INV-1), facade equivalence over shared dispatch core (INV-2), basileus-forward (INV-3), platform-agnosticity (INV-4), and agent-first interface design (INV-5a input ergonomics, INV-5b spec-aligned output contract, INV-5c Aspire-inspired control-plane verbs, INV-5d action discriminator pattern). Pairs with /axiom:backend-quality — this skill is project-specific (axiom is generic). Triggers: 'check invariants', 'design conformance', 'check #1118 / #1109', or /design-invariants."
metadata:
  author: exarchos
  version: 0.1.0
  category: review
  pairs-with: axiom:backend-quality
  source: docs/research/2026-05-07-design-invariants-skill.md
---

# Design Invariants Skill

Audits a design proposal or diff against Exarchos-specific architectural invariants. Project-scoped — these invariants govern Exarchos itself, not consumers of the Exarchos plugin.

The skill is the operational complement to issue [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) (codify principles) and [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (cross-cutting constraints). Reference content is also a candidate to back the v2.11.0 [#1275](https://github.com/lvlup-sw/exarchos/issues/1275) (MCP Resources) surface and the [#1260](https://github.com/lvlup-sw/exarchos/issues/1260) machine-readable invariants generator — every invariant carries a stable ID and structured shape.

## When to use

- During `/exarchos:ideate` or `/exarchos:plan`, before committing a design.
- During `/exarchos:review`, alongside `/axiom:audit`.
- When reviewing a PR that touches the event store, MCP surface, runtime YAML, or composite tool registry.

## When NOT to use

- For generic backend quality — use `/axiom:*` skills (see complementarity matrix below).
- For TDD / spec compliance — use `/exarchos:review` or the `spec-review` skill.
- For prose / AI-writing tells — use `/axiom:humanize`.

## How to invoke

1. State the artifact under review (design path, diff range, or PR URL).
2. Walk INV-1..INV-5 in order, recording HIGH/MEDIUM/LOW findings per invariant.
3. For INV-5, walk all four sub-disciplines (5a input ergonomics, 5b output contract, 5c Aspire verbs, 5d action discriminator).
4. Cross-link any axiom finding that overlaps (e.g., a topology issue under INV-1 may also be DIM-1).
5. Output the same finding format as axiom (severity + dimension + file:line + description + required_fix).

## Invariant references

- INV-1 → [references/INV-1-event-sourcing.md](references/INV-1-event-sourcing.md)
- INV-2 → [references/INV-2-facade-equivalence.md](references/INV-2-facade-equivalence.md)
- INV-3 → [references/INV-3-basileus-forward.md](references/INV-3-basileus-forward.md)
- INV-4 → [references/INV-4-platform-agnosticity.md](references/INV-4-platform-agnosticity.md)
- INV-5a → [references/INV-5a-input-ergonomics.md](references/INV-5a-input-ergonomics.md)
- INV-5b → [references/INV-5b-output-contract.md](references/INV-5b-output-contract.md)
- INV-5c → [references/INV-5c-aspire-verbs.md](references/INV-5c-aspire-verbs.md)
- INV-5d → [references/INV-5d-action-discriminator.md](references/INV-5d-action-discriminator.md)
- Deterministic checks → [references/deterministic-checks.md](references/deterministic-checks.md)

## Finding format

Match axiom's vocabulary (HIGH / MEDIUM / LOW) so reviewers don't context-switch:

```json
{
  "verdict": "pass | conditional | fail",
  "findings": [
    {
      "invariant": "INV-1",
      "severity": "HIGH",
      "file": "servers/exarchos-mcp/src/projections/foo.ts",
      "line": 42,
      "description": "Reducer mutates state in place inside the apply switch",
      "required_fix": "Return a new state object via spread; deep-freeze input via assertReducerImmutable in tests",
      "axiom_overlap": "DIM-1"
    }
  ]
}
```

## Pairing with axiom — complementarity matrix

The seam: axiom asks *"is this code well-engineered?"*; this skill asks *"does this design respect Exarchos's load-bearing invariants?"* A design can be axiom-clean and still violate event-sourcing integrity (a perfectly well-typed handler that mutates state in place instead of emitting events).

| Finding | Axiom dimension | Design invariant |
|---|---|---|
| Lazy fallback that creates degraded EventStore | DIM-1 Topology | INV-1 (silent loss of event integrity) |
| Hardcoded `Skill({...})` in skills-src | — | INV-4 |
| `console.log`-only catch in projection apply | DIM-2 Observability | INV-1 (fold throws → must trigger reducer-throw degradation path) |
| New CLI verb without MCP equivalent | — | INV-2 |
| Adapter-local mutable cache for projection state | DIM-1 Topology | INV-1 + INV-2 (TaskStore-as-side-database anti-pattern) |
| `runtimes/claude.yaml` field read at runtime | — | INV-3 |
| Tool description without "do NOT use for" guidance | — | INV-5a |
| Successful `ToolResult` without `next_actions` | — | INV-5b |
| Long-running op using NDJSON post-v2.11.0 | — | INV-5b (should use Tasks SEP-1686) |
| New top-level tool that should be an action on `exarchos_workflow` | — | INV-5d |
| Schema field removed but still read | DIM-3 Contracts | INV-1 if it's an event field |

Concerns axiom owns and this skill defers to:

| Concern | Owner |
|---|---|
| Generic SOLID, coupling, dependency direction (DIM-6) | `axiom:critique` |
| Generic error handling, silent fallbacks (DIM-2, DIM-7) | `axiom:harden` |
| Generic schema-runtime drift, type-assertion safety (DIM-3) | `axiom:scan`, `axiom:critique` |
| Generic test fidelity, mock overuse (DIM-4) | `axiom:verify` |
| Generic dead code, vestigial patterns (DIM-5) | `axiom:distill` |
| AI-prose tells (DIM-8) | `axiom:humanize` |

## Source

Discovery report: [`docs/research/2026-05-07-design-invariants-skill.md`](../../../docs/research/2026-05-07-design-invariants-skill.md). Amend this skill when the principles doc per #1118 lands at `docs/architecture/principles.md` — the skill becomes the operational projection of that doc rather than re-stating principles.
