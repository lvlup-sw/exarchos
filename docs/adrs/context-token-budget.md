# ADR: Context Token Budget

## Status
Accepted

## Context
Rules load into every Claude Code session as system prompt context. Minimizing fixed overhead preserves context window for actual work.

## Per-Rule Token Costs (After Optimization)

| Rule | Words | Est. Tokens | Scoped? | Notes |
|------|-------|-------------|---------|-------|
| coding-standards-csharp.md | 1,610 | ~2,093 | Yes | `**/*.cs` |
| coding-standards-typescript.md | 400 | ~520 | Yes | `**/*.ts`, `**/*.tsx` |
| mcp-tool-guidance.md | 1,164 | ~1,513 | No | always loaded |
| orchestrator-constraints.md | 132 | ~172 | No | always loaded (condensed; full in skill reference) |
| pr-descriptions.md | 133 | ~173 | No | always loaded (condensed; full in skill reference) |
| primary-workflows.md | 48 | ~62 | No | always loaded |
| rm-safety.md | 228 | ~296 | No | always loaded |
| skill-path-resolution.md | 225 | ~293 | No | always loaded |
| tdd-csharp.md | 305 | ~397 | Yes | `**/*.cs` |
| tdd-typescript.md | 212 | ~276 | Yes | `**/*.ts`, `**/*.tsx` |

**Scoped rules** (via `paths` frontmatter) only load when matching files are active:
- `tdd-typescript.md` — loads only with `**/*.ts`, `**/*.tsx`
- `coding-standards-typescript.md` — loads only with `**/*.ts`, `**/*.tsx`
- `tdd-csharp.md` — loads only with `**/*.cs`
- `coding-standards-csharp.md` — loads only with `**/*.cs`

## Before vs After

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| Always-loaded rule tokens | ~8,791 | ~2,508 | ~71% |
| With TypeScript scoping | ~8,791 | ~3,304 | ~62% |
| With C# scoping | ~8,791 | ~4,998 | ~43% |

"Before" = all original rules including workflow-auto-resume.md always loaded (no scoping, no pruning). Measured via `wc -w` on `main` branch × 1.3.
"After" = post-optimization with scoping, condensing, and pruning.

Before values (measured on `main` via `wc -w`):
- workflow-auto-resume.md: 1,090 words (~1,417 tokens) — removed entirely
- mcp-tool-guidance.md (original): 1,754 words (~2,280 tokens) — pruned Exarchos sections
- primary-workflows.md (original): 215 words (~280 tokens) — condensed to 3-line table
- pr-descriptions.md (original): 364 words (~473 tokens) — condensed, full in skill reference
- orchestrator-constraints.md (original): 362 words (~471 tokens) — condensed, full in skill reference
- tdd-typescript.md: 212 words (~276 tokens) — now scoped
- coding-standards-typescript.md: 400 words (~520 tokens) — now scoped
- rm-safety.md: 228 words (~296 tokens)
- skill-path-resolution.md: 225 words (~293 tokens)
- coding-standards-csharp.md: 1,610 words (~2,093 tokens) — now scoped
- tdd-csharp.md: 305 words (~397 tokens) — now scoped
Total before: 6,765 words (~8,791 tokens)

## Guidance for New Rules
- Budget: aim for total always-loaded overhead ≤ 5,000 tokens
- Scope with `paths` frontmatter when rule only applies to specific file types
- Move detailed content into skill `references/` for progressive disclosure
- Measure: `wc -w rules/new-rule.md` × 1.3 ≈ token cost

## Decision
Adopted progressive disclosure strategy: lean rules for always-on context, full content in skill references loaded on demand.
