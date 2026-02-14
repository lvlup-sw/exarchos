# PR Description Guidelines

Write PR descriptions that help reviewers understand the change quickly. Aim for ~120-200 words.

## Title Format

`<type>: <what>` (max 72 chars)

## Body Structure

- **Summary** (required) — 2-3 sentences: what changed, why it matters
- **Changes** (required) — Scannable list with `**Bold**` component names and `—` separator
- **Test Plan** (required) — Testing approach and coverage summary
- **Footer** (required) — Separated by `---`: results, design doc, related PRs

## Template

```markdown
## Summary
[2-3 sentences: What changed, why it matters, what problem it solves]

## Changes
- **Component** — Brief description of what changed

## Test Plan
[1-2 sentences: Testing approach and coverage summary]

---
**Results:** Tests X ✓ · Build 0 errors
**Design:** [doc](docs/path/design-doc.md)
**Related:** #123
```

For detailed guidelines, examples, and anti-patterns, see `skills/synthesis/references/pr-descriptions.md`.
