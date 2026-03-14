# Finding Format

All assay skills emit findings in a shared schema. This enables composition, deduplication, and aggregation across skills.

## Finding Schema

```typescript
interface Finding {
  dimension: string;        // DIM-1 through DIM-7 (see dimensions.md)
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;            // Short description, <100 characters
  evidence: string[];       // file:line references (e.g., ["src/store.ts:42", "src/store.ts:87"])
  explanation: string;      // What's wrong for context (2-4 sentences)
  suggestion?: string;      // How to fix, when actionable (optional)
  skill: string;            // Which skill produced this (e.g., "critique", "harden")
  deterministic: boolean;   // true if found by scan, false if qualitative assessment
}
```

## Severity Tiers

| Tier | Definition | Action |
|------|-----------|--------|
| **HIGH** | Violates correctness invariant, risks data loss, or causes silent failure. The system may appear to work but produces incorrect results. | Must fix before merge. |
| **MEDIUM** | Degrades quality, maintainability, or performance but doesn't break correctness. The system works correctly but is harder to change or operate. | Should fix. May defer with documented rationale. |
| **LOW** | Polish, minor inefficiencies, aspirational improvements. The system works well but could be better. | Track for future. Don't block. |

## Output Format

Skills present findings as a Markdown list grouped by severity:

```markdown
## Findings

### HIGH

- **[DIM-1] Lazy fallback creates degraded EventStore** (deterministic)
  - Evidence: `src/events/tools.ts:15`, `src/events/tools.ts:42`
  - `getStore()` creates an in-memory instance when the configured store isn't available, causing events to be invisible to other modules.
  - Suggestion: Remove fallback; fail fast if store isn't configured.

### MEDIUM

- **[DIM-2] Empty catch block hides initialization errors** (qualitative)
  - Evidence: `src/config/loader.ts:88`
  - Configuration errors are caught and silently ignored, falling back to defaults. This hides broken configuration that may cause subtle behavioral differences.
  - Suggestion: Log the error with context, or re-throw if configuration is required.

### LOW

(none)
```

## Deduplication Rules

When `audit` aggregates findings from multiple skills:

1. **Same evidence + same dimension** → merge into a single finding (keep the most detailed explanation)
2. **Same evidence + different dimensions** → keep both (the finding genuinely spans two concerns)
3. **Same pattern + different files** → keep as separate findings (each location needs attention)
4. **Deterministic + qualitative for same issue** → merge, mark as `deterministic: true` (the mechanical check grounds the qualitative assessment)
