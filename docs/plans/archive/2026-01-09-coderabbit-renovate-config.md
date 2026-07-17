# Implementation Plan: CodeRabbit & Renovate Configuration

## Source Design

Link: `docs/designs/2026-01-09-coderabbit-renovate-config.md`

## Summary

- Total tasks: 8
- Parallel groups: 3
- Repositories affected: 4 (.github, lvlup-claude, agentic-engine, agentic-workflow)

## Note on TDD for Configuration

This implementation involves configuration files (YAML, JSON, Markdown) rather than executable code. Instead of unit tests, each task includes **validation steps** to verify correctness:
- YAML/JSON schema validation
- Dry-run commands where available
- Manual verification checklists

---

## Task Breakdown

### Task 001: Create .NET Coding Standards Document

**Phase:** CREATE → VALIDATE

**Steps:**
1. [CREATE] Write .NET standards document
   - File: `agentic-engine/rules/coding-standards-dotnet.md`
   - Content: Mirror TypeScript structure with C#-specific rules
   - Source: `apply-best-practices.md` + TypeScript template

2. [VALIDATE] Verify document structure
   - Has frontmatter with `paths: "**/*.cs"`
   - Contains all sections: SOLID, File Organization, Type Design, Control Flow, Error Handling, Modern C#, Documentation, DRY
   - Code examples are valid C# syntax

**Verification:**
- [ ] Document follows TypeScript standards structure
- [ ] All code examples compile conceptually
- [ ] Cross-referenced with `apply-best-practices.md`

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/001-dotnet-standards`

---

### Task 002: Add Renovate Base Config to .github

**Phase:** CREATE → VALIDATE

**Steps:**
1. [CREATE] Write org-wide Renovate config
   - File: `.github/renovate.json`
   - Content: Base config from design (schedule, timezone, limits, automerge)

2. [VALIDATE] Verify JSON schema
   - Run: `npx renovate-config-validator .github/renovate.json` (if available)
   - Or: Validate JSON syntax and schema reference

**Verification:**
- [ ] Valid JSON syntax
- [ ] Schema reference correct
- [ ] Contains: schedule, timezone, prConcurrentLimit, prHourlyLimit, lockFileMaintenance, packageRules

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/002-renovate-org-config`

---

### Task 003: Update lvlup-claude CodeRabbit Config

**Phase:** CREATE → MIGRATE → VALIDATE

**Steps:**
1. [CREATE] Write new CodeRabbit config at repo root
   - File: `lvlup-claude/.coderabbit.yaml`
   - Content: New structure with Issue Assessment, Coding Guidelines, expanded Path Instructions
   - Remove: Custom SPEC COMPLIANCE and CODE QUALITY checks

2. [MIGRATE] Mark old config for deletion
   - File: `lvlup-claude/coderabbit-config/config.yaml` → DELETE

3. [VALIDATE] Verify YAML structure
   - Valid YAML syntax
   - Schema reference: `https://coderabbit.ai/integrations/schema.v2.json`
   - Contains: tone_instructions, reviews.pre_merge_checks.issue_assessment, reviews.coding_guidelines, reviews.path_instructions

**Verification:**
- [ ] Valid YAML syntax
- [ ] Issue Assessment enabled with mode: warning
- [ ] 3 Coding Guidelines defined
- [ ] 4 Path Instructions defined
- [ ] Old custom checks removed

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/003-lvlup-claude-coderabbit`

---

### Task 004: Update lvlup-claude Renovate Config

**Phase:** UPDATE → VALIDATE

**Steps:**
1. [UPDATE] Simplify Renovate config to extend org default
   - File: `lvlup-claude/renovate.json`
   - Content: Extend from `local>lvlup-sw/.github:renovate.json`

2. [VALIDATE] Verify inheritance
   - Valid JSON syntax
   - Extends reference is correct

**Verification:**
- [ ] Valid JSON syntax
- [ ] Extends from org config
- [ ] No duplicate settings that override org defaults

**Dependencies:** Task 002 (org config must exist)
**Parallelizable:** No (depends on 002)
**Branch:** `feature/004-lvlup-claude-renovate`

---

### Task 005: Update agentic-engine CodeRabbit Config

**Phase:** UPDATE → VALIDATE

**Steps:**
1. [UPDATE] Rewrite CodeRabbit config with .NET focus
   - File: `agentic-engine/.coderabbit.yaml`
   - Content: New structure with Issue Assessment, C# Coding Guidelines, .NET Path Instructions
   - Reference: `rules/coding-standards-dotnet.md`

2. [VALIDATE] Verify YAML structure
   - Valid YAML syntax
   - C#-specific path filters (bin, obj, generated.cs)
   - References .NET standards doc

**Verification:**
- [ ] Valid YAML syntax
- [ ] Issue Assessment enabled
- [ ] 3 Coding Guidelines for C#
- [ ] Path Instructions reference .NET standards
- [ ] Path filters exclude bin/obj

**Dependencies:** Task 001 (.NET standards doc must exist)
**Parallelizable:** No (depends on 001)
**Branch:** `feature/005-agentic-engine-coderabbit`

---

### Task 006: Update agentic-engine Renovate Config

**Phase:** UPDATE → VALIDATE

**Steps:**
1. [UPDATE] Renovate config to extend org + dotnet preset
   - File: `agentic-engine/renovate.json`
   - Content: Extend from org config + lvlup-claude dotnet preset

2. [VALIDATE] Verify inheritance chain
   - Valid JSON syntax
   - Both extends references correct

**Verification:**
- [ ] Valid JSON syntax
- [ ] Extends org config
- [ ] Extends dotnet preset

**Dependencies:** Task 002 (org config must exist)
**Parallelizable:** No (depends on 002)
**Branch:** `feature/006-agentic-engine-renovate`

---

### Task 007: Update agentic-workflow Configs

**Phase:** CREATE/UPDATE → VALIDATE

**Steps:**
1. [CREATE/UPDATE] CodeRabbit config for .NET
   - File: `agentic-workflow/.coderabbit.yaml`
   - Content: Same structure as agentic-engine (both are .NET)

2. [UPDATE] Renovate config to extend org + dotnet preset
   - File: `agentic-workflow/renovate.json`
   - Content: Extend from org config + dotnet preset

3. [VALIDATE] Verify both configs
   - Valid YAML/JSON syntax
   - Correct extends references

**Verification:**
- [ ] CodeRabbit config valid YAML
- [ ] Renovate config valid JSON
- [ ] Both reference correct org/preset sources

**Dependencies:** Task 001 (standards), Task 002 (org renovate)
**Parallelizable:** No (depends on 001, 002)
**Branch:** `feature/007-agentic-workflow-configs`

---

### Task 008: Cleanup Old Config Files

**Phase:** DELETE → VALIDATE

**Steps:**
1. [DELETE] Remove old CodeRabbit config directory
   - Delete: `lvlup-claude/coderabbit-config/` (entire directory)

2. [VALIDATE] Verify cleanup
   - Old directory no longer exists
   - No orphaned references in other files

**Verification:**
- [ ] `coderabbit-config/` directory removed
- [ ] No broken references to old config location

**Dependencies:** Task 003 (new config must be in place first)
**Parallelizable:** No (depends on 003)
**Branch:** `feature/008-cleanup`

---

## Parallelization Strategy

### Phase 1: Foundation (Parallel)

```
┌─────────────────────────────────────────────┐
│  Can run simultaneously in separate repos   │
├─────────────────────────────────────────────┤
│  Task 001: .NET Standards (agentic-engine)  │
│  Task 002: Renovate Org (.github)           │
│  Task 003: CodeRabbit (lvlup-claude)        │
└─────────────────────────────────────────────┘
```

**Worktree assignments:**
- Worktree A: Task 001 → agentic-engine
- Worktree B: Task 002 → .github repo
- Worktree C: Task 003 → lvlup-claude

### Phase 2: Dependent Updates (Sequential per repo)

```
After Phase 1 completes:

Task 001 ──→ Task 005 (agentic-engine CodeRabbit)
Task 002 ──→ Task 004 (lvlup-claude Renovate)
         ──→ Task 006 (agentic-engine Renovate)
         ──→ Task 007 (agentic-workflow)
Task 003 ──→ Task 008 (cleanup)
```

**Execution order:**
1. Task 004 (depends on 002)
2. Task 005 (depends on 001)
3. Task 006 (depends on 002)
4. Task 007 (depends on 001, 002)
5. Task 008 (depends on 003)

### Phase 3: Final Cleanup

Task 008 runs last after all configs are in place.

---

## Dependency Graph

```
001 ─────────────────────┬──→ 005 ──→ (done)
                         │
                         └──→ 007 ──→ (done)

002 ───┬──→ 004 ──→ (done)
       │
       ├──→ 006 ──→ (done)
       │
       └──→ 007 ──→ (done)

003 ──→ 008 ──→ (done)
```

---

## Completion Checklist

- [ ] All 4 repos have valid `.coderabbit.yaml`
- [ ] All 4 repos have valid `renovate.json` extending org config
- [ ] .NET standards document exists in agentic-engine
- [ ] Old coderabbit-config directory removed from lvlup-claude
- [ ] Issue Assessment enabled in all repos
- [ ] Coding Guidelines defined per technology stack
- [ ] Path Instructions reference standards documents
