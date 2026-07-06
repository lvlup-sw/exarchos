# Constraint anchoring — Constraints selection rules (design-time and evaluation-time)

This is the **single source of truth** for the "Constraints" step shared by `/ideate` (Phase 0), `/refactor` (brief phase), `/debug` (rca + design phases), and `/shepherd` (when evaluating PR feedback and composing fixes). Each surface loads this reference rather than duplicating the selection rules.

**Goal:** Surface the architectural invariants relevant to the work *before* committing to an approach or a change, so it is anchored to load-bearing constraints rather than re-discovering them mid-flight. Design-time surfaces (`/ideate`, `/refactor`, `/debug`) anchor the *proposal* before choosing an approach; `/shepherd` anchors the *changes it composes to address feedback* — same selection rules and devCatalog gating, applied at evaluation time instead of design time.

## Source of truth

Load `.exarchos/invariants.md` — the machine-readable catalog of `INV-*` invariants (event-sourcing integrity, facade equivalence, basileus-forward, platform-agnosticity, agent-first input/output/verbs/discriminator, workflow-agnosticism).

## Cost-of-load tiers — which entries to surface

The catalog tags every entry with a `cost-of-load` field. It governs whether an entry is part of the design-time baseline:

| `cost-of-load` | Surfaced at design-time? |
|---|---|
| `always-load` | **Yes** — the Constraints baseline. Surface every applicable always-load entry before the clarifying/brief/design step. |
| `reference-only` | Load **on demand** — re-read the same file with a topic-filtered scan only if the proposal's domain warrants it (e.g. capability-resolution or remote-MCP topics pull in `INV-3`; CLI-verb design pulls in `INV-5c`; composite-tool changes pull in `INV-5d`). Not part of the default baseline. |
| `archivable` | **No** — not surfaced. These exist for vocabulary-lint cross-reference only. |

## Selection rules — which invariants to surface as Constraints

| Proposal shape | Anchor invariants (minimum) |
|---|---|
| CLI command / agent surface / new MCP action | `INV-5a` (input ergonomics), `INV-5b` (output contract), `INV-5c` (Aspire-style verbs), `INV-5d` (action discriminator) |
| Event store / projection / workflow state | `INV-1` (event-sourcing integrity), `INV-2` (facade equivalence — if the projection feeds both adapters) |
| Skills / commands / runtime authoring | `INV-4` (platform-agnosticity), `INV-6` (workflow-agnosticism) |
| Basileus or cross-product coordination | `INV-3` (basileus-forward), `basileus-boundary` |
| Multi-surface design (most non-trivial proposals) | Union of the above rows that apply |

## Emit format (before the clarifying / brief / design step — or, for `/shepherd`, before composing fixes)

```markdown
## Constraints

Anchored to .exarchos/invariants.md:
- INV-5a: <one-sentence summary from the catalog>
- INV-5c: <one-sentence summary from the catalog>

(Probe the design against these.)
```

The `summary` field of each catalog entry is the canonical one-sentence form — reuse it verbatim so the surfaced Constraints stay in sync with the catalog as it evolves.

## Dev-only gating (v2)

The catalog at `.exarchos/invariants.md` is **dev-invariants only** — invariants for Exarchos's own designers, not for consumers using Exarchos as a plugin. The loader surfaces entries only when `.exarchos.yml: invariants.devCatalog: enabled` (default disabled). When this flag is unset or `disabled`, the design-time Constraints step surfaces no section from the dev catalog — proceed directly to the clarifying/brief/design step. Consumer-facing SDLC invariants live in a separate (future) catalog; see `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` §1.1 and §10 for the audience-scope rationale.
