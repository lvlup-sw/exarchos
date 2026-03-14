---
name: critique
description: "Review backend architecture for SOLID violations, coupling issues, and dependency direction problems. Use when evaluating structural design decisions or preparing for refactoring. Triggers: 'review architecture', 'check SOLID', 'critique code', or /assay:critique. Do NOT use for error handling — use assay:harden instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - architecture
    - topology
---

# Critique Skill — Architecture Review

## Overview

Architecture review skill covering two quality dimensions:

- **DIM-6 (Architecture):** SOLID principles adherence, module boundaries, responsibility allocation
- **DIM-1 (Topology):** Dependency graph health, coupling metrics, layering discipline

Use this skill to evaluate structural design decisions, identify architectural drift, or prepare a codebase for refactoring. It combines deterministic scanning (via `assay:scan`) with qualitative agent assessment to produce actionable findings.

## Triggers

### Positive Triggers

Activate this skill when:
- User says "review architecture" or "architecture review"
- User says "check SOLID" or "SOLID violations"
- User says "critique code" or "critique this module"
- User runs `/assay:critique`
- User asks about coupling, dependency direction, or module boundaries
- Preparing for a major refactoring effort

### Negative Triggers

Do NOT activate this skill when:
- User wants error handling review — use `assay:harden` instead
- User wants test quality review — use `assay:verify` instead
- User wants performance review — performance profiling is out of scope for assay
- User wants a general code review — use `assay:scan` for a broad sweep first

## Process

### Step 1: Load Dimension Definitions

Load the relevant dimension definitions for this review:

- `@skills/backend-quality/references/dimensions.md` — Read DIM-1 (Topology) and DIM-6 (Architecture) sections for scoring criteria, signal definitions, and severity thresholds.

### Step 2: Run Deterministic Scan

Execute `assay:scan` targeting Architecture and Topology dimensions specifically:

- Collects measurable signals: file sizes, parameter counts, import depth, circular references
- Establishes a baseline of deterministic findings before qualitative assessment
- Each automated finding is tagged with `provenance: "automated"`

### Step 3: Layer Qualitative Assessment

On top of the scan baseline, perform agent-driven qualitative evaluation across five areas:

#### 3a. SOLID Evaluation

Assess adherence to each SOLID principle. For definitions, violation signals, and severity guidance, see `references/solid-principles.md`.

- **Single Responsibility Principle (SRP):** Does each module/class have one reason to change?
- **Open/Closed Principle (OCP):** Are modules open for extension but closed for modification?
- **Liskov Substitution Principle (LSP):** Can subtypes replace their base types without breaking behavior?
- **Interface Segregation Principle (ISP):** Are interfaces focused, or do clients depend on methods they do not use?
- **Dependency Inversion Principle (DIP):** Do high-level modules depend on abstractions, not concretions?

#### 3b. Coupling Analysis

Measure and evaluate module coupling:

- **Afferent coupling (Ca):** How many modules depend on this module?
- **Efferent coupling (Ce):** How many modules does this module depend on?
- **Instability (I = Ce / (Ca + Ce)):** Is the module stable (depended-upon) or unstable (depends-on-others)?
- Flag modules with high instability that are also heavily depended-upon (unstable foundation)
- For detailed coupling metrics and patterns, see `references/dependency-patterns.md`

#### 3c. Dependency Direction

Evaluate whether dependencies point in the correct direction:

- Dependencies should flow inward: infrastructure depends on domain, not the reverse
- Core/domain modules should never import from infrastructure, framework, or I/O layers
- Check for proper use of dependency inversion — abstractions at boundaries
- See `references/dependency-patterns.md` for healthy vs unhealthy patterns

#### 3d. God Object Detection

Identify modules with too many responsibilities:

- Modules handling more than 3 distinct concerns
- Files exceeding complexity thresholds (lines, function count, branching depth)
- Classes or modules that are modified in every feature branch (shotgun surgery indicator)
- Modules that import from many unrelated domains

#### 3e. Circular Dependency Identification

Detect import cycles between modules:

- Direct circular imports (A imports B, B imports A)
- Transitive cycles (A -> B -> C -> A)
- Barrel-file-mediated cycles (index.ts re-exports creating hidden loops)
- See `references/dependency-patterns.md` for detection approach and remediation

### Step 4: Output Findings

Format all findings per `@skills/backend-quality/references/findings-format.md`:

- Each finding includes: dimension, severity, file, evidence, root cause, suggested fix
- Findings tagged with provenance (`automated` from scan, `qualitative` from agent assessment)
- Grouped by dimension (Architecture, then Topology), sorted by severity within each group
- Include an executive summary with finding counts by severity

## Error Handling

- **Empty scope:** If the target scope contains no analyzable files (e.g., empty directory, only config files), return an informative message: "No backend source files found in the specified scope. Verify the path and ensure it contains TypeScript/JavaScript source files."
- **Scope validation:** Before analysis, validate that the provided path exists and contains source files. If the path does not exist, report the error immediately rather than producing empty results.
- **Partial failures:** If the deterministic scan fails on a subset of checks, continue with available results and note which checks were skipped in the output.

## References

- `@skills/backend-quality/references/dimensions.md` — Dimension definitions for DIM-1 and DIM-6
- `@skills/backend-quality/references/findings-format.md` — Standard output format for findings
- `references/solid-principles.md` — SOLID principle definitions, violation signals, severity guide, and detection heuristics
- `references/dependency-patterns.md` — Dependency pattern catalog, coupling metrics, circular dependency detection, and layered architecture guidance
