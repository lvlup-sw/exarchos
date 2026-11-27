# Testing Patterns

Code patterns for test implementation, and the probe command that runs declared test files.

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

## The Probe Command of Declared Tests

`spec_coverage_check` runs each test file that the plan declares with the probe
command, one file at a time, and each run must pass. The probe selects its command
in this order:

1. When `.exarchos.yml` sets `verification.tests.probe`, the probe runs its `command`.
2. When `package.json` has a `test:files` script, the probe runs
   `npm run test:files -- <files>`. A pnpm, yarn or bun project uses its own
   `run test:files` form. The script comes first, also when `.exarchos.yml` sets `test`.
3. Without the script, the probe runs the resolved `test` command.

The script must run only the files that it gets. Add the script when the `test`
command does not run each file that it gets, for example a vitest command with a
`--project` filter.

### The File Form of the Probe Command

Each probe command takes its file form and its red codes from the seed row of its
program, unless `verification.tests.probe` sets `files` or `failureExitCodes`:

- `after-separator` puts the files after `--`, as in `npm run test:files -- <files>`.
- `as-arguments` puts the files after the command with no separator, as in `bun test <files>`.
- `none` runs the whole test command once, with no file. The seeds of .NET, Rust, Go,
  Ruby, Java, Swift and CMake, and each task-runner target, use `none`.

A command whose program has no seed row takes `after-separator`, and only exit 1 is red.

### Test Files

The probe reads a file as a test when a glob of the resolved test globs matches it.
The seeds are the co-located globs `**/*.test.*`, `**/*.spec.*` and `**/__tests__/**`,
every glob of the first matched toolchain, and the test-name globs of each other
matched toolchain. `verification.tests.globs` replaces them.

A declared test file that the probe command cannot run, such as a C# test in a Node
root, fails. Set `verification.tests.probe` to a command that runs the file, or set
`verification.tests.globs` to the test files that the probe command runs. In a root
where more than one toolchain matches, `verification.tests.probe` needs
`verification.tests.globs` beside it, else the check fails with `profile-unresolved`.

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
