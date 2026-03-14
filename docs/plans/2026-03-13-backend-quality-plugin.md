# Implementation Plan: Backend Quality Plugin (Axiom)

> **Status:** Phase 1 complete — all 14 tasks done, 45/45 tests passing. Plugin extracted to [lvlup-sw/axiom](https://github.com/lvlup-sw/axiom) in #1025. See `docs/plans/2026-03-14-extract-axiom-standalone.md` for the extraction plan.

## Source Design
Link: `docs/designs/2026-03-13-backend-quality-plugin.md`
Issue: #1013

## Scope
**Target:** Full design (DR-1 through DR-8)
**Excluded:** None. Exarchos integration (DR-6) included as separate task group.

## Summary
- Total tasks: 14
- Parallel groups: 4 (A–D)
- Estimated test count: 20 (structural validation)
- Design coverage: 8/8 DRs covered

## Spec Traceability

### Scope Declaration
**Target:** Full design
**Excluded:** None

### Traceability Matrix

| Design Requirement | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| DR-1: Dimension Taxonomy | 7 dimensions with definitions, invariants, signals, severity | 003 | Covered |
| DR-2: Standard Finding Format | Finding schema, severity tiers, dedup rules | 004 | Covered |
| DR-3: Core Skill Set | 6 skills with frontmatter, triggers, references | 006-011 | Covered |
| DR-4: Scan/Deterministic Checks | Check catalog with patterns per dimension | 005, 006 | Covered |
| DR-5: Plugin Architecture | plugin.json, CLAUDE.md, directory structure, validation | 001, 002, 012 | Covered |
| DR-6: Exarchos Integration | Thin review layer, dimension split, migration | 013, 014 | Covered |
| DR-7: Scoring Model | Severity tiers, verdict logic, metrics | 004 | Covered |
| DR-8: Error Handling | Empty scope, exclusions, partial failures, dedup edge cases | 006-011 (each skill) | Covered |

## Task Breakdown

### Task 001: Repository Scaffolding and Plugin Metadata

**Phase:** Content creation
**Implements:** DR-5

**Steps:**
1. Create `axiom/` directory at repo root (extracted to own repo later)
2. Create `.claude-plugin/plugin.json` with plugin name, version, description
3. Create `package.json` with vitest dev dependency for structural validation
4. Create `vitest.config.ts` and `tsconfig.json`
5. Create `CLAUDE.md` with plugin-level instructions (zero exarchos references)
6. Create `README.md` with plugin overview
7. Create empty directory skeleton:
   ```
   skills/backend-quality/references/
   skills/audit/references/
   skills/critique/references/
   skills/harden/references/
   skills/distill/references/
   skills/verify/references/
   skills/scan/references/
   ```

**Verification:**
- `plugin.json` parses as valid JSON with `name`, `version`, `description` fields
- `CLAUDE.md` exists and contains no "exarchos" references
- Directory skeleton matches DR-5 file tree

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task 002: Structural Validation Test Suite (Progressive Disclosure L1-L3)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-5, DR-8, Progressive Disclosure (L1-L3)

**Testing Strategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write structural validation tests
   - File: `axiom/tests/plugin-structure.test.ts`
   - Tests:
     - `PluginJson_Exists_HasRequiredFields`
     - `ClaudeMd_Exists_ContainsNoExarchosReferences`
     - `SkillsDirectory_ContainsExpectedSubdirs`
   - File: `axiom/tests/skill-frontmatter.test.ts`
   - Tests:
     - `AllSkills_Frontmatter_HasNameAndDescription`
     - `AllInvokableSkills_Description_Under1024Chars`
     - `AllInvokableSkills_Frontmatter_HasTriggers`
     - `AllSkills_DimensionsMetadata_DeclaredWhenInvokable`
   - File: `axiom/tests/cross-references.test.ts`
   - Tests:
     - `AllSkills_CrossReferences_ResolveToExistingFiles`
     - `AllSkills_ReferencesDir_AllFilesReferencedBySkill`
   - File: `axiom/tests/dimension-coverage.test.ts`
   - Tests:
     - `DimensionsTaxonomy_AllSeven_DefinedInDimensionsMd`
     - `DimensionCoverage_EachDimension_CoveredByAtLeastOneSkill`
     - `DimensionCoverage_NoSkillDeclaresUndefinedDimension`
   - Expected failure: All tests fail (no content yet)
   - Run: `cd axiom && npx vitest run` - MUST FAIL

2. [GREEN] Tests become green as Tasks 003-011 create content
   - This task only writes the tests; content tasks make them pass

3. [REFACTOR] Not applicable (test infrastructure)

**Verification:**
- [ ] All test files created and importable
- [ ] Tests fail for the right reasons (file not found / missing fields, not syntax errors)
- [ ] Test names follow Method_Scenario_Outcome convention

**Dependencies:** 001
**Parallelizable:** No (other tasks depend on these tests existing)

---

### Task 003: Core Reference — Dimension Taxonomy

**Phase:** Content creation
**Implements:** DR-1

**Steps:**
1. Research dimension definitions using:
   - Anthropic skill guide: `docs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf`
   - Industry frameworks (Fowler's Debt Quadrant, SonarQube model, SQALE, ISO 25010)
   - Microsoft Learn: architectural anti-patterns (`microsoft_docs_search`)
   - Existing feature-audit dimensions as reference (generalize, don't copy)
2. Create `axiom/skills/backend-quality/references/dimensions.md`
3. For each dimension (DIM-1 through DIM-7), write:
   - **Definition:** 2-3 sentence description of what this dimension measures
   - **Invariants:** Properties that should always hold in healthy code
   - **Detectable Signals:** Concrete patterns (grep-able where possible) that indicate violations
   - **Severity Guide:** When findings are HIGH vs MEDIUM vs LOW
   - **Examples:** 1-2 concrete examples of violations and healthy alternatives

**Content outline:**
```markdown
# Backend Quality Dimensions

## DIM-1: Topology
[Definition, invariants, signals, severity, examples]

## DIM-2: Observability
...

## DIM-7: Resilience
...

## Dimension Independence
[How dimensions are orthogonal, where overlap exists and why]
```

**Verification:**
- `DimensionsTaxonomy_AllSeven_DefinedInDimensionsMd` test passes
- Each dimension section has all required subsections
- No dimension references another dimension's output as a prerequisite

**Dependencies:** 001
**Parallelizable:** No (all skills depend on this)

---

### Task 004: Core References — Finding Format and Scoring Model

**Phase:** Content creation
**Implements:** DR-2, DR-7

**Steps:**
1. Create `axiom/skills/backend-quality/references/findings-format.md`
   - Finding schema (TypeScript interface + Markdown description)
   - Severity tier definitions (HIGH, MEDIUM, LOW)
   - Deduplication rules (same evidence + dimension = merge)
   - Example findings for each severity tier
   - Output format: how skills present findings to the user

2. Create `axiom/skills/backend-quality/references/scoring-model.md`
   - Plugin verdict logic (CLEAN / NEEDS_ATTENTION)
   - Per-dimension pass rate calculation
   - Finding density formula
   - Healthy audit thresholds (>90% pass rate, <0.5 density, 0 HIGH)
   - Report template (Markdown output format)

**Verification:**
- Finding schema includes all fields from DR-2
- Scoring model includes both plugin-level and consumer-level verdict sections
- Dedup rules cover edge cases (same file different lines, same pattern different files)

**Dependencies:** 003
**Parallelizable:** Yes (with 005)

---

### Task 005: Core Reference — Deterministic Checks + Foundation Skill

**Phase:** Content creation
**Implements:** DR-4, DR-5

**Steps:**
1. Create `axiom/skills/backend-quality/references/deterministic-checks.md`
   - Check catalog organized by dimension (DIM-1 through DIM-7)
   - Each check: ID (e.g., T-1.1), grep/structural pattern, severity, what it catches, false-positive guidance
   - At least 3 checks per dimension (21+ total)
   - Extensibility section: how `.axiom/checks.md` overrides/extends the catalog

2. Create `axiom/skills/backend-quality/SKILL.md`
   - Not user-invokable (no triggers)
   - Frontmatter: name, description, metadata (dimensions: all)
   - Body: overview of the dimension taxonomy, pointer to references
   - Purpose: foundation referenced by all other skills via `@skills/backend-quality/references/...`

**Verification:**
- `BackendQuality_Frontmatter_HasRequiredFields` test passes (once frontmatter validation is written)
- Check catalog has entries for all 7 dimensions
- Each check has ID, pattern, severity, description, false-positive notes
- SKILL.md is NOT user-invokable (no `user-invokable: true` in frontmatter)

**Dependencies:** 003
**Parallelizable:** Yes (with 004)

---

### Task 006: Scan Skill — Deterministic Check Engine

**Phase:** Content creation
**Implements:** DR-3, DR-4, DR-8

**Steps:**
1. Create `axiom/skills/scan/SKILL.md`
   - Frontmatter: name `scan`, description (<1,024 chars), triggers, negative triggers
   - `metadata.dimensions: [pluggable]` (covers any dimension on demand)
   - `user-invokable: true`
   - Args: `scope` (file/dir/cwd), `dimensions` (comma-separated DIM-N list or "all")
   - Body: instructions for running deterministic checks
     - Load check catalog from `@skills/backend-quality/references/deterministic-checks.md`
     - Optionally load project checks from `.axiom/checks.md`
     - For each check: run grep pattern, collect matches, emit findings in standard format
     - Output: findings list in standard format
   - Error handling: invalid patterns → actionable error, empty scope → "nothing to scan"

2. Create `axiom/skills/scan/references/check-catalog.md`
   - Skill-specific catalog that re-exports from backend-quality with scan-specific execution notes
   - Execution order, timeout guidance, batch strategies

**Verification:**
- `Scan_Frontmatter_HasDimensionsMetadata` test passes
- Skill description includes triggers and negative triggers
- References check-catalog and backend-quality dimensions
- Handles empty scope and invalid pattern edge cases (DR-8)

**Dependencies:** 005
**Parallelizable:** Yes (with 007, 008, 009, 010)

---

### Task 007: Critique Skill — Architecture Review

**Phase:** Content creation
**Implements:** DR-3

**Steps:**
1. Create `axiom/skills/critique/SKILL.md`
   - Frontmatter: name `critique`, description, triggers, negative triggers
   - `metadata.dimensions: [architecture, topology]` (DIM-6, DIM-1)
   - `user-invokable: true`
   - Args: `scope`
   - Body:
     - Load dimensions: `@skills/backend-quality/references/dimensions.md` (DIM-1, DIM-6)
     - Run `scan` for deterministic checks on Architecture + Topology dimensions
     - Layer qualitative assessment:
       - SOLID principle evaluation
       - Coupling/cohesion analysis
       - Dependency direction (dependencies point inward)
       - God object detection
       - Circular dependency identification
     - Output: findings in standard format

2. Create `axiom/skills/critique/references/solid-principles.md`
   - Each SOLID principle: definition, violation signals, severity guide, code examples
   - Detection heuristics for agent-driven assessment

3. Create `axiom/skills/critique/references/dependency-patterns.md`
   - Healthy vs unhealthy dependency patterns
   - Coupling metrics (afferent/efferent, instability, abstractness)
   - Circular dependency detection approach
   - Layered architecture rule violations

**Verification:**
- `Critique_Frontmatter_HasDimensionsMetadata` test passes
- Declares dimensions: architecture, topology
- References resolve to existing files
- Includes both deterministic (via scan) and qualitative assessment phases

**Dependencies:** 005
**Parallelizable:** Yes (with 006, 008, 009, 010)

---

### Task 008: Harden Skill — Resilience Strengthening

**Phase:** Content creation
**Implements:** DR-3

**Steps:**
1. Create `axiom/skills/harden/SKILL.md`
   - Frontmatter: name `harden`, description, triggers, negative triggers
   - `metadata.dimensions: [observability, resilience]` (DIM-2, DIM-7)
   - `user-invokable: true`
   - Args: `scope`
   - Body:
     - Load dimensions: `@skills/backend-quality/references/dimensions.md` (DIM-2, DIM-7)
     - Run `scan` for deterministic checks on Observability + Resilience dimensions
     - Qualitative assessment:
       - Empty catch block audit (silent vs intentional)
       - Error context propagation (do errors include what/why/how-to-fix?)
       - Fallback behavior analysis (degraded mode awareness)
       - Resource lifecycle (open/close, acquire/release symmetry)
       - Timeout and retry policy evaluation
       - Cache bound verification
     - Output: findings in standard format

2. Create `axiom/skills/harden/references/error-patterns.md`
   - Silent catch taxonomy (empty, log-only, swallow-and-default)
   - Error context checklist (what failed, why, what to do)
   - Fallback anti-patterns (silent degradation, invisible mode switches)

3. Create `axiom/skills/harden/references/resilience-checklist.md`
   - Resource management patterns (bounded caches, connection pools, file handles)
   - Timeout/retry patterns (exponential backoff, circuit breaker, bulkhead)
   - Concurrency safety (mutex, CAS, single-instance)

**Verification:**
- `Harden_Frontmatter_HasDimensionsMetadata` test passes
- Declares dimensions: observability, resilience
- References resolve to existing files

**Dependencies:** 005
**Parallelizable:** Yes (with 006, 007, 009, 010)

---

### Task 009: Distill Skill — Simplification

**Phase:** Content creation
**Implements:** DR-3

**Steps:**
1. Create `axiom/skills/distill/SKILL.md`
   - Frontmatter: name `distill`, description, triggers, negative triggers
   - `metadata.dimensions: [hygiene, topology]` (DIM-5, DIM-1)
   - `user-invokable: true`
   - Args: `scope`
   - Body:
     - Load dimensions: `@skills/backend-quality/references/dimensions.md` (DIM-5, DIM-1)
     - Run `scan` for deterministic checks on Hygiene + Topology dimensions
     - Qualitative assessment:
       - Dead code identification (unreachable branches, unused exports, commented-out code)
       - Vestigial pattern detection (evolutionary leftovers, divergent implementations)
       - Wiring simplification opportunities (manual DI → simpler patterns)
       - Abstraction audit (premature abstractions, over-engineering, single-use helpers)
     - Output: findings in standard format

2. Create `axiom/skills/distill/references/dead-code-patterns.md`
   - Dead code categories (unreachable, unused, commented-out, feature-flagged-off)
   - Detection heuristics per category
   - False positive guidance (intentional stubs, forward declarations)

3. Create `axiom/skills/distill/references/simplification-guide.md`
   - Complexity reduction patterns
   - When to inline vs extract
   - Vestigial pattern identification (code archaeology approach)

**Verification:**
- `Distill_Frontmatter_HasDimensionsMetadata` test passes
- Declares dimensions: hygiene, topology
- References resolve to existing files

**Dependencies:** 005
**Parallelizable:** Yes (with 006, 007, 008, 010)

---

### Task 010: Verify Skill — Test Validation

**Phase:** Content creation
**Implements:** DR-3

**Steps:**
1. Create `axiom/skills/verify/SKILL.md`
   - Frontmatter: name `verify`, description, triggers, negative triggers
   - `metadata.dimensions: [test-fidelity, contracts]` (DIM-4, DIM-3)
   - `user-invokable: true`
   - Args: `scope`
   - Body:
     - Load dimensions: `@skills/backend-quality/references/dimensions.md` (DIM-4, DIM-3)
     - Run `scan` for deterministic checks on Test Fidelity + Contracts dimensions
     - Qualitative assessment:
       - Test-production divergence (setup that doesn't match prod wiring)
       - Mock fidelity (mocks that hide real behavior, >3 mocks = smell)
       - Missing integration tests (unit tests only for cross-cutting concerns)
       - Schema/contract drift (types removed but still read, breaking API changes)
       - Test coverage gap analysis (happy path only, missing error paths)
     - Output: findings in standard format

2. Create `axiom/skills/verify/references/test-antipatterns.md`
   - Test-production divergence patterns
   - Mock overuse taxonomy
   - Test isolation vs production reality
   - The "passing tests, broken system" class of bugs

3. Create `axiom/skills/verify/references/contract-testing.md`
   - Schema drift detection approach
   - API versioning patterns
   - Type safety verification
   - Contract testing fundamentals

**Verification:**
- `Verify_Frontmatter_HasDimensionsMetadata` test passes
- Declares dimensions: test-fidelity, contracts
- References resolve to existing files

**Dependencies:** 005
**Parallelizable:** Yes (with 006, 007, 008, 009)

---

### Task 011: Audit Skill — Anchor Orchestrator

**Phase:** Content creation
**Implements:** DR-3, DR-2 (dedup), DR-7 (verdict)

**Steps:**
1. Create `axiom/skills/audit/SKILL.md`
   - Frontmatter: name `audit`, description, triggers, negative triggers
   - `metadata.dimensions: [all]`
   - `user-invokable: true`
   - Args: `scope`
   - Body:
     - **Orchestration:** Run all 5 specialized skills in sequence:
       1. `axiom:scan` (all dimensions, deterministic)
       2. `axiom:critique` (Architecture + Topology, qualitative)
       3. `axiom:harden` (Observability + Resilience, qualitative)
       4. `axiom:distill` (Hygiene + Topology, qualitative)
       5. `axiom:verify` (Test Fidelity + Contracts, qualitative)
     - **Deduplication:** Merge findings with same evidence + dimension
     - **Coverage check:** Verify all 7 dimensions were assessed, warn on gaps
     - **Scoring:** Compute per-dimension pass rates, aggregate verdict
     - **Report:** Output structured report using scoring-model.md template
     - **Error handling:** Partial failures (one skill errors → others continue, error reported)

2. Create `axiom/skills/audit/references/composition-guide.md`
   - How audit discovers and invokes other skills
   - Finding deduplication algorithm
   - Coverage matrix generation
   - Report format and sections
   - Partial failure handling

**Verification:**
- `Audit_Frontmatter_HasRequiredFields` test passes
- References composition-guide.md and backend-quality dimensions
- Describes full orchestration flow including error handling (DR-8)
- Deduplication and verdict computation documented

**Dependencies:** 006, 007, 008, 009, 010
**Parallelizable:** No (depends on all specialized skills)

---

### Task 012: End-to-End Structural Validation

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-5, DR-8

**Testing Strategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Run full validation suite
   - Run: `cd axiom && npx vitest run`
   - Expected: All tests from Task 002 should now pass (if not, identify gaps)

2. [GREEN] Fix any remaining structural issues
   - Fix broken cross-references
   - Add missing frontmatter fields
   - Correct dimension declarations
   - Ensure all referenced files exist

3. [REFACTOR] Review content consistency
   - Verify consistent terminology across all skills
   - Check that dimension names match exactly between dimensions.md and skill frontmatter
   - Verify finding format examples are consistent across skills
   - Run: `cd axiom && npx vitest run` - MUST STAY GREEN

**Verification:**
- [ ] All structural validation tests pass
- [ ] `DimensionCoverage_EachDimension_CoveredByAtLeastOneSkill` passes
- [ ] `AllSkills_CrossReferences_ResolveToExistingFiles` passes
- [ ] No test failures

**Dependencies:** 011
**Parallelizable:** No (validation of everything)

---

### Task 013: Exarchos Thin Integration Layer

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-6
**Acceptance Test Ref:** N/A

**Testing Strategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration",
  "characterizationRequired": true
}
```

**TDD Steps:**
1. [RED] Characterize existing `/feature-audit` behavior
   - Read existing `skills/feature-audit/SKILL.md` and all references
   - Document current D1-D5 dimension split
   - Identify which checks are general-purpose (move to axiom) vs exarchos-specific (keep)

2. [GREEN] Create thin `/exarchos:review` integration skill
   - File: `skills/review-integration/SKILL.md` (or update existing review skill)
   - Content:
     - Invoke `axiom:audit` for general backend quality (DIM-1 through DIM-7)
     - Run exarchos-specific checks inline:
       - D1: Spec Fidelity & TDD traceability (workflow state dependent)
       - D2-domain: Event Sourcing / CQRS / HSM / Saga invariants
       - D3: Context Economy & Token Efficiency
       - D5: Workflow Determinism
     - Merge plugin findings + exarchos-specific findings
     - Compute verdict (APPROVED / NEEDS_FIXES / BLOCKED)
     - Emit workflow events, transition phase
   - Integration layer target: <200 lines of skill content

3. [REFACTOR] Ensure backward compatibility
   - Verify existing orchestrate actions still work (check_convergence, check_review_verdict)
   - Verify auto-transition behavior preserved
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Integration layer invokes axiom:audit
- [ ] D1, D2-domain, D3, D5 preserved in exarchos
- [ ] Verdict computation uses combined findings
- [ ] Integration layer is <200 lines

**Dependencies:** 012
**Parallelizable:** No (depends on complete plugin)

---

### Task 014: Migration Documentation and Deprecation Plan

**Phase:** Content creation
**Implements:** DR-6

**Steps:**
1. Document migration path from `/feature-audit` to axiom-integrated `/exarchos:review`
   - Which dimensions moved to the plugin
   - Which dimensions stayed in exarchos
   - API surface changes (if any)
   - Backward compatibility notes

2. Add deprecation notice to existing `skills/feature-audit/SKILL.md`
   - Point to new integration layer
   - Note: feature-audit remains functional during transition

3. Update exarchos `CLAUDE.md` if needed
   - Note axiom plugin dependency for review phase
   - Document dimension ownership split

**Verification:**
- Migration document is clear and complete
- Feature-audit deprecation notice points to replacement
- CLAUDE.md reflects new review architecture

**Dependencies:** 013
**Parallelizable:** No (final task)

---

## Parallelization Strategy

```
Group A — Foundation (sequential):
  001 → 002 → 003 → 004 ─┐
                    └─ 005 ─┤
                            │
Group B — Specialized Skills (parallel, 5 agents):
                            ├── 006 (scan)
                            ├── 007 (critique)
                            ├── 008 (harden)
                            ├── 009 (distill)
                            └── 010 (verify)
                                 │
Group C — Composition + Validation (sequential):
                            011 → 012

Group D — Exarchos Integration (sequential):
                            013 → 014
```

**Agent allocation for Group B:**
- Agent 1: Task 006 (scan) — deterministic check engine
- Agent 2: Task 007 (critique) — architecture review
- Agent 3: Task 008 (harden) — resilience
- Agent 4: Task 009 (distill) — simplification
- Agent 5: Task 010 (verify) — test validation

All Group B tasks write to different directories — no file conflicts.

## Cross-Cutting Concerns

### Progressive Disclosure (L1-L3)

All skill creation tasks (006-011) MUST follow the progressive disclosure pattern from the design:

- **L1 (Frontmatter):** Description includes [What] + [When] + [Dimensions]. Under 1,024 chars.
- **L2 (SKILL.md body):** Core instructions only. No inline templates, checklists, or code blocks.
- **L3 (references/):** Detailed guides, patterns, examples. Loaded on demand.

Task 002 validation tests enforce L1 constraints (description length, required fields). L2/L3 structure is verified by cross-reference tests.

## Deferred Items

| Item | Rationale |
|---|---|
| Plugin name finalization | Using "axiom" as working name; verify availability before public release |
| ~~Extraction to standalone repo~~ | ~~Developed under `axiom/` in exarchos repo; extract after validation~~ — **Done:** extracted to [lvlup-sw/axiom](https://github.com/lvlup-sw/axiom) (#1025) |
| Language generalization | Start TypeScript/Node.js; dimensions are language-agnostic by design |
| CI/CD annotation format | Future extension for `scan` results |
| `.axiom/checks.md` extensibility | Documented in design but implementation deferred to post-MVP |
| Feature-audit removal | Deprecated, not removed; coexists during transition period |

## Completion Checklist
- [ ] All structural validation tests pass (`cd axiom && npx vitest run`)
- [ ] All 7 dimensions defined and covered
- [ ] All 6 skills have valid frontmatter with triggers and dimension declarations
- [ ] All cross-references resolve to existing files
- [ ] Exarchos integration layer is <200 lines and invokes axiom:audit
- [ ] Migration documentation complete
- [ ] Ready for review
