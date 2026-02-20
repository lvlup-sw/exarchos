---
paths: "**/*.ts", "**/*.tsx", "**/*.cs"
---

# TDD Rules

Enforce strict TDD when modifying TypeScript or C# files.

## TDD Workflow

### RED Phase
1. Write a test that describes expected behavior
2. Run tests — test MUST fail
3. Verify it fails for the RIGHT reason (not a compilation error)

### GREEN Phase
1. Write the minimum code to make the test pass
2. Run tests — test MUST pass
3. No extra features or optimizations

### REFACTOR Phase
1. Clean up code while tests stay green
2. Extract helpers, improve naming, apply SOLID
3. Run tests after each change

---

## TypeScript (Vitest)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

### Test Pattern

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

### Conventions

- Test files: `component.test.ts` (co-located)
- Test names: Describe behavior, not implementation
- Run: `npm run test:run`

### Mocking

```typescript
vi.mock('./dependency', () => ({ someFn: vi.fn() }));
fetchMock.mockResponseOnce(JSON.stringify({ data: 'value' }));
expect(mockFn).toHaveBeenCalledWith(expectedArgs);
```

---

## C\# (TUnit)

All tests MUST use `[Test]` attribute, be `async Task`, and await all assertions.

### Test Pattern

```csharp
[Test]
public async Task MethodName_Scenario_ExpectedOutcome()
{
    // Arrange
    var mockRepo = Substitute.For<IRepository>();
    mockRepo.FindAsync(Arg.Any<Guid>()).Returns(expectedOrder);
    var sut = new OrderService(mockRepo);

    // Act
    var result = await sut.GetOrderAsync(orderId);

    // Assert (MUST await)
    await Assert.That(result.IsSuccess).IsTrue();
    await Assert.That(result.Value.Id).IsEqualTo(orderId);
}
```

### Conventions

- Test files: `*.Tests.cs` (co-located) or `*Tests.cs`
- Run: `dotnet test`

### Assertions

```csharp
await Assert.That(actual).IsEqualTo(expected);
await Assert.That(condition).IsTrue();
await Assert.That(value).IsNotNull();
await Assert.That(collection).Contains(item);
await Assert.That(collection).HasCount(3);
await Assert.That(() => sut.Method()).Throws<ArgumentException>();
```

### Parameterized Tests

```csharp
[Test]
[Arguments(2, 3, 5)]
[Arguments(0, 0, 0)]
public async Task Add_VariousInputs_ReturnsExpectedSum(int a, int b, int expected)
{
    var result = _calculator.Add(a, b);
    await Assert.That(result).IsEqualTo(expected);
}
```

### Setup/Cleanup

```csharp
[Before(Test)]
public async Task Setup() { _service = new Service(); }

[After(Test)]
public async Task Cleanup() { /* dispose */ }
```

### Mocking (NSubstitute)

```csharp
var mock = Substitute.For<IOrderService>();
mock.GetOrderAsync(Arg.Any<Guid>()).Returns(Result<Order>.Success(order));
await mock.Received(1).GetOrderAsync(expectedId);
await mock.DidNotReceive().DeleteAsync(Arg.Any<Guid>());
```

---

## Property-Based Testing (fast-check)

### When to Use

- Data transformations (encode/decode, serialize/deserialize) → Roundtrip
- State machines (transitions, guards) → Invariant
- Collections/ordering (sort, filter, pagination) → Idempotence
- Mathematical operations (scoring, budgets) → Bounds/constraints
- Concurrency (optimistic locking) → Linearizability

### Import

```typescript
import { it, fc } from '@fast-check/vitest';
```

### Basic Usage

```typescript
it.prop([fc.array(fc.integer())], (arr) => {
  expect(sort(sort(arr))).toEqual(sort(arr));
});
```

See `@skills/delegation/references/pbt-patterns.md` for roundtrip, invariant, idempotence, and commutativity pattern templates.

Property tests are written alongside example tests in the RED phase. They complement, not replace, example tests.
