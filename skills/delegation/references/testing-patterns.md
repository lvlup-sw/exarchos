# Testing Patterns

Code patterns for TDD implementation. Referenced from `rules/tdd.md`.

## Test File Co-location

Test files live alongside their source files, not in a separate `tests/` directory.

| Language | Source | Test |
|----------|--------|------|
| TypeScript | `src/foo.ts` | `src/foo.test.ts` |
| C# | `Services/OrderService.cs` | `Services/OrderService.Tests.cs` |
| Bash | `scripts/check-pr-comments.sh` | `scripts/check-pr-comments.test.sh` |

## Naming Convention

Tests use `Method_Scenario_Outcome` format:
- TypeScript: `it('GetOrder_InvalidId_ReturnsNotFound', ...)`
- C#: `public async Task GetOrder_InvalidId_ReturnsNotFound()`
- Bash: function name `test_no_args_exit_2`

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

### Mocking

```typescript
vi.mock('./dependency', () => ({ someFn: vi.fn() }));
fetchMock.mockResponseOnce(JSON.stringify({ data: 'value' }));
expect(mockFn).toHaveBeenCalledWith(expectedArgs);
```

## C# (TUnit)

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

## Property-Based Testing (fast-check)

### When to Use

- Data transformations (encode/decode, serialize/deserialize) -> Roundtrip
- State machines (transitions, guards) -> Invariant
- Collections/ordering (sort, filter, pagination) -> Idempotence
- Mathematical operations (scoring, budgets) -> Bounds/constraints
- Concurrency (optimistic locking) -> Linearizability

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

See `pbt-patterns.md` for roundtrip, invariant, idempotence, and commutativity pattern templates.
