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
| orchestrator-constraints.md | 362 | ~471 | No | always loaded |
| pr-descriptions.md | 364 | ~473 | No | always loaded |
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
| Always-loaded rule tokens | ~11,000 | ~3,108 | ~72% |
| With TypeScript scoping | ~11,000 | ~3,904 | ~65% |

"Before" = all original rules including workflow-auto-resume.md loaded always (no scoping, no pruning).
"After" = post-optimization with scoping, condensing, and pruning.

For "Before" values, these known word counts were used:
- workflow-auto-resume.md: ~1,700 words (~2,210 tokens) — removed entirely
- mcp-tool-guidance.md (original): ~2,460 words (~3,200 tokens) — pruned Exarchos sections
- primary-workflows.md (original): ~258 words (~336 tokens) — condensed to 3-line table
- pr-descriptions.md (original): ~518 words (~674 tokens)
- orchestrator-constraints.md (original): ~485 words (~630 tokens)
- tdd-typescript.md: ~335 words (~436 tokens) — now scoped
- coding-standards-typescript.md: ~520 words (~676 tokens) — now scoped
- rm-safety.md: ~295 words (~384 tokens)
- skill-path-resolution.md: ~315 words (~410 tokens)
- coding-standards-csharp.md: ~2,300 words (~2,990 tokens) — now scoped
- tdd-csharp.md: ~370 words (~481 tokens) — now scoped
Total before: ~9,556 words (~12,427 tokens)

## Guidance for New Rules
- Budget: aim for total always-loaded overhead ≤ 5,000 tokens
- Scope with `paths` frontmatter when rule only applies to specific file types
- Move detailed content into skill `references/` for progressive disclosure
- Measure: `wc -w rules/new-rule.md` × 1.3 ≈ token cost

## Decision
Adopted progressive disclosure strategy: lean rules for always-on context, full content in skill references loaded on demand.
