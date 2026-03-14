# Design: Backend Quality Plugin — Composable Skill Family

> **Status:** Phase 1 (creation) complete (#1023). Phase 2 (extraction to [lvlup-sw/assay](https://github.com/lvlup-sw/assay)) complete (#1025). Phase 3 (full integration) pending.

## Problem Statement

Issue #1009 exposed a class of architectural debt that no existing tooling detects: silent divergence of shared state across module boundaries. The EventStore bug was invisible to `/feature-audit` (feature-scoped, pipeline-bound), 4192 passing tests (same-instance setup), and code review (the bug was an *absence*). The fix was trivial; finding it was not.

The current `/feature-audit` is monolithic — mixing general backend quality concerns with exarchos-specific workflow concerns. We need a **standalone, general-purpose plugin** analogous to how [impeccable](https://github.com/pbakaus/impeccable) provides composable frontend design skills. This plugin should:

1. Work on any codebase (not coupled to exarchos)
2. Distribute independently as a Claude Code plugin
3. Subsume the general-purpose portions of `/feature-audit`
4. Be consumable by exarchos (or any workflow tool) via a thin integration layer

## Approaches Considered

### Option 1: Action-Verb Family (Impeccable Mirror)

Mirror impeccable's verb-based naming directly. Each skill is an action you take on backend code. Familiar mental model, intuitive naming, natural composition. Drawback: dimensional overlap between skills is implicit and undocumented, some verbs feel thin.

### Option 2: Dimension-First (Orthogonal Concerns)

Each skill maps 1:1 to an independent quality dimension. Noun-based naming (topology, observability, contracts). Strictly orthogonal with no overlap. Drawback: noun naming less intuitive, some dimensions too narrow for standalone skills, doesn't match impeccable's pattern.

### Option 3: Hybrid — Verbs with Dimensional Grounding (Selected)

Action-verb naming for ergonomics, grounded in a shared taxonomy of 7 quality dimensions. Each skill declares which dimensions it covers. A `scan` skill provides deterministic pattern detection. A standard finding format enables composition and deduplication. Overlap is intentional and documented.

## Chosen Approach

**Option 3 (Hybrid).** Each skill uses intuitive verb naming (critique, harden, distill) grounded in a shared taxonomy of 7 quality dimensions. A `scan` skill provides deterministic pattern detection. A standard finding format enables composition and deduplication across skills.

This mirrors impeccable's architecture: a core reference skill defines principles, specialized skills address specific quality facets, and an anchor `audit` skill orchestrates them all.

## Plugin Identity

**Working name: `assay`** — to analyze or evaluate composition and quality. From metallurgy: testing the purity and composition of metals.

- Namespace: `assay:audit`, `assay:critique`, `assay:harden`, etc.
- Distribution: standalone Claude Code plugin via lvlup-sw marketplace
- Alternatives considered: `temper`, `rigor`, `plumb`

## Requirements

### DR-1: Dimension Taxonomy

Define 7 canonical quality dimensions that collectively cover backend architectural health. Each dimension is independently assessable, orthogonal, and extensible.

| ID | Name | What it catches | Origin |
|----|------|----------------|--------|
| DIM-1 | Topology | Hidden ambient state, manual wiring, lazy fallbacks, divergent instances | TD1, TD2 |
| DIM-2 | Observability | Silent catches, swallowed exceptions, missing error context, opaque fallbacks | TD3 |
| DIM-3 | Contracts | Schema drift, fields removed but still read, unversioned APIs, breaking changes | TD4 |
| DIM-4 | Test Fidelity | Test-production divergence, mock fidelity, missing integration tests, untested paths | TD5 |
| DIM-5 | Hygiene | Dead code, vestigial patterns, unreachable paths, commented-out code, unused exports | TD6 |
| DIM-6 | Architecture | SOLID violations, circular deps, god objects, coupling, cohesion, dependency direction | Generalized D2 |
| DIM-7 | Resilience | Unbounded caches, missing timeouts, no retry limits, resource leaks, missing graceful degradation | D4 |

**Acceptance criteria:**
- Each dimension has a definition, invariants, detectable signals, and severity guide in `references/dimensions.md`
- No dimension requires another dimension's output to produce findings
- Each dimension maps to at least one skill
- Every skill declares which dimensions it covers in frontmatter `metadata.dimensions`

### DR-2: Standard Finding Format

All skills emit findings in a shared schema enabling composition, deduplication, and aggregation.

```typescript
interface Finding {
  dimension: string;        // DIM-1 through DIM-7
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;            // Short description (<100 chars)
  evidence: string[];       // file:line references
  explanation: string;      // What's wrong, why it matters
  suggestion?: string;      // How to fix (optional)
  skill: string;            // Which skill produced this finding
  deterministic: boolean;   // Found by scan (true) or qualitative (false)
}
```

**Acceptance criteria:**
- All 6 skills emit findings in this format
- `audit` deduplicates findings from multiple skills (same evidence + dimension = merge)
- Finding schema documented in `references/findings-format.md`
- Severity tiers: HIGH = correctness risk, MEDIUM = quality/maintainability, LOW = polish

### DR-3: Core Skill Set

Six composable skills, each with clear scope and dimensional coverage.

| Skill | Verb | Dimensions | Purpose |
|-------|------|-----------|---------|
| `audit` | Assess everything | All (orchestrator) | Run other skills, deduplicate, report |
| `critique` | Review architecture | Architecture, Topology | SOLID, coupling, dependency direction |
| `harden` | Strengthen resilience | Observability, Resilience | Error handling, silent catches, resource mgmt |
| `distill` | Simplify and clean | Hygiene, Topology | Dead code, vestigial patterns, wiring simplification |
| `verify` | Validate tests | Test Fidelity, Contracts | Test quality, mock fidelity, schema coverage |
| `scan` | Detect patterns | Pluggable (any) | Deterministic checks: grep patterns, structural analysis |

**Acceptance criteria:**
- Each skill has `SKILL.md` with frontmatter: name, description, triggers, negative triggers, `metadata.dimensions`
- Each skill has `references/` with dimension-specific guidance
- `audit` runs all 5 other skills and produces a unified report
- `scan` accepts a `dimensions` parameter to run checks for specific dimensions
- Each skill accepts a `scope` parameter (file, directory, or codebase; defaults to cwd)
- Every dimension is covered by at least one skill

### DR-4: Scan Skill — Deterministic Check Engine

The `scan` skill runs grep patterns, structural analysis, and other mechanical checks. Other skills invoke `scan` for their deterministic components, then layer qualitative assessment.

**Check catalog structure (per dimension):**
```markdown
## DIM-1: Topology

### T-1.1: Module-global mutable state
- Pattern: `^(let|var)\s+\w+\s*[:=]` at file scope (not inside function/class)
- Severity: MEDIUM
- What it catches: Ambient state that can diverge across module boundaries
- False positives: Intentional singletons with documented rationale

### T-1.2: Lazy fallback constructors
- Pattern: `if\s*\(\s*!\w+\s*\)\s*\{?\s*\w+\s*=\s*new\s`
- Severity: HIGH
- What it catches: Degraded-mode instances created silently when wiring is missing
```

**Acceptance criteria:**
- Check catalog in `references/check-catalog.md` with grep patterns per dimension
- Each check has: ID, pattern, what it detects, severity, false-positive guidance
- `scan` returns findings in standard format
- Other skills can invoke `scan` results and augment with qualitative assessment
- Check catalog is extensible (users add project-specific patterns via `.assay/checks.md`)

### DR-5: Plugin Architecture

Standalone Claude Code plugin following marketplace distribution patterns.

```
assay/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── backend-quality/          # Core reference skill (foundation)
│   │   ├── SKILL.md              # Not user-invokable; referenced by all others
│   │   └── references/
│   │       ├── dimensions.md
│   │       ├── findings-format.md
│   │       ├── scoring-model.md
│   │       └── deterministic-checks.md
│   ├── audit/
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── composition-guide.md
│   ├── critique/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── solid-principles.md
│   │       └── dependency-patterns.md
│   ├── harden/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── error-patterns.md
│   │       └── resilience-checklist.md
│   ├── distill/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── dead-code-patterns.md
│   │       └── simplification-guide.md
│   ├── verify/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── test-antipatterns.md
│   │       └── contract-testing.md
│   └── scan/
│       ├── SKILL.md
│       └── references/
│           └── check-catalog.md
├── CLAUDE.md
└── README.md
```

**Acceptance criteria:**
- Plugin installs via lvlup-sw marketplace
- All skills register with `assay:` namespace
- `CLAUDE.md` provides plugin-level instructions (no exarchos references)
- Core `backend-quality` skill is referenced by all other skills (`@skills/backend-quality/references/...`)
- Zero dependencies on exarchos or any workflow tool
- Works on any codebase (TypeScript/Node.js initially, dimensions are language-agnostic)

### DR-6: Exarchos Integration Design

Exarchos consumes the plugin via a thin integration layer. The existing monolithic `/feature-audit` is replaced by an `/exarchos:review` skill that orchestrates plugin skills and adds domain-specific concerns.

**Dimension ownership split:**

| Concern | Owner | Rationale |
|---------|-------|-----------|
| DIM-1 through DIM-7 | Plugin | General backend quality |
| Spec Fidelity & TDD traceability (D1) | Exarchos | Requires workflow state |
| Event Sourcing / CQRS / HSM / Saga (D2-domain) | Exarchos | Domain-specific patterns |
| Context Economy & Token Efficiency (D3) | Exarchos | AI-agent skill-specific |
| Workflow Determinism (D5) | Exarchos | Workflow orchestration-specific |

**Integration flow:**
```
/exarchos:review
    ├── Invoke assay:audit (plugin — general dimensions)
    ├── Run exarchos-specific checks (D1, D2-domain, D3, D5)
    ├── Merge findings (plugin + exarchos-specific)
    ├── Compute verdict (APPROVED / NEEDS_FIXES / BLOCKED)
    ├── Emit workflow events
    └── Transition phase
```

**Acceptance criteria:**
- `/exarchos:review` invokes plugin skills and adds exarchos-specific checks
- Plugin findings translated to exarchos events without plugin knowing about exarchos
- Verdict uses combined findings (plugin + exarchos-specific)
- D1, D2-domain, D3, D5 preserved in exarchos
- Integration layer is <200 lines of skill content (thin)

### DR-7: Scoring Model

**Severity tiers (shared):**
- **HIGH:** Violates correctness invariant, risks data loss, silent failure. Must fix.
- **MEDIUM:** Degrades quality/maintainability, doesn't break correctness. Should fix.
- **LOW:** Polish, minor improvements. Track, don't block.

**Plugin verdict (standalone, no workflow concepts):**
```
if HIGH_count > 0: NEEDS_ATTENTION
elif MEDIUM_count > 5: NEEDS_ATTENTION
else: CLEAN
```

**Exarchos verdict (workflow-integrated):**
```
if any HIGH violates append-only, state derivability, or terminal reachability: BLOCKED
elif HIGH_count > 0: NEEDS_FIXES
elif MEDIUM_count > 5: NEEDS_FIXES
else: APPROVED
```

**Acceptance criteria:**
- Scoring model documented in `references/scoring-model.md`
- Plugin produces `CLEAN` or `NEEDS_ATTENTION` (no workflow concepts)
- Exarchos maps plugin verdicts + its own findings to `APPROVED` / `NEEDS_FIXES` / `BLOCKED`
- Per-dimension pass rates and finding density computed
- Healthy audit: pass rate >90%, finding density <0.5, HIGH count = 0

### DR-8: Error Handling and Edge Cases

**Acceptance criteria:**
- Skills handle empty scope (no files) gracefully: "nothing to assess" message
- Skills exclude binary files, generated files, `node_modules/`, `dist/` by default
- `scan` reports invalid grep patterns with actionable error messages (which pattern, what's wrong)
- `audit` handles partial failures: one skill errors, others continue, error reported in output
- Finding deduplication handles: same file different lines, same pattern different files
- Scope parameter validates: file/directory must exist, defaults to cwd
- Plugin works with zero configuration (sensible defaults, no `.assay/` required)

## Technical Design

### Core Reference Skill: `backend-quality`

The foundational skill, analogous to impeccable's `frontend-design`. Not user-invokable. Defines the shared taxonomy, formats, and scoring model. All other skills reference it:

```markdown
<!-- In critique/SKILL.md -->
**First:** Load the backend quality dimensions: @skills/backend-quality/references/dimensions.md
```

### Composition Model

```
assay:audit --scope src/
    │
    ├── assay:scan (all dimensions, deterministic)
    ├── assay:critique (Architecture + Topology, qualitative)
    ├── assay:harden (Observability + Resilience, qualitative)
    ├── assay:distill (Hygiene + Topology, qualitative)
    └── assay:verify (Test Fidelity + Contracts, qualitative)
    │
    ▼
Deduplicate findings (same evidence + dimension = merge)
Compute dimensional coverage (all 7 hit?)
Score per-dimension and aggregate
Produce report
```

### Progressive Disclosure (L1-L3)

Following Anthropic's skill-building guide:
- **L1 (Frontmatter):** Description with [What] + [When] + [Dimensions]. <1,024 chars.
- **L2 (SKILL.md body):** Core instructions, dimension scope, output format. No inline templates.
- **L3 (references/):** Detailed guides, patterns, examples. Loaded on demand.

### Extensibility

1. **New dimensions:** Add to `references/dimensions.md`, assign to existing or new skills
2. **New skills:** Create `skills/<name>/SKILL.md`, declare `metadata.dimensions`, `audit` discovers automatically
3. **Project-specific checks:** `.assay/checks.md` in repo root (scan reads it alongside built-in catalog)
4. **Consumer integration:** Any workflow tool reads the standard finding format

## Integration Points

### With Impeccable
- Complementary: impeccable = frontend quality, assay = backend quality
- Shared patterns: verb naming, reference-based progressive disclosure, standalone plugin distribution
- No dependency between them; a project can use either or both

### With Exarchos
- Thin integration layer in `/exarchos:review`
- Plugin findings → exarchos events (translation, not coupling)
- Exarchos adds domain-specific dimensions atop plugin's general dimensions

### With CI/CD (Future)
- `scan` results can format as CI annotations
- Finding format is JSON-serializable for external tool integration

## Testing Strategy

- **Skill triggers:** 10-20 test queries per skill, >90% precision/recall
- **Scan checks:** Test against known-good and known-bad code samples per dimension
- **Composition:** Verify `audit` correctly orchestrates, deduplicates, and reports
- **Integration:** Verify exarchos's thin layer translates findings correctly
- **Edge cases:** Empty repos, binary files, large codebases, partial skill failures

## Open Questions

1. **Plugin name:** "assay" is the working proposal. Verify availability, gather feedback.
2. **Language scope:** Start TypeScript/Node.js. Dimensions are language-agnostic — when do we generalize?
3. **Check execution model:** Should `scan` execute checks (grep/AST) or generate a checklist for the agent? Agent-driven is more flexible; script-driven is more reproducible.
4. **Custom dimension registration:** How do consumers register domain-specific dimensions? Through plugin extensibility or entirely external?
5. **Feature-audit migration:** Big-bang replacement or gradual coexistence?
