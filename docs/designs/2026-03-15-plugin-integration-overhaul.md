# Plugin Integration Overhaul — MCP-Served Check Catalogs

**Issue:** #1046
**Date:** 2026-03-15
**Status:** Design

## Summary

Make companion plugin quality checks platform-agnostic by serving check catalogs as structured data from the MCP server. Any LLM agent on any platform can execute the catalog's checks and feed findings back to the verdict computation. Axiom and impeccable remain skill libraries — they enhance depth on platforms that support skills (Claude Code, Cursor) but are not required for baseline quality coverage.

## Problem

The quality-review skill instructs the reviewer subagent to invoke `axiom:audit` and `impeccable:critique` via the `Skill()` tool. The reviewer subagent has no Skill access (`tools: [Read, Grep, Glob, Bash]`). On Claude Code, even moving Skill invocation to the orchestrator only helps Claude Code users. Cursor, standalone CLI, and generic MCP clients get zero companion plugin value — quality review degrades to D1-D5 exarchos-native gates only.

## Design

### Architecture: Three Tiers

```
Any MCP client (Claude Code, Cursor, generic)
    │
    ├── Tier 1: MCP Gates (always, automated)
    │   ├── check_static_analysis (D2)
    │   ├── check_security_scan (D1)
    │   └── check_operational_resilience (D4)
    │
    ├── Tier 2: MCP-Served Check Catalog (always, agent-executed)
    │   ├── prepare_review → returns check catalog as structured data
    │   ├── Agent executes grep patterns and heuristic instructions
    │   ├── Agent feeds findings to check_review_verdict
    │   └── Covers: error handling, type safety, test quality,
    │       code hygiene, structural complexity, resilience
    │
    ├── Tier 3: Skill Enhancement (platform-dependent)
    │   ├── axiom:audit — deeper qualitative backend analysis (7 dimensions)
    │   ├── impeccable:critique — design quality analysis
    │   └── Only on platforms with skill support (Claude Code, Cursor)
    │
    └── Verdict: check_review_verdict merges ALL findings → APPROVED | NEEDS_FIXES
```

### DR-1: `prepare_review` Orchestrate Action

New action in `servers/exarchos-mcp/src/orchestrate/prepare-review.ts`.

**Input:**
```typescript
{
  featureId: string;
  scope?: string;            // directory or file glob (default: repo root)
  dimensions?: string[];     // filter (default: all)
}
```

**Output:**
```typescript
{
  catalog: {
    version: string;
    dimensions: Array<{
      id: string;            // "error-handling", "type-safety", etc.
      name: string;
      checks: Array<{
        id: string;          // "EH-1", "TS-1", etc.
        execution: "grep" | "structural" | "heuristic";
        severity: "HIGH" | "MEDIUM" | "LOW";
        description: string;
        // For grep/structural checks:
        pattern?: string;    // regex
        fileGlob?: string;   // "*.ts", "*.tsx"
        multiline?: boolean;
        // For structural checks:
        threshold?: number;  // e.g., max nesting depth
        // For all:
        remediation: string;
        falsePositives: string;
      }>;
    }>;
  };
  findingFormat: string;     // TypeScript interface for findings
  pluginStatus: {
    axiom: { enabled: boolean; hint?: string };
    impeccable: { enabled: boolean; hint?: string };
  };
}
```

**Behavior:**
1. Read `.exarchos.yml` plugins config via resolved config
2. Filter catalog by requested dimensions (if provided)
3. Return catalog + plugin status + finding format specification

The catalog is static data embedded in the MCP server, versioned with exarchos. It is NOT a copy of axiom's catalog — it is exarchos's own baseline quality check set.

### DR-2: Check Catalog

New module at `servers/exarchos-mcp/src/review/check-catalog.ts`.

Defines ~20 deterministic checks across 6 quality dimensions:

| Dimension | ID Prefix | Checks | Source |
|-----------|-----------|--------|--------|
| Error Handling | EH | Empty catches, swallowed promises, console-only handling | Exarchos-native |
| Type Safety | TS | Unsafe assertions, non-null assertions | Exarchos-native |
| Test Quality | TQ | Skipped tests, mock-heavy tests | Exarchos-native |
| Code Hygiene | CH | Commented-out code, TODO/FIXME accumulation | Exarchos-native |
| Structural Complexity | SC | Deep nesting, long functions, god objects | Exarchos-native |
| Resilience | RS | Unbounded collections, missing timeouts, unbounded retries | Exarchos-native |

Each check includes: pattern (grep regex or structural heuristic), severity, description, remediation guidance, and false-positive notes.

The catalog is a TypeScript constant — no file I/O at runtime. Extensible via `.exarchos.yml` in future (out of scope for this PR).

### DR-3: Extend `check_review_verdict`

Extend the existing action in `servers/exarchos-mcp/src/orchestrate/review-verdict.ts`.

**New optional parameter:**
```typescript
pluginFindings?: Array<{
  source: string;            // "catalog" | "axiom" | "impeccable" | custom
  severity: "HIGH" | "MEDIUM" | "LOW";
  dimension?: string;        // e.g., "error-handling", "DIM-1"
  file?: string;
  line?: number;
  message: string;
}>;
```

**Behavior:**
- Count HIGH/MEDIUM/LOW from `pluginFindings` and ADD to the existing `high`, `medium`, `low` counts
- Include source attribution in the gate event data
- Verdict logic is unchanged — merged counts determine outcome

### DR-4: Config Resolution

Update `servers/exarchos-mcp/src/config/resolve.ts`:

- Add `plugins` to `ResolvedProjectConfig` interface
- Resolve defaults: `{ axiom: { enabled: true }, impeccable: { enabled: true } }`
- `prepare_review` reads resolved config to populate `pluginStatus`

### DR-5: Content Layer Updates

Already partially done (polish track). Finalize:

1. **`skills/quality-review/SKILL.md`** — Add `prepare_review` as Step 0.5 (between spec-review check and static analysis). Subagent calls `prepare_review`, executes catalog checks, collects findings, feeds to `check_review_verdict`.

2. **`commands/review.md`** — Tier 2 section updated: orchestrator invokes `prepare_review` and passes catalog to quality-review subagent. Tier 3 section: orchestrator invokes axiom/impeccable Skills if available, feeds additional findings to verdict.

3. **`skills/quality-review/references/axiom-integration.md`** — Architecture diagram updated to show three-tier model with MCP-served catalog.

### DR-6: Namespace Validation

Already done (polish track): regex updated from `(?!exarchos:)` to `(?![a-z][-a-z]*:)` to allow companion plugin namespaces.

## Design Requirements

| ID | Requirement |
|----|------------|
| DR-1 | New `prepare_review` orchestrate action serves check catalog as structured data |
| DR-2 | Check catalog covers 6+ dimensions with 15+ deterministic checks |
| DR-3 | `check_review_verdict` accepts optional `pluginFindings` array |
| DR-4 | `plugins` resolved in project config at runtime |
| DR-5 | Content layer references `prepare_review` in review workflow |
| DR-6 | Namespace validation allows companion plugin prefixes |

## Non-Goals

- Copying axiom's exact check catalog — exarchos defines its own baseline
- Making axiom or impeccable MCP servers — they remain skill libraries
- Auto-detecting installed plugins at filesystem level — config + platform adapter handles this
- Custom user-defined checks in `.exarchos.yml` — future enhancement
- Design quality checks in the catalog — impeccable covers this when available

## Test Strategy

- `check-catalog.test.ts`: Validate catalog structure, dimension coverage, pattern compilability
- `prepare-review.test.ts`: Handler returns catalog, respects dimension filter, includes plugin status from config
- `review-verdict.test.ts`: Extended tests for `pluginFindings` parameter — finding merge, count aggregation, source attribution in events
- `resolve.test.ts`: Plugins section resolved with defaults
- Existing tests: All pass without modification (DR-6 already done)
