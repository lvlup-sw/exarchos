# Implementation Plan: Plugin Integration Overhaul

**Design:** `docs/designs/2026-03-15-plugin-integration-overhaul.md`
**Workflow:** `refactor-plugin-integration-overhaul`
**Track:** Overhaul (TDD)

## Task Overview

```
                    ┌──────────┐     ┌──────────┐     ┌──────────┐
                    │ Task 001 │     │ Task 002 │     │ Task 003 │
                    │ Catalog  │     │ Config   │     │ Verdict  │
                    │ (DR-2)   │     │ (DR-4)   │     │ (DR-3)   │
                    └────┬─────┘     └────┬─────┘     └────┬─────┘
                         │                │                │
                         └───────┬────────┘                │
                                 │                         │
                           ┌─────┴──────┐                  │
                           │  Task 004  │                  │
                           │  Prepare   │                  │
                           │  (DR-1)    │                  │
                           └─────┬──────┘                  │
                                 │                         │
                                 └────────┬────────────────┘
                                          │
                                    ┌─────┴──────┐
                                    │  Task 005  │
                                    │  Wiring    │
                                    │  (DR-1,3)  │
                                    └─────┬──────┘
                                          │
                                    ┌─────┴──────┐
                                    │  Task 006  │
                                    │  Content   │
                                    │  (DR-5,6)  │
                                    └────────────┘
```

**Parallel groups:**
- **Group A** (parallel): Tasks 001, 002, 003
- **Group B** (sequential after A): Task 004 (depends on 001 + 002)
- **Group C** (sequential after A): Task 005 (depends on 003 + 004)
- **Group D** (sequential after C): Task 006 (depends on 005)

---

## Task 001: Check Catalog Data Structure

**Phase:** RED → GREEN → REFACTOR
**Design Requirement:** DR-2
**Parallelizable:** Yes (no dependencies)

### 1. [RED] Write tests

**File:** `servers/exarchos-mcp/src/review/check-catalog.test.ts`

```
CheckCatalog_DimensionCount_HasAtLeastSix
CheckCatalog_TotalChecks_HasAtLeastFifteen
CheckCatalog_AllGrepPatterns_CompileAsValidRegex
CheckCatalog_AllChecks_HaveRequiredFields
CheckCatalog_DimensionIds_AreUnique
CheckCatalog_CheckIds_AreUniqueWithinDimension
CheckCatalog_Severities_AreValidValues
CheckCatalog_Version_IsSemver
```

Expected failure: Module `check-catalog.ts` does not exist.

### 2. [GREEN] Implement check catalog

**File:** `servers/exarchos-mcp/src/review/check-catalog.ts`

Define TypeScript types and the catalog constant:
- `CheckExecution = "grep" | "structural" | "heuristic"`
- `CheckSeverity = "HIGH" | "MEDIUM" | "LOW"`
- `Check` interface: `{ id, execution, severity, description, pattern?, fileGlob?, multiline?, threshold?, remediation, falsePositives }`
- `CatalogDimension` interface: `{ id, name, checks: Check[] }`
- `CheckCatalog` interface: `{ version, dimensions: CatalogDimension[] }`
- `QUALITY_CHECK_CATALOG: CheckCatalog` constant with 6 dimensions:

| Dimension | ID | Checks |
|-----------|-----|--------|
| Error Handling | `error-handling` | EH-1: Empty catch blocks, EH-2: Console-only error handling, EH-3: Swallowed promise rejections |
| Type Safety | `type-safety` | TS-1: Unsafe type assertions, TS-2: Non-null assertions |
| Test Quality | `test-quality` | TQ-1: Skipped tests, TQ-2: Mock-heavy tests (>3 per file), TQ-3: `.only` left in tests |
| Code Hygiene | `code-hygiene` | CH-1: Commented-out code blocks, CH-2: TODO/FIXME accumulation, CH-3: Unreachable code after return |
| Structural Complexity | `structural-complexity` | SC-1: Deep nesting (>3 levels), SC-2: Long functions (>50 lines), SC-3: God objects (>500 lines or >10 exports), SC-4: Long parameter lists (>4 params) |
| Resilience | `resilience` | RS-1: Unbounded collections without cleanup, RS-2: Missing timeouts on fetch/http, RS-3: Unbounded retry loops |

Total: 18 deterministic checks across 6 dimensions.

Also export the finding format interface:
```typescript
export interface PluginFinding {
  source: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  dimension?: string;
  file?: string;
  line?: number;
  message: string;
}
```

### 3. [REFACTOR] Extract shared types if needed

---

## Task 002: Config Resolution — Plugins

**Phase:** RED → GREEN → REFACTOR
**Design Requirement:** DR-4
**Parallelizable:** Yes (no dependencies)

### 1. [RED] Write tests

**File:** `servers/exarchos-mcp/src/config/resolve.test.ts` (extend existing)

```
ResolveConfig_EmptyConfig_PluginsDefaultToEnabled
ResolveConfig_AxiomDisabled_ResolvesCorrectly
ResolveConfig_ImpeccableDisabled_ResolvesCorrectly
ResolveConfig_BothDisabled_ResolvesCorrectly
ResolveConfig_PluginsPartial_MissingKeyDefaultsToEnabled
```

Expected failure: `plugins` property does not exist on `ResolvedProjectConfig`.

### 2. [GREEN] Add plugins to resolved config

**File:** `servers/exarchos-mcp/src/config/resolve.ts`

- Add `ResolvedPluginConfig` interface: `{ readonly enabled: boolean }`
- Add `plugins` to `ResolvedProjectConfig`: `{ readonly axiom: ResolvedPluginConfig; readonly impeccable: ResolvedPluginConfig }`
- Add `plugins` to `DEFAULTS`: `{ axiom: { enabled: true }, impeccable: { enabled: true } }`
- Add plugins resolution in `resolveConfig()`: read `project.plugins?.axiom?.enabled` and `project.plugins?.impeccable?.enabled` with defaults

### 3. [REFACTOR] None expected

---

## Task 003: Extend `check_review_verdict` with Plugin Findings

**Phase:** RED → GREEN → REFACTOR
**Design Requirement:** DR-3
**Parallelizable:** Yes (no dependencies)

### 1. [RED] Write tests

**File:** `servers/exarchos-mcp/src/orchestrate/review-verdict.test.ts` (extend existing)

```
HandleReviewVerdict_PluginFindings_MergesCountsIntoVerdict
HandleReviewVerdict_PluginHighFinding_EscalatesApprovedToNeedsFixes
HandleReviewVerdict_PluginMediumOnly_DoesNotEscalate
HandleReviewVerdict_EmptyPluginFindings_NoEffect
HandleReviewVerdict_PluginFindingsSourceAttribution_IncludedInEvent
ComputeVerdict_MergedCounts_HighFromPluginTriggersNeedsFixes
```

Expected failure: `pluginFindings` property not recognized in args.

### 2. [GREEN] Extend review-verdict handler

**File:** `servers/exarchos-mcp/src/orchestrate/review-verdict.ts`

- Add `pluginFindings` to `ReviewVerdictArgs` interface (optional array of `PluginFinding`)
- Import `PluginFinding` type from `../review/check-catalog.js` (or define inline if Task 001 not yet merged)
- In `handleReviewVerdict`: count HIGH/MEDIUM/LOW from `pluginFindings`, add to `args.high`/`args.medium`/`args.low` before computing verdict
- Include `pluginSources` in summary gate event data

### 3. [REFACTOR] Extract count aggregation helper if logic is complex

**Dependencies:** Shares `PluginFinding` type with Task 001 — if running in parallel, define type inline and reconcile during Task 005.

---

## Task 004: `prepare_review` Orchestrate Handler

**Phase:** RED → GREEN → REFACTOR
**Design Requirement:** DR-1
**Parallelizable:** No — depends on Task 001 (catalog) + Task 002 (config)

### 1. [RED] Write tests

**File:** `servers/exarchos-mcp/src/orchestrate/prepare-review.test.ts`

```
HandlePrepareReview_DefaultArgs_ReturnsCatalogWithAllDimensions
HandlePrepareReview_DimensionFilter_ReturnsOnlyRequestedDimensions
HandlePrepareReview_InvalidDimension_ReturnsError
HandlePrepareReview_PluginStatus_ReflectsConfig
HandlePrepareReview_PluginStatusNoConfig_DefaultsToEnabled
HandlePrepareReview_FindingFormatIncluded_MatchesPluginFindingInterface
HandlePrepareReview_CatalogVersion_MatchesCatalogConstant
```

Expected failure: Module `prepare-review.ts` does not exist.

### 2. [GREEN] Implement handler

**File:** `servers/exarchos-mcp/src/orchestrate/prepare-review.ts`

```typescript
interface PrepareReviewArgs {
  readonly featureId: string;
  readonly scope?: string;
  readonly dimensions?: string[];
}
```

Handler:
1. Import `QUALITY_CHECK_CATALOG` from `../review/check-catalog.js`
2. If `dimensions` provided, filter catalog to matching dimension IDs. Return error if any dimension ID not found.
3. Load project config: `loadProjectConfig(process.cwd())` + `resolveConfig()` for plugin status. Use safe default if config load fails.
4. Return: `{ catalog, findingFormat, pluginStatus }`

### 3. [REFACTOR] None expected

**Dependencies:** Task 001 (check-catalog.ts), Task 002 (resolve.ts with plugins)

---

## Task 005: Registry and Composite Wiring

**Phase:** RED → GREEN → REFACTOR
**Design Requirements:** DR-1, DR-3
**Parallelizable:** No — depends on Task 003 + Task 004

### 1. [RED] Write tests

**File:** `servers/exarchos-mcp/src/registry.test.ts` (extend existing)

```
RegistryActions_PrepareReview_Registered
RegistryActions_CheckReviewVerdict_HasPluginFindingsInSchema
```

Expected failure: `prepare_review` not in registry.

### 2. [GREEN] Wire into registry and composite

**File:** `servers/exarchos-mcp/src/registry.ts`
- Add `prepare_review` action entry with Zod schema (featureId required, scope optional, dimensions optional array of strings)
- Add `pluginFindings` to `check_review_verdict` schema (optional array with source, severity, dimension?, file?, line?, message fields)

**File:** `servers/exarchos-mcp/src/orchestrate/composite.ts`
- Import `handlePrepareReview` from `./prepare-review.js`
- Add `prepare_review: adapt(handlePrepareReview)` to `ACTION_HANDLERS`

### 3. [REFACTOR] Verify integration with `npm run build && npm run test:run`

**Dependencies:** Task 003 (verdict extension), Task 004 (prepare-review handler)

---

## Task 006: Content Layer Updates

**Phase:** RED → GREEN → REFACTOR
**Design Requirements:** DR-5, DR-6
**Parallelizable:** No — depends on Task 005

### 1. [RED] Verify existing namespacing test passes (already updated in polish track)

**File:** `src/namespacing-validation.test.ts` — should already pass from polish track changes.

### 2. [GREEN] Update content files

**File:** `skills/quality-review/SKILL.md`
- In the "Companion Plugin Integration" section, add reference to `prepare_review`:
  ```
  Before starting quality checks, call:
  exarchos_orchestrate({ action: "prepare_review", featureId: "<id>" })

  Execute the returned catalog's grep patterns against the codebase.
  Feed findings as pluginFindings to check_review_verdict.
  ```

**File:** `commands/review.md`
- Update the "Companion Plugin Integration (Tier 2)" section to describe both paths:
  - **All platforms:** Call `prepare_review`, execute catalog checks, feed findings to verdict
  - **Claude Code/Cursor:** Additionally invoke axiom:audit and impeccable:critique Skills if available

**File:** `skills/quality-review/references/axiom-integration.md`
- Update architecture diagram to show three tiers: MCP gates → MCP-served catalog → Skills
- Update detection protocol to reference `prepare_review` for plugin status

### 3. [REFACTOR] Verify full test suite passes: `npm run build && npm run test:run && npm run typecheck`

**Dependencies:** Task 005 (all MCP changes complete)

---

## Summary

| Task | Description | DR | Parallel Group | Dependencies |
|------|-------------|-----|---------------|-------------|
| 001 | Check catalog data structure | DR-2 | A | None |
| 002 | Config resolution — plugins | DR-4 | A | None |
| 003 | Extend check_review_verdict | DR-3 | A | None |
| 004 | prepare_review handler | DR-1 | B | 001, 002 |
| 005 | Registry + composite wiring | DR-1, DR-3 | C | 003, 004 |
| 006 | Content layer updates | DR-5, DR-6 | D | 005 |
