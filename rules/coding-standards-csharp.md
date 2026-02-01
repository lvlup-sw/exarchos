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

## File Headers (Required)

All C# files must include this copyright header:

```csharp
// =============================================================================
// <copyright file="FileName.cs" company="Levelup Software">
// Copyright (c) Levelup Software. All rights reserved.
// </copyright>
// =============================================================================
```

Replace `FileName.cs` with the actual file name.

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Classes/Records | PascalCase | `OrderService`, `OrderCreatedEvent` |
| Interfaces | `I` prefix + PascalCase | `IOrderRepository` |
| Methods | PascalCase | `ProcessOrderAsync` |
| Properties | PascalCase | `OrderId`, `IsValid` |
| Private fields | `_camelCase` | `_repository`, `_logger` |
| Static fields | `s_camelCase` | `s_sharedInstance` |
| Constants | PascalCase | `MaxRetryCount` |
| Parameters | camelCase | `orderId`, `cancellationToken` |
| Local variables | camelCase | `orderTotal`, `isValid` |
| Type parameters | `T` prefix | `TEntity`, `TResult` |
| Async methods | `Async` suffix | `GetOrderAsync` |

### File Naming

- File name matches type name exactly: `OrderService.cs`
- Test files: `OrderService.Tests.cs` (co-located) or `OrderServiceTests.cs`
- Extension classes: `ServiceCollectionExtensions.cs`

## Code Organization

### Member Ordering

1. Constants and static readonly fields
2. Private readonly fields
3. Properties (public, then private)
4. Constructors
5. Public methods
6. Private methods
7. Nested types (if any)

### Using Statements

- Use file-scoped namespaces: `namespace Agentic.Core;`
- Global usings in `GlobalUsings.cs` for common imports
- Group: System namespaces → Third-party → Application namespaces

## Async/Await

| Rule | Standard |
|------|----------|
| Suffix | All async methods end with `Async` |
| ConfigureAwait | Use `.ConfigureAwait(false)` in library code |
| CancellationToken | Accept as final optional parameter with `default` value |
| Return types | Prefer `Task<T>`, `Task`, or `IAsyncEnumerable<T>` |
| Avoid async void | Only use for event handlers |

### Streaming Pattern

```csharp
// IAsyncEnumerable for streaming - no await when returning directly
public IAsyncEnumerable<T> StreamAsync(CancellationToken ct = default)
{
    return _inner.StreamAsync(ct);
}
```

### CancellationToken Pattern

```csharp
public async Task<Result<T>> ProcessAsync(
    Input input,
    CancellationToken cancellationToken = default)
{
    cancellationToken.ThrowIfCancellationRequested();
    return await _service.ExecuteAsync(input, cancellationToken)
        .ConfigureAwait(false);
}
```

## Error Handling

| Pattern | Usage |
|---------|-------|
| `Result<T>` | Business failures (expected, recoverable) |
| Exceptions | Programmer errors (null args, invalid state) |
| Guard clauses | `ArgumentNullException.ThrowIfNull()` |

### Result Pattern

```csharp
// Return Result<T> for operations that can fail
public async Task<Result<Order>> PlaceOrderAsync(OrderRequest request)
{
    if (!request.IsValid)
        return Error.Create(ErrorType.Validation, "INVALID_ORDER", "Order validation failed");

    var order = await _repository.SaveAsync(request);
    return order; // Implicit conversion to Result<Order>.Success
}

// Consume with Match or pattern matching
var result = await service.PlaceOrderAsync(request);
return result.Match(
    onSuccess: order => Ok(order),
    onFailure: error => BadRequest(error.Message));
```

### Guard Clause Pattern

```csharp
public OrderService(IRepository repository, ILogger logger)
{
    ArgumentNullException.ThrowIfNull(repository);
    ArgumentNullException.ThrowIfNull(logger);
    ArgumentException.ThrowIfNullOrWhiteSpace(config.ConnectionString);

    _repository = repository;
    _logger = logger;
}
```

## Nullable Reference Types

| Rule | Standard |
|------|----------|
| Project setting | `<Nullable>enable</Nullable>` required |
| Non-nullable default | Reference types without `?` are non-nullable |
| Explicit nullability | Use `?` suffix for nullable types |
| Runtime guards | Combine with `ArgumentNullException.ThrowIfNull()` |
| No `!` abuse | Avoid null-forgiving operator except rare cases |

### Declaring Nullability

```csharp
public class Customer
{
    public required string Name { get; init; }     // Never null
    public string? MiddleName { get; init; }       // May be null
    public Address Address { get; init; } = null!; // Set by deserializer
}

public Order? FindOrder(Guid id);  // May return null
public Order GetOrder(Guid id);    // Never returns null (throws if not found)
```

### Null Checking

```csharp
// Prefer null-conditional and coalescing
var name = customer?.Name ?? "Unknown";

// Guard clauses for method entry
public void Process(Order order)
{
    ArgumentNullException.ThrowIfNull(order);
    // order is now guaranteed non-null
}
```

## Modern C# Features

### Primary Constructors (C# 12)

Use traditional constructors by default. Primary constructors allowed only for simple cases without validation:

```csharp
// Default: Traditional constructor with validation
public sealed class OrderService
{
    private readonly IRepository _repository;
    private readonly ILogger<OrderService> _logger;

    public OrderService(IRepository repository, ILogger<OrderService> logger)
    {
        ArgumentNullException.ThrowIfNull(repository);
        ArgumentNullException.ThrowIfNull(logger);
        _repository = repository;
        _logger = logger;
    }
}

// Allowed: Primary constructor for simple cases (no validation needed)
public sealed class SimpleMapper(IConverter converter)
{
    public Output Map(Input input) => converter.Convert(input);
}
```

### Collection Expressions (C# 12)

```csharp
// Preferred: Collection expressions
int[] numbers = [1, 2, 3];
List<string> names = ["Alice", "Bob"];
ReadOnlySpan<byte> bytes = [0x00, 0xFF];

// Spread operator
int[] combined = [..first, ..second, 42];

// Avoid: Old syntax
int[] numbers = new int[] { 1, 2, 3 };
```

### Required Members (C# 11)

```csharp
public class OrderRequest
{
    public required string CustomerId { get; init; }
    public required decimal Amount { get; init; }
    public string? Notes { get; init; } // Optional
}
```

### Pattern Matching

```csharp
// Type patterns with property patterns
if (response is { IsSuccess: true, Value: var order })
{
    return order;
}

// Switch expressions
var status = order.State switch
{
    OrderState.Pending => "Awaiting payment",
    OrderState.Confirmed => "Order confirmed",
    OrderState.Shipped => "In transit",
    _ => "Unknown"
};
```

## .NET Best Practices

- **Use records**: For immutable data transfer objects
- **Use `required` modifier**: For mandatory properties (C# 11+)
- **Prefer LINQ**: Over manual iteration, except in high-performance/zero-allocation scenarios
- **Use pattern matching**: For type checks and deconstruction

## Dependency Injection

### Service Registration Extensions

```csharp
// Extension method naming: Add{Layer}Services
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddInfrastructureServices(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<DatabaseOptions>()
            .Bind(configuration.GetSection("Database"))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddScoped<IRepository, SqlRepository>();
        return services;
    }
}
```

### Options Pattern

```csharp
public class DatabaseOptions
{
    public const string SectionName = "Database";

    [Required]
    public required string ConnectionString { get; init; }

    [Range(1, 100)]
    public int MaxRetries { get; init; } = 3;
}
```

## Testing (TUnit)

### Test Attributes

| Attribute | Usage |
|-----------|-------|
| `[Test]` | Marks a test method (not `[Fact]`) |
| `[Arguments(...)]` | Parameterized data (not `[InlineData]`) |
| `[Property("Category", "Unit")]` | Test categorization |

### Test Method Signature

```csharp
[Test]
public async Task MethodName_Condition_ExpectedResult()
{
    // Arrange
    var mockRepo = Substitute.For<IRepository>();
    mockRepo.FindAsync(Arg.Any<Guid>()).Returns(expectedOrder);
    var sut = new OrderService(mockRepo);

    // Act
    var result = await sut.GetOrderAsync(orderId);

    // Assert - ALL assertions must be awaited
    await Assert.That(result.IsSuccess).IsTrue();
    await Assert.That(result.Value.Id).IsEqualTo(orderId);
}
```

### Assertion Patterns

```csharp
// Equality
await Assert.That(actual).IsEqualTo(expected);

// Boolean
await Assert.That(condition).IsTrue();
await Assert.That(condition).IsFalse();

// Null checks
await Assert.That(value).IsNull();
await Assert.That(value).IsNotNull();

// Collections
await Assert.That(list).Contains(item);
await Assert.That(list).HasCount(3);

// Type checking
await Assert.That(obj is SomeType).IsTrue();
```

### Mocking with NSubstitute

```csharp
// Create mock
var mockService = Substitute.For<IOrderService>();

// Setup return value
mockService.GetOrderAsync(Arg.Any<Guid>())
    .Returns(Result<Order>.Success(expectedOrder));

// Setup for specific argument
mockService.GetOrderAsync(specificId)
    .Returns(Result<Order>.Success(specificOrder));

// Setup async streaming
mockService.StreamOrdersAsync()
    .Returns(AsyncEnumerable(order1, order2));

// Verify call was made
await mockService.Received(1).GetOrderAsync(expectedId);

// Verify call was NOT made
await mockService.DidNotReceive().DeleteAsync(Arg.Any<Guid>());

// Capture argument
mockService.SaveAsync(Arg.Do<Order>(o => capturedOrder = o));
```

## Project Configuration

### Required Directory.Build.props Settings

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
  <EnableNETAnalyzers>true</EnableNETAnalyzers>
  <AnalysisLevel>latest</AnalysisLevel>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

### Central Package Management

- Define all package versions in `Directory.Packages.props`
- Never specify versions in individual `.csproj` files
- Use `<PackageReference Include="Package" />` without version
