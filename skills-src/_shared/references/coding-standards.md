---
paths: "**/*.ts", "**/*.tsx", "**/*.cs"
---

# Coding Standards

Apply these standards when reviewing or writing TypeScript or C# code.

## SOLID Constraints

| Principle | TypeScript | C# |
|-----------|-----------|-----|
| **S**RP | One primary component/class per file | One public type per file; filename matches type name |
| **O**CP | Discriminated unions or strategy pattern, not type switches | No `switch` on types/enums for logic; use polymorphism |
| **L**SP | Implement all interface methods fully | Subclasses must not throw `NotImplementedException` |
| **I**SP | Small focused interfaces, composed as needed | Small role-specific interfaces (e.g., `IReadable`, `IWritable`) |
| **D**IP | Depend on interfaces, inject implementations | All dependencies via constructor injection; never `new` concrete services |

## Control Flow

- **Guard clauses first**: Validate/narrow at function entry
- **Early return**: Exit immediately when conditions fail
- **No arrow code**: Flatten nested conditionals with early returns
- **Extract complexity**: Complex conditions into named predicates/helpers

## Error Handling

| Pattern | TypeScript | C# |
|---------|-----------|-----|
| Recoverable errors | Result types (consider `neverthrow`) | `Result<T>` pattern |
| Programmer errors | Custom error classes with discriminated unions | Exceptions + `ArgumentNullException.ThrowIfNull()` |
| Silent catches | Never — always handle or rethrow | Never — always handle or rethrow |
| Boundaries | Explicit error boundaries at API/UI layers | Explicit error boundaries at API/UI layers |

## Code Organization (DRY)

- Extract duplicated logic into utility functions/helpers
- Use built-in collection methods (TS: `map`/`filter`/`reduce`; C#: LINQ)
- Leverage standard utility types (TS: `Partial`, `Pick`, `Omit`; C#: generics, records)
- Do not re-implement standard library functionality

---

For TypeScript-specific standards, see `@skills/quality-review/references/typescript-standards.md`.

For C#-specific standards, see `@skills/dotnet-standards/references/csharp-standards.md`.
