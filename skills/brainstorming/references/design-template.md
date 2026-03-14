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

## Requirements

### DR-1: [Requirement name]

[Description of the requirement]

**Acceptance criteria:**
- [Criterion 1]
- [Criterion 2]

### DR-2: [Requirement name]

[Description]

**Acceptance criteria:**
- [Criterion 1]
- [Criterion 2]

### DR-N: Error handling and edge cases

[Error/failure/boundary conditions]

**Acceptance criteria:**
- [Error case 1]
- [Edge case 1]

## Technical Design
[Implementation details, data structures, APIs]

## Integration Points
[How this connects to existing code]

## Testing Strategy
[How we'll verify it works]

## Open Questions
[Decisions deferred or needing input]
```

### Requirement Format Rules

- **Numbered IDs:** Use `DR-N` (Design Requirement) format. `REQ-N` and `R-N` are also accepted.
- **Acceptance criteria:** Every requirement MUST have a `**Acceptance criteria:**` block with concrete, testable criteria.
- **Structured criteria preferred:** For behavioral requirements, use Given/When/Then format. These become executable acceptance tests during planning:
  ```markdown
  **Acceptance criteria:**
  - Given [precondition]
    When [action]
    Then [expected outcome]
    And [additional outcome]
  ```
  Bullet-point criteria are still valid for non-behavioral requirements (performance constraints, configuration, etc.).
- **Error/edge cases:** At least one requirement must address error handling, failure modes, or boundary conditions. Don't design only the happy path.
- **Provenance anchors:** These DR-N identifiers become traceability anchors — implementation plans map tasks to them (`Implements: DR-1`), and the feature audit traces code and tests back to them.

## Exploration Quality Gate

Stop Phase 2 when ALL are true:
- [ ] 2-3 approaches documented
- [ ] Each answers design questions from Phase 1
- [ ] Approaches differ in at least 2 of: {data structure, API design, complexity}
- [ ] Trade-offs are honest and specific
- [ ] One approach recommended with rationale
