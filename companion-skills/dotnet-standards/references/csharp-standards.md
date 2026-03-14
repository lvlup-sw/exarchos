# C# Standards

## File Organization

- **One public type per file**: File name matches type name (e.g., `MyClass.cs`)
- **Nested types exempt**: Internal/private nested types can remain in parent file

## Class Design

| Rule | Rationale |
|------|-----------|
| `sealed` by default | Explicitly design for inheritance or seal |
| Inheritance depth <= 2 | Deeper hierarchies -> refactor to composition |
| Composition over inheritance | Prefer delegation for code reuse |

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
| Parameters/locals | camelCase | `orderId`, `isValid` |
| Type parameters | `T` prefix | `TEntity`, `TResult` |
| Async methods | `Async` suffix | `GetOrderAsync` |
| Files | Match type name | `OrderService.cs` |
| Test files | `*.Tests.cs` | `OrderService.Tests.cs` |

## File Headers (Required)

```csharp
// =============================================================================
// <copyright file="FileName.cs" company="Levelup Software">
// Copyright (c) Levelup Software. All rights reserved.
// </copyright>
// =============================================================================
```

## Member Ordering

1. Constants and static readonly fields
2. Private readonly fields
3. Properties (public, then private)
4. Constructors
5. Public methods
6. Private methods
7. Nested types

## Using Statements

- File-scoped namespaces: `namespace Agentic.Core;`
- Global usings in `GlobalUsings.cs` for common imports
- Group: System -> Third-party -> Application

## Documentation

| Requirement | Standard |
|-------------|----------|
| XML docs | Required for all `public` members |
| Tags | `<summary>`, `<param>`, `<returns>` mandatory |
| Exceptions | `<exception cref="...">` for thrown exceptions |

## Async/Await

| Rule | Standard |
|------|----------|
| Suffix | All async methods end with `Async` |
| ConfigureAwait | `.ConfigureAwait(false)` in library code |
| CancellationToken | Accept as final optional parameter with `default` value |
| Return types | `Task<T>`, `Task`, or `IAsyncEnumerable<T>` |
| Avoid async void | Only for event handlers |

## Nullable Reference Types

| Rule | Standard |
|------|----------|
| Project setting | `<Nullable>enable</Nullable>` required |
| Non-nullable default | Reference types without `?` are non-nullable |
| Explicit nullability | Use `?` suffix for nullable types |
| Runtime guards | `ArgumentNullException.ThrowIfNull()` |
| No `!` abuse | Avoid null-forgiving operator except rare cases |

## Modern C# Features

- **Primary constructors** (C# 12): Only for simple cases without validation
- **Collection expressions** (C# 12): `int[] numbers = [1, 2, 3];` with spread `[..first, ..second]`
- **Required members** (C# 11): `public required string Name { get; init; }`
- **Pattern matching**: Property patterns, switch expressions, type patterns

## Result Pattern

```csharp
public async Task<Result<Order>> PlaceOrderAsync(OrderRequest request)
{
    if (!request.IsValid)
        return Error.Create(ErrorType.Validation, "INVALID_ORDER", "Order validation failed");
    var order = await _repository.SaveAsync(request);
    return order;
}

var result = await service.PlaceOrderAsync(request);
return result.Match(
    onSuccess: order => Ok(order),
    onFailure: error => BadRequest(error.Message));
```

## Dependency Injection

- Extension method naming: `Add{Layer}Services`
- Options pattern with `ValidateDataAnnotations` + `ValidateOnStart`
- Central Package Management: versions in `Directory.Packages.props`
- Reference `Lvlup.Build` meta-package for analyzers and defaults

## /dotnet-standards Skill

Use `/dotnet-standards` for project configuration validation and scaffolding.
