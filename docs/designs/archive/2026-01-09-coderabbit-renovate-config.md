# Design: CodeRabbit & Renovate Configuration Consolidation

## Problem Statement

The lvlup-sw organization has fragmented tooling configuration:

1. **CodeRabbit** config exists in `coderabbit-config/config.yaml` but isn't active (must be `.coderabbit.yaml` in repo root)
2. **Custom pre-merge checks** duplicate functionality available via built-in Issue Assessment and Coding Guidelines
3. **Renovate** base config lives in `lvlup-claude` but should be org-wide in `.github`
4. **.NET coding standards** don't exist in a format CodeRabbit can reference

This design consolidates configuration using CodeRabbit's recommended features and establishes org-wide Renovate defaults.

## Chosen Approach

**Per-Repo with Shared References**: Each repo gets its own `.coderabbit.yaml` with Coding Guidelines referencing canonical standards docs. Org defaults (Renovate, labels) live in `.github`.

### Rationale

- Standards docs remain in natural locations (TypeScript in `lvlup-claude`, .NET in `agentic-engine`)
- Each repo customizes Path Instructions for its stack
- Works with current CodeRabbit plan (no org-level config required)
- Clear separation: `.github` = org defaults, repo = specialization

## Technical Design

### 1. CodeRabbit Configuration Changes

#### 1.1 Move Config to Repo Root

**Before:** `coderabbit-config/config.yaml` (inactive)
**After:** `.coderabbit.yaml` (active)

#### 1.2 Replace Custom Checks with Built-in Features

| Current | Replacement |
|---------|-------------|
| Custom SPEC COMPLIANCE | Built-in Issue Assessment (`mode: warning`) |
| Custom CODE QUALITY | Coding Guidelines + Path Instructions |

#### 1.3 Enable Issue Assessment

```yaml
reviews:
  pre_merge_checks:
    issue_assessment:
      mode: warning
```

#### 1.4 Add Coding Guidelines

CodeRabbit's Coding Guidelines feature allows encoding standards that apply to all reviews. Reference the existing rules files:

```yaml
reviews:
  coding_guidelines:
    - title: TypeScript Standards
      description: |
        Follow SOLID principles, type design rules, and control flow patterns
        defined in rules/coding-standards-typescript.md
      file_patterns:
        - "**/*.ts"
        - "**/*.tsx"
    - title: TDD Requirements
      description: |
        Follow TDD workflow (Red-Green-Refactor) and Vitest patterns
        defined in rules/tdd-typescript.md
      file_patterns:
        - "**/*.test.ts"
        - "**/*.spec.ts"
```

#### 1.5 Enhanced Path Instructions

Expand path instructions to reference specific standards:

```yaml
path_instructions:
  - path: "**/*.ts"
    instructions: |
      Apply TypeScript coding standards from rules/coding-standards-typescript.md:
      - SOLID: One class/component per file, no type switches, full interface implementations
      - Types: Interfaces over type aliases, discriminated unions, readonly by default, no `any`
      - Control flow: Guard clauses first, early return, no nested callbacks
  - path: "**/*.test.ts"
    instructions: |
      Apply TDD standards from rules/tdd-typescript.md:
      - Pattern: describe/it blocks with Arrange-Act-Assert
      - Naming: Describe behavior, not implementation
      - Mocking: Use vi.mock for modules, vi.fn for functions
  - path: "**/api/**"
    instructions: |
      Prioritize security: auth validation, input sanitization, error handling.
      No secrets in code, no SQL injection vectors.
  - path: "docs/**"
    instructions: Check for accuracy and completeness. Light review only.
```

### 2. .NET Coding Standards Document

Create `agentic-engine/rules/coding-standards-dotnet.md` mirroring the TypeScript structure:

```markdown
---
paths: "**/*.cs"
---

# Coding Standards for C#/.NET

Apply these standards when reviewing or writing C# code.

## SOLID Constraints

| Principle | C# Constraint |
|-----------|---------------|
| **S**RP | One public type per file, named after the type |
| **O**CP | Use Strategy pattern, not switch/if-else on types |
| **L**SP | No NotImplementedException in overrides |
| **I**SP | Small role-specific interfaces (IReadable, IWritable) |
| **D**IP | Constructor injection, no `new` for services |

## File Organization

- **One public type per file**: `MyClass.cs` contains `public class MyClass`
- **Nested types OK**: Internal/private nested types exempt from file rule
- **Co-locate tests**: `MyClass.Tests.cs` or `Tests/MyClassTests.cs`

## Type Design

| Rule | Standard |
|------|----------|
| Sealed by default | Use `sealed` unless designing for inheritance |
| Composition over inheritance | Avoid hierarchy depth > 2 |
| Records for DTOs | Use `record` for immutable data transfer objects |
| Nullable reference types | Enable `<Nullable>enable</Nullable>` |

## Control Flow

- **Guard clauses first**: Validate preconditions at method entry
- **Early return**: Exit immediately when conditions fail
- **No arrow code**: Avoid deeply nested if/else structures
- **Extract complexity**: Complex boolean logic → helper methods

```csharp
// Preferred: Guard clause
public Result Process(Input? input)
{
    if (input is null) return Result.Failure("No input");
    if (!input.IsValid) return Result.Failure("Invalid");

    // Main logic flat
    return DoWork(input);
}

// Avoid: Arrow code
public Result Process(Input? input)
{
    if (input != null)
    {
        if (input.IsValid)
        {
            // Deeply nested
        }
    }
}
```

## Error Handling

| Pattern | Usage |
|---------|-------|
| Result<T> pattern | For recoverable errors |
| Exceptions | For exceptional conditions only |
| No silent catches | Always log or rethrow |
| Validation at boundaries | Validate external input at API entry |

## Modern C#

- **Pattern matching**: Use `is`, `switch` expressions for type checks
- **Records**: For immutable DTOs and value objects
- **Required members**: Use `required` for mandatory properties
- **Collection expressions**: Use `[1, 2, 3]` syntax where appropriate

## Documentation

- **XML docs required**: All public members need `<summary>`, `<param>`, `<returns>`
- **Use `<list>` and `<para>`**: For complex explanations
- **No redundant comments**: Don't restate what code clearly shows

## Code Organization (DRY)

- Extract duplicated logic into private helpers or extension methods
- Use LINQ for collection operations
- Leverage .NET generic collections and utilities
- Do not re-implement standard library functionality
```

### 3. Renovate Configuration Migration

#### 3.1 Add Base Config to `.github` Repo

Create `.github/renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended"
  ],
  "schedule": [
    "on saturday",
    "on sunday"
  ],
  "timezone": "America/Denver",
  "prConcurrentLimit": 10,
  "prHourlyLimit": 2,
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": "weekly"
  },
  "packageRules": [
    {
      "updateTypes": ["patch"],
      "automerge": true
    }
  ]
}
```

#### 3.2 Keep Presets in `lvlup-claude`

Technology-specific presets remain in `lvlup-claude/renovate-config/presets/`:
- `dotnet.json` - Central Package Management, package groupings

#### 3.3 Update Repo Configs

Each repo's `renovate.json` extends the org default:

**TypeScript repos (lvlup-claude, agentic-workflow):**
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "local>lvlup-sw/.github:renovate.json"
  ]
}
```

**.NET repos (agentic-engine):**
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "local>lvlup-sw/.github:renovate.json",
    "local>lvlup-sw/lvlup-claude:renovate-config/presets/dotnet.json"
  ]
}
```

### 4. Final CodeRabbit Config Structure

#### `lvlup-claude/.coderabbit.yaml`

```yaml
# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json
tone_instructions: Prioritize technical optimality without being nitpicky.
early_access: true

reviews:
  request_changes_workflow: true
  high_level_summary: false
  auto_apply_labels: true
  auto_assign_reviewers: true

  path_filters:
    - "!**/*.lock"
    - "!**/package-lock.json"
    - "!**/yarn.lock"
    - "!**/*.generated.*"
    - "!**/dist/**"
    - "!**/node_modules/**"
    - "!**/*.min.js"

  path_instructions:
    - path: "**/*.ts"
      instructions: |
        Apply TypeScript standards from rules/coding-standards-typescript.md:
        - SOLID: One class/component per file, discriminated unions over type switches
        - Types: Interfaces for extendable shapes, readonly default, no `any`
        - Control: Guard clauses first, early return, flatten async/await
    - path: "**/*.test.ts"
      instructions: |
        Apply TDD standards from rules/tdd-typescript.md:
        - Use describe/it with Arrange-Act-Assert pattern
        - Test behavior not implementation
        - Use vi.mock/vi.fn for dependencies
    - path: "**/api/**"
      instructions: "Prioritize security: auth, input validation, error handling."
    - path: "docs/**"
      instructions: "Check for accuracy and completeness. Light review only."

  coding_guidelines:
    - title: TypeScript SOLID Principles
      description: |
        Enforce SOLID constraints per rules/coding-standards-typescript.md:
        SRP (one export per file), OCP (discriminated unions), LSP (full implementations),
        ISP (small interfaces), DIP (inject dependencies)
      file_patterns:
        - "**/*.ts"
        - "**/*.tsx"
    - title: Type Safety
      description: |
        No `any` types. Use `unknown` with type guards or proper generics.
        Prefer interfaces over type aliases for extendable shapes.
        Use `as const` for literal types, `satisfies` for type checking without widening.
      file_patterns:
        - "**/*.ts"
        - "**/*.tsx"
    - title: TDD Compliance
      description: |
        Tests must follow Red-Green-Refactor. Use Vitest patterns.
        Test names describe behavior: "should [expected behavior] when [condition]"
      file_patterns:
        - "**/*.test.ts"
        - "**/*.spec.ts"

  auto_review:
    ignore_usernames:
      - "renovate[bot]"

  pre_merge_checks:
    issue_assessment:
      mode: warning
```

#### `agentic-engine/.coderabbit.yaml`

```yaml
# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json
tone_instructions: Prioritize technical optimality without being nitpicky.
early_access: true

reviews:
  request_changes_workflow: true
  high_level_summary: false
  auto_apply_labels: true
  auto_assign_reviewers: true

  path_filters:
    - "!**/bin/**"
    - "!**/obj/**"
    - "!**/*.generated.cs"

  path_instructions:
    - path: "**/*.cs"
      instructions: |
        Apply C# standards from rules/coding-standards-dotnet.md:
        - SOLID: One public type per file, Strategy over switches, constructor injection
        - Types: Sealed by default, records for DTOs, nullable enabled
        - Control: Guard clauses first, early return, no arrow code
    - path: "**/Tests/**"
      instructions: |
        Focus on test coverage, assertion quality, edge cases.
        Ensure TUnit assertions are awaited. Use Method_Scenario_Outcome naming.
    - path: "**/src/**/*.cs"
      instructions: |
        Check: guard clauses at method start, Result<T> for failures, XML docs on public members.
    - path: "docs/**"
      instructions: "Check for accuracy and completeness. Light review only."

  coding_guidelines:
    - title: C# SOLID Principles
      description: |
        Enforce SOLID constraints per rules/coding-standards-dotnet.md:
        SRP (one public type per file), OCP (Strategy pattern), LSP (no NotImplementedException),
        ISP (role-specific interfaces), DIP (constructor injection)
      file_patterns:
        - "**/*.cs"
    - title: Type Safety
      description: |
        Enable nullable reference types. Use sealed by default.
        Prefer records for immutable data. Use pattern matching for type checks.
      file_patterns:
        - "**/*.cs"
    - title: Documentation
      description: |
        All public members require XML documentation with <summary>, <param>, <returns>.
        Use <list> and <para> for complex explanations.
      file_patterns:
        - "**/*.cs"

  auto_review:
    ignore_usernames:
      - "renovate[bot]"

  pre_merge_checks:
    issue_assessment:
      mode: warning
```

## Integration Points

### Affected Repositories

| Repository | Changes |
|------------|---------|
| `lvlup-claude` | Move `.coderabbit.yaml` to root, update config, simplify `renovate.json` |
| `agentic-engine` | Update `.coderabbit.yaml`, add `rules/coding-standards-dotnet.md`, update `renovate.json` |
| `agentic-workflow` | Add/update `.coderabbit.yaml`, update `renovate.json` |
| `.github` | Add `renovate.json` base config |

### File Changes Summary

```
.github/
  renovate.json                          # NEW: Org base config

lvlup-claude/
  .coderabbit.yaml                       # NEW: Moved from coderabbit-config/
  coderabbit-config/config.yaml          # DELETE: Moved to root
  renovate.json                          # UPDATE: Extend from .github

agentic-engine/
  .coderabbit.yaml                       # UPDATE: New structure
  rules/coding-standards-dotnet.md       # NEW: .NET standards
  renovate.json                          # UPDATE: Extend from .github

agentic-workflow/
  .coderabbit.yaml                       # NEW or UPDATE
  renovate.json                          # UPDATE: Extend from .github
```

## Testing Strategy

### CodeRabbit Validation

1. Create test PR in each repo after config changes
2. Verify Issue Assessment check appears
3. Verify Coding Guidelines are applied in review comments
4. Confirm Path Instructions trigger for correct file types

### Renovate Validation

1. Trigger Renovate dry-run: `renovate --dry-run lvlup-sw/<repo>`
2. Verify inheritance chain resolves correctly
3. Confirm package groupings work for .NET repos
4. Test automerge behavior on patch updates

### Standards Document Validation

1. Review .NET standards doc for completeness vs TypeScript version
2. Verify code examples compile
3. Cross-reference with `apply-best-practices.md` for coverage

## Open Questions

1. **CodeRabbit Coding Guidelines limit**: Need to verify max number of guidelines per repo
2. **Renovate inheritance syntax**: Confirm `local>` syntax works for org repos
3. **agentic-workflow stack**: Verify if it needs TypeScript or .NET path instructions

## Rollout Plan

### Phase 1: Foundation
- Create .NET coding standards document
- Add Renovate base config to `.github`

### Phase 2: lvlup-claude
- Move CodeRabbit config to root
- Update with new structure
- Update Renovate to extend `.github`

### Phase 3: agentic-engine
- Update CodeRabbit config
- Add .NET standards doc
- Update Renovate config

### Phase 4: agentic-workflow
- Add/update CodeRabbit config
- Update Renovate config

### Phase 5: Cleanup
- Delete old `coderabbit-config/` directory
- Archive or remove unused config files
