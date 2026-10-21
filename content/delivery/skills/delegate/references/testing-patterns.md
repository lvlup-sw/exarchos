# Testing Patterns

Code patterns for test implementation, and the test command that the kill probe runs.

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

## The Test Command of the Kill Probe

The `check_test_adequacy` kill probe runs only the changed test files of the task.
It runs them on the task source first. A red run there gives the indeterminate
cause `baseline-red`, and the gate blocks at every tier. Then the probe reverts the
source hunks and runs the tests again.

When the gate gives `baseline-red`, make the scoped tests pass on the task source,
then run `check_test_adequacy` again. If the tests pass when you run them, the probe
can run a different command. The probe selects its command in this order:

1. When `package.json` has a `test:files` script, the probe runs
   `npm run test:files -- <files>`. A pnpm, yarn or bun project uses its own
   `run test:files` form. The script comes first, also when `.exarchos.yml` sets `test`.
2. Without the script, the probe runs the resolved `test` command with `-- <files>` after it.

The script must run only the files that it gets. Add the script when the `test`
command does not run each file that it gets, for example a vitest command with a
`--project` filter.

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
