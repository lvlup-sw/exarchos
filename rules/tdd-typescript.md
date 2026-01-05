---
paths: "**/*.ts", "**/*.tsx"
---

# TDD Rules for TypeScript

When modifying TypeScript files, enforce strict TDD:

## Test Framework: Vitest

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

## Required Test Pattern

```typescript
describe('ComponentName', () => {
  describe('methodName', () => {
    it('should do expected behavior when condition', async () => {
      // Arrange
      const input = createTestData();

      // Act
      const result = await component.method(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## TDD Workflow for TypeScript

### RED Phase
1. Create `*.test.ts` file alongside implementation
2. Write test that describes expected behavior
3. Run `npm run test:run` - test MUST fail
4. Verify test fails for the RIGHT reason

### GREEN Phase
1. Write minimum code in `*.ts` to pass test
2. Run `npm run test:run` - test MUST pass
3. No extra features or optimizations

### REFACTOR Phase
1. Clean up code while tests stay green
2. Extract helpers, improve naming
3. Run `npm run test:run` after each change

## Naming Conventions

- Test files: `component.test.ts` (co-located)
- Test names: Describe behavior, not implementation
- Use descriptive `describe` blocks for grouping

## Mocking

```typescript
// Mock modules
vi.mock('./dependency', () => ({
  someFn: vi.fn()
}));

// Mock fetch
fetchMock.mockResponseOnce(JSON.stringify({ data: 'value' }));

// Verify calls
expect(mockFn).toHaveBeenCalledWith(expectedArgs);
```
