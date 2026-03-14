---
name: distill
description: "Strip backend code to its essence by identifying dead code, vestigial patterns, and unnecessary complexity. Use when cleaning up after refactoring or reducing cognitive load. Triggers: 'simplify code', 'find dead code', 'clean up', or /assay:distill. Do NOT use for error handling — use assay:harden instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - hygiene
    - topology
---

# Distill Skill

## Overview

Simplification skill for the assay backend quality plugin. Covers DIM-5 (Hygiene) and DIM-1 (Topology) dimensions to strip code down to its essential form by identifying dead code, vestigial patterns, and unnecessary complexity.

## Triggers

Activate this skill when:
- User says "simplify code", "find dead code", "clean up"
- User runs `/assay:distill`
- Post-refactoring cleanup is needed
- Reducing cognitive load in a module

Do NOT activate when:
- Error handling improvements are needed — use `assay:harden` instead
- Performance optimization is the goal — performance profiling is out of scope for assay
- Security hardening is required — use `assay:harden` instead

## Process

### 1. Load Dimensions

Load the relevant quality dimensions from `@skills/backend-quality/references/dimensions.md`:
- **DIM-5 (Hygiene):** Dead code, commented-out code, unused imports/exports, vestigial patterns
- **DIM-1 (Topology):** Module structure, dependency direction, wiring complexity

### 2. Run Deterministic Checks

Run `assay:scan` for deterministic checks on Hygiene and Topology dimensions. This produces machine-verifiable findings for:
- Unused exports and imports
- Unreachable code paths
- Circular dependencies
- Excessive module fan-out

### 3. Layer Qualitative Assessment

Beyond deterministic checks, apply human-judgment analysis:

#### Dead Code Identification
Identify unreachable branches (code after `return`/`throw`), unused exports (exported but never imported elsewhere), commented-out code (version control exists for history), and feature-flagged-off code that shipped long ago.

See `@skills/distill/references/dead-code-patterns.md` for detection heuristics and false positive guidance.

#### Vestigial Pattern Detection
Find evolutionary leftovers from previous designs. Look for divergent implementations that suggest a pattern was partially migrated, adapter layers wrapping things that no longer need adapting, and configuration for features that were removed.

#### Wiring Simplification
Identify manual DI that could be simpler, unnecessary indirection layers, over-abstracted factory/builder patterns where direct construction suffices, and registration ceremonies that add complexity without value.

#### Abstraction Audit
Flag premature abstractions, over-engineering, and single-use helpers. Ask: does this abstraction serve more than one caller? Would inlining it make the code clearer?

#### Code Archaeology
Identify patterns that were once necessary but no longer serve a purpose. Look for workarounds for bugs that have since been fixed, compatibility shims for deprecated APIs, and defensive code guarding against conditions that can no longer occur.

### 4. Output Findings

Format all findings per `@skills/backend-quality/references/findings-format.md`. Each finding includes:
- Dimension (DIM-5 or DIM-1)
- Severity (HIGH, MEDIUM, LOW)
- Location (file, line range)
- Description and recommended action

See also `@skills/distill/references/simplification-guide.md` for guidance on when to simplify vs remove.

## Error Handling

- **Empty scope:** If no files match the target scope, output an informative message explaining that no files were found and suggesting the user verify the path or scope parameters.
- **No findings:** If analysis completes with zero findings, report a clean result rather than failing silently.
