# PR Description Guidelines

Write PR descriptions that help reviewers understand the change quickly. Aim for ~120-200 words. CodeRabbit adds detailed analysis—focus on motivation and high-level changes.

## Title Format

`<type>: <what>` (max 72 chars)

Examples:
- `feat: Add knowledge ingestion workflow`
- `fix: Resolve null state in workflow steps`
- `refactor: Simplify token ledger interface`

## Body Structure

### Summary (required)
2-3 sentences explaining what changed and why it matters. Include the motivation—what problem does this solve?

### Changes (required)
Scannable list of key changes. Use `**Bold**` for component names and `—` (em-dash) as separator.

### Test Plan (required)
Brief description of testing approach. What was tested and how?

### Footer (required)
Separated by `---`. Contains results, design doc, and related PRs.

## Template

```markdown
## Summary

[2-3 sentences: What changed, why it matters, what problem it solves]

## Changes

- **Component 1** — Brief description of what changed
- **Component 2** — Brief description of what changed
- **Component 3** — Brief description of what changed

## Test Plan

[1-2 sentences: Testing approach and coverage summary]

---

**Results:** Tests X ✓ · Build 0 errors
**Design:** [design-doc.md](docs/path/design-doc.md)
**Related:** #123, Continues #456
```

## Example

```markdown
## Summary

Completes the Knowledge System foundation for RAG-based agent workflows. The platform needs to ingest documents, extract semantic concepts, and build a linked knowledge graph—this PR delivers that infrastructure.

## Changes

- **LLM Inference** — vLLM client with streaming SSE and LoRA adapter support
- **Token Accounting** — Multi-dimensional ledger tracking usage across categories
- **Vector Collections** — Registry with schema versioning for embedding spaces
- **Knowledge Models** — Core types for representing extracted knowledge
- **Ingestion Workflow** — 11-step pipeline from parsing to knowledge graph commit

## Test Plan

Added ~180 unit tests covering all new components. Integration tests verify the complete workflow with mocked dependencies.

---

**Results:** Tests 3462 ✓ · Build 0 errors
**Design:** [shared-infrastructure.md](docs/adrs/workflow-designs/shared-infrastructure.md)
**Related:** Continues #5
```

## Anti-Patterns

Avoid these—they bloat descriptions without adding value:

- Bullet lists of every file changed
- Repeating commit messages in the body
- Low-level implementation details (class names, method signatures)
- "Generated with..." footers
- Phase-by-phase breakdowns
- Detailed test counts by project
