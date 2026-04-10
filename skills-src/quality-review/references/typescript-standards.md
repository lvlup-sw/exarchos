# TypeScript Standards

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

## Modern TypeScript

- **Const assertions**: Use `as const` for literal types
- **Template literal types**: For string pattern validation
- **No assertions without guards**: `as` requires prior type check
- **Satisfies operator**: For type checking without widening
