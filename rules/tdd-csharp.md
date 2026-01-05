---
paths: "**/*.cs"
---

# TDD Rules for C#

When modifying C# files, enforce strict TDD using TUnit.

## Test Framework: TUnit

All tests MUST:
- Use `[Test]` attribute
- Be `async Task` (not `void`)
- Await all assertions
- Follow AAA pattern (Arrange-Act-Assert)

## Required Test Pattern

```csharp
[Test]
public async Task MethodName_Scenario_ExpectedOutcome()
{
    // Arrange - Set up test data and dependencies
    var sut = new SystemUnderTest();

    // Act - Execute the method being tested
    var result = sut.Method();

    // Assert - Verify the outcome (MUST await)
    await Assert.That(result).IsEqualTo(expected);
}
```

## TDD Workflow for C#

### RED Phase
1. Create test class in corresponding `*.Tests` project
2. Write test with `[Test]` attribute
3. Run `dotnet test` - test MUST fail
4. Verify test fails for the RIGHT reason (not compilation error)

### GREEN Phase
1. Write minimum code to make test pass
2. Run `dotnet test` - test MUST pass
3. No extra features or error handling beyond test requirements

### REFACTOR Phase
1. Apply SOLID principles
2. Extract methods for clarity
3. Add guard clauses where appropriate
4. Run `dotnet test` after each change - tests MUST stay green

## Assertions (Always Await)

```csharp
// Equality
await Assert.That(actual).IsEqualTo(expected);

// Boolean
await Assert.That(condition).IsTrue();
await Assert.That(condition).IsFalse();

// Null
await Assert.That(value).IsNull();
await Assert.That(value).IsNotNull();

// Collections
await Assert.That(collection).IsNotEmpty();
await Assert.That(collection).Contains(item);
await Assert.That(collection).HasCount(3);

// Exceptions
await Assert.That(() => sut.Method()).Throws<ArgumentException>();
```

## Parameterized Tests

```csharp
[Test]
[Arguments(2, 3, 5)]
[Arguments(0, 0, 0)]
[Arguments(-1, 1, 0)]
public async Task Add_VariousInputs_ReturnsExpectedSum(int a, int b, int expected)
{
    var result = _calculator.Add(a, b);
    await Assert.That(result).IsEqualTo(expected);
}
```

## Setup and Cleanup

```csharp
public class MyTests
{
    private IService? _service;

    [Before(Test)]
    public async Task Setup()
    {
        _service = new Service();
        await _service.InitializeAsync();
    }

    [After(Test)]
    public async Task Cleanup()
    {
        if (_service is IAsyncDisposable disposable)
        {
            await disposable.DisposeAsync();
        }
    }
}
```
