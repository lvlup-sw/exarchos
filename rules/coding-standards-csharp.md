---
paths: "**/*.cs"
---

# Coding Standards for C#

Apply these standards when reviewing or writing C# code.

## SOLID Constraints

| Principle | C# Constraint |
|-----------|---------------|
| **S**RP | One public type per file. File name must match type name. |
| **O**CP | No `switch` on types/enums for logic. Use polymorphism (Strategy Pattern). |
| **L**SP | Subclasses must not throw `NotImplementedException` or `NotSupportedException`. |
| **I**SP | Small role-specific interfaces (e.g., `IReadable`, `IWritable`). |
| **D**IP | All dependencies via constructor injection. Never `new` concrete services. |

## File Organization

- **One public type per file**: Each `public` class, record, struct, interface, or enum in its own file
- **File naming**: File name matches type name (e.g., `MyClass.cs` for `public class MyClass`)
- **Nested types exempt**: Internal/private nested types can remain in parent file

## Class Design

| Rule | Rationale |
|------|-----------|
| `sealed` by default | Explicitly design for inheritance or seal |
| Inheritance depth <= 2 | Deeper hierarchies → refactor to composition |
| Composition over inheritance | Prefer delegation for code reuse |

## Control Flow

- **Guard clauses first**: Validate preconditions at method entry
- **Early return**: Exit as soon as result is known
- **No arrow code**: Avoid deeply nested if/else structures
- **Extract complexity**: Large conditionals → private helpers or strategy classes

```csharp
// Preferred: Guard clause
public void Process(Input input)
{
    if (input == null) return;
    if (!input.IsValid) throw new ArgumentException();

    // Main logic flat
}

// Avoid: Arrow code
public void Process(Input input)
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

## Code Organization (DRY)

- Extract duplicated logic into private helpers or shared utilities
- Use built-in LINQ, String methods, and generic collections
- Do not re-implement standard library functionality

## Documentation

| Requirement | Standard |
|-------------|----------|
| XML docs | Required for all `public` members |
| Tags | `<summary>`, `<param>`, `<returns>` mandatory |
| Exceptions | Use `<exception cref="...">` for thrown exceptions |
| Complex docs | Use `<list>` and `<para>` for structure |

## .NET Best Practices

- **Use records**: For immutable data transfer objects
- **Use `required` modifier**: For mandatory properties (C# 11+)
- **Prefer LINQ**: Over manual iteration
- **Use pattern matching**: For type checks and deconstruction
