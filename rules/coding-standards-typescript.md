---
paths: "**/*.ts", "**/*.tsx"
---

# Coding Standards for TypeScript

Apply these standards when reviewing or writing TypeScript code.

## SOLID Constraints

| Principle | TypeScript Constraint |
|-----------|----------------------|
| **S**RP | One primary component/class per file |
| **O**CP | Use discriminated unions or strategy pattern, not type switches |
| **L**SP | Implement all interface methods fully |
| **I**SP | Small focused interfaces, composed as needed |
| **D**IP | Depend on interfaces, inject implementations |

## File Organization

- **One primary export per file**: Main class/function/component as default or named export
- **Barrel exports OK**: `index.ts` can re-export from module
- **Co-locate tests**: `component.test.ts` alongside `component.ts`

## Type Design

| Rule | Standard |
|------|----------|
| Interfaces over type aliases | For object shapes that might be extended |
| Discriminated unions | For type-safe variant handling |
| `readonly` by default | For properties that shouldn't change |
| No `any` | Use `unknown` with type guards or proper generics |
| Strict mode | `strict: true` in tsconfig required |

## Control Flow

- **Guard clauses first**: Type narrowing at function entry
- **Early return**: Exit immediately when conditions fail
- **No pyramid of doom**: Flatten nested callbacks with async/await
- **Extract complexity**: Complex conditions → named predicates

```typescript
// Preferred: Guard clause with type narrowing
function process(input: Input | null): Result {
  if (!input) return { error: 'No input' };
  if (!isValid(input)) return { error: 'Invalid' };

  // Main logic flat, input is narrowed
  return doWork(input);
}

// Avoid: Arrow code
function process(input: Input | null): Result {
  if (input) {
    if (isValid(input)) {
      // Deeply nested
    }
  }
}
```

## Error Handling

| Pattern | Usage |
|---------|-------|
| Result types | For recoverable errors (consider `neverthrow`) |
| Type-safe errors | Custom error classes with discriminated unions |
| No silent catches | Always handle or rethrow |
| Explicit error boundaries | At API/UI boundaries |

## Modern TypeScript

- **Const assertions**: Use `as const` for literal types
- **Template literal types**: For string pattern validation
- **No assertions without guards**: `as` requires prior type check
- **Satisfies operator**: For type checking without widening

## Code Organization (DRY)

- Extract duplicated logic into utility functions
- Use built-in array methods (map, filter, reduce)
- Leverage TypeScript utility types (Partial, Pick, Omit, etc.)
- Do not re-implement standard library functionality
