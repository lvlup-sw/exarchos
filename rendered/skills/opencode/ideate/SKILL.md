---
name: ideate
description: "Explore a design with the user and write Design & Rationale in one local spec. Triggers: brainstorm, ideate, or explore options. Continue to plan to decompose the same file."
metadata:
  author: exarchos
  version: 2.0.0
  category: workflow
  phase-affinity: plan
---

# Design exploration

Write the Design & Rationale section in `docs/specs/YYYY-MM-DD-<feature>.md`. Use the [unified spec template](@skills/plan/references/spec-template.md). For a walkthrough, see `references/worked-example.md`.

## Constraint anchoring

Before asking questions, check the registered invariants catalog. In this repository, `.exarchos/invariants.md` holds the CLI design constraints `INV-5a` and `INV-5c`. Surface the applicable constraints using `references/constraint-anchoring.md`. Read registered catalog files from the checkout.

## Understand the problem

Ask one question at a time about the goal, constraints, existing patterns, consumers and observable success. Ask at most five questions before proposing a design. Agree on the authoring depth with the user.

| Depth | Design work |
| --- | --- |
| `thin` | Write the problem and numbered requirements with testable acceptance criteria. |
| `standard` (default) | Add the chosen approach, technical design, integration points and relevant alternatives. |
| `deep` | Add exploration of two or three distinct approaches with their trade-offs. |

For deep work, use `references/design-template.md`. Research the question locally and save the findings in a research note. Cite its path and a matching `correlationId` under `### Exploration`. Record that identifier in the note too. After three rounds without agreement, summarize the trade-offs for a decision. Honor a user-supplied iteration limit.

## Save and continue

Write numbered `DR-N` headings under `## Design & Rationale`. Give each requirement concrete acceptance criteria and cover relevant failure cases. Save the file, verify it exists, and pass its checkout-relative path as `$SPEC_PATH` to plan. Set `$DESIGN_DEPTH` to the selected depth. Pass it as the second argument.

```typescript
[Invoke the exarchos:plan skill with args: $SPEC_PATH $DESIGN_DEPTH]
```
