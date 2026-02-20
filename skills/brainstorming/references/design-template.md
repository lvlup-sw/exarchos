# Design Document Template

Save to: `docs/designs/YYYY-MM-DD-<feature>.md`

## Approach Format (Phase 2)

Present 2-3 approaches using this format:

```markdown
### Option [N]: [Name]

**Approach:** [2-3 sentence description]

**Pros:**
- [Benefit 1]
- [Benefit 2]

**Cons:**
- [Drawback 1]
- [Drawback 2]

**Best when:** [Scenario where this option excels]
```

Rules:
- Present genuinely different approaches (not variations of same idea)
- Be honest about trade-offs
- Include at least one "simple but limited" option
- Include at least one "flexible but complex" option
- Recommend one option but explain why

## Design Document Structure (Phase 3)

Write sections of 200-300 words maximum. Use diagrams (ASCII or Mermaid) for complex flows. Reference existing codebase patterns.

```markdown
# Design: [Feature Name]

## Problem Statement
[What we're solving and why]

## Chosen Approach
[Selected option with rationale]

## Technical Design
[Implementation details, data structures, APIs]

## Integration Points
[How this connects to existing code]

## Testing Strategy
[How we'll verify it works]

## Open Questions
[Decisions deferred or needing input]
```

## Exploration Quality Gate

Stop Phase 2 when ALL are true:
- [ ] 2-3 approaches documented
- [ ] Each answers design questions from Phase 1
- [ ] Approaches differ in at least 2 of: {data structure, API design, complexity}
- [ ] Trade-offs are honest and specific
- [ ] One approach recommended with rationale
