# SOLID Principles Reference

Detection heuristics and severity guidance for agent-driven architectural assessment.

---

## S — Single Responsibility Principle (SRP)

### Definition

A module should have one, and only one, reason to change. Each class or module should encapsulate a single concern so that a change in one business requirement affects only one module.

### Violation Signals

1. A class or module handles both data persistence AND business logic
2. A single file contains multiple unrelated public interfaces or exported functions
3. The module name contains "And" or "Manager" or "Helper" (symptom of mixed concerns)
4. More than 3 constructor/initialization parameters from different domains
5. The module is modified in nearly every feature branch (high churn across unrelated features)

### Severity Guide

| Severity | When to assign |
|----------|---------------|
| **HIGH** | Module mixes I/O (network, filesystem, database) with core business rules. Changes to infrastructure force changes to domain logic. |
| **MEDIUM** | Module handles 2-3 related but distinct concerns (e.g., validation + transformation). Concerns could be separated but aren't yet causing bugs. |
| **LOW** | Module has a slightly broad scope but concerns are closely related. Separation would be premature. |

### Code Examples

**Violation:**
```
class OrderService {
  validateOrder(order) { ... }        // business rule
  calculateTotal(order) { ... }       // business rule
  saveToDatabase(order) { ... }       // persistence
  sendConfirmationEmail(order) { ... } // notification
  generatePdfInvoice(order) { ... }   // rendering
}
```

**Healthy alternative:**
```
class OrderValidator {
  validate(order) { ... }
}

class OrderCalculator {
  calculateTotal(order) { ... }
}

class OrderRepository {
  save(order) { ... }
}

class OrderNotifier {
  sendConfirmation(order) { ... }
}
```

### Detection Heuristics

- Count the number of distinct "domains" imported by a module (e.g., database, HTTP, email, file system). More than 2 suggests SRP violation.
- Check if removing one public method would make half the imports unnecessary. If so, the method belongs elsewhere.
- Look for methods that could be tested independently with completely different mock setups — they likely belong in different modules.

---

## O — Open/Closed Principle (OCP)

### Definition

Software entities should be open for extension but closed for modification. You should be able to add new behavior without changing existing, tested code.

### Violation Signals

1. Adding a new variant requires modifying an existing `switch` or `if/else` chain
2. A function has a growing list of type-check branches (`if (type === "A") ... else if (type === "B") ...`)
3. Feature additions consistently require editing the same core file
4. Configuration objects grow new boolean flags for each new feature
5. Functions accept a `type` or `kind` string and branch on its value

### Severity Guide

| Severity | When to assign |
|----------|---------------|
| **HIGH** | Every new feature requires modifying a critical-path module (e.g., event dispatcher, router). Risk of regression in existing behavior with each change. |
| **MEDIUM** | A switch/case or if/else chain has 5+ branches and is growing. Extension is possible but requires touching stable code. |
| **LOW** | A conditional has 2-3 branches in a non-critical path. The branching is manageable and unlikely to grow further. |

### Code Examples

**Violation:**
```
function calculateDiscount(customer) {
  if (customer.type === "regular") {
    return 0.05
  } else if (customer.type === "premium") {
    return 0.10
  } else if (customer.type === "vip") {
    return 0.20
  }
  // Adding a new customer type means editing this function
}
```

**Healthy alternative:**
```
// Strategy pattern — new types are added without modifying existing code
const discountStrategies = {
  regular: () => 0.05,
  premium: () => 0.10,
  vip: () => 0.20,
}

function calculateDiscount(customer) {
  const strategy = discountStrategies[customer.type]
  return strategy ? strategy() : 0
}
// New types: just add an entry to the map
```

### Detection Heuristics

- Search for `switch` statements on a `type` or `kind` field — count the branches. Five or more suggests OCP violation.
- Check git history: if the same file is modified in >50% of feature branches, it may be closed to extension.
- Look for "registry" or "map" patterns that could replace branching logic.

---

## L — Liskov Substitution Principle (LSP)

### Definition

Subtypes must be substitutable for their base types without altering the correctness of the program. If a function works with a base type, it must work identically with any derived type.

### Violation Signals

1. A subclass throws an exception for a method the base class supports
2. A subclass overrides a method to do nothing (empty override or no-op)
3. A function checks `instanceof` or the concrete type before calling a method
4. A subclass narrows the accepted input range or widens the output range beyond the base contract
5. Documentation says "do not call X on this subtype" — a direct substitutability violation

### Severity Guide

| Severity | When to assign |
|----------|---------------|
| **HIGH** | Substituting the subtype causes runtime errors, data corruption, or silently wrong results. Code contains `instanceof` guards to work around the violation. |
| **MEDIUM** | Subtype behaves differently in edge cases that callers may not handle. No runtime error, but correctness depends on knowing the concrete type. |
| **LOW** | Subtype overrides behavior in a benign way (e.g., logging or metrics) that does not affect correctness. |

### Code Examples

**Violation:**
```
class Bird {
  fly() { return "flying" }
}

class Penguin extends Bird {
  fly() { throw new Error("Penguins cannot fly") }
  // Violates LSP: callers expecting Bird.fly() to work will crash
}

function makeBirdFly(bird) {
  // Forced to add a type check — LSP violation symptom
  if (bird instanceof Penguin) {
    return bird.swim()
  }
  return bird.fly()
}
```

**Healthy alternative:**
```
interface Movable {
  move(): string
}

class Sparrow implements Movable {
  move() { return "flying" }
}

class Penguin implements Movable {
  move() { return "swimming" }
}

function makeAnimalMove(animal: Movable) {
  return animal.move()  // Works for all implementations
}
```

### Detection Heuristics

- Search for `instanceof` checks in functions that accept a base type — this is the classic LSP smell.
- Look for empty method overrides or methods that throw `NotImplementedError` / `UnsupportedOperationError`.
- Check if any subclass method has a comment like "not applicable" or "unused".
- Look for type narrowing (`as ConcreteType`) immediately after receiving a base-typed parameter.

---

## I — Interface Segregation Principle (ISP)

### Definition

No client should be forced to depend on methods it does not use. Interfaces should be small and focused so that implementing classes are not burdened with irrelevant obligations.

### Violation Signals

1. An interface has more than 7-8 methods (likely too broad)
2. Implementing classes leave methods as no-ops or throw "not supported"
3. A single interface is imported by clients that only use a subset of its methods
4. Interface changes force updates in modules that don't use the changed method
5. Parameters typed as a broad interface when only 1-2 properties are accessed

### Severity Guide

| Severity | When to assign |
|----------|---------------|
| **HIGH** | A broad interface forces implementors to provide dangerous no-op stubs for critical operations (e.g., `delete()` that silently does nothing). Clients may call methods that appear supported but aren't. |
| **MEDIUM** | Interface is large (8+ methods) and implementors stub out 2-3 methods. No safety risk but increases maintenance burden. |
| **LOW** | Interface is slightly broad but all implementors genuinely use most methods. Splitting would add complexity without clear benefit. |

### Code Examples

**Violation:**
```
interface Worker {
  work(): void
  eat(): void
  sleep(): void
  attendMeeting(): void
  writeReport(): void
}

class Robot implements Worker {
  work() { /* ... */ }
  eat() { /* no-op — robots don't eat */ }
  sleep() { /* no-op */ }
  attendMeeting() { /* no-op */ }
  writeReport() { /* ... */ }
}
```

**Healthy alternative:**
```
interface Workable {
  work(): void
}

interface Reportable {
  writeReport(): void
}

interface HumanNeeds {
  eat(): void
  sleep(): void
}

class Robot implements Workable, Reportable {
  work() { /* ... */ }
  writeReport() { /* ... */ }
}

class HumanWorker implements Workable, Reportable, HumanNeeds {
  work() { /* ... */ }
  writeReport() { /* ... */ }
  eat() { /* ... */ }
  sleep() { /* ... */ }
}
```

### Detection Heuristics

- Count methods per interface. More than 7 is a signal worth investigating.
- Search for empty method bodies or `throw new Error("Not implemented")` in classes implementing an interface.
- Check if any implementation only uses <50% of the interface methods meaningfully.
- Look for function parameters typed with a broad interface where only 1-2 fields/methods are accessed in the body.

---

## D — Dependency Inversion Principle (DIP)

### Definition

High-level modules should not depend on low-level modules. Both should depend on abstractions. Abstractions should not depend on details — details should depend on abstractions.

### Violation Signals

1. A domain/business-logic module directly imports a database driver, HTTP client, or file system module
2. Constructor creates its own dependencies instead of receiving them (no dependency injection)
3. Module-level `import` of a concrete implementation where an interface/type would suffice
4. A core module imports from an `infrastructure/`, `adapters/`, or `io/` directory
5. Changing a database library requires editing business logic files

### Severity Guide

| Severity | When to assign |
|----------|---------------|
| **HIGH** | Core business logic directly instantiates or imports infrastructure (database, network, filesystem). Impossible to test without real infrastructure or heavy mocking. |
| **MEDIUM** | A module depends on a concrete implementation but the dependency is injected (not self-created). The direction is wrong but testability is preserved. |
| **LOW** | A utility module depends on a specific library for convenience. The dependency is isolated and easily swappable. |

### Code Examples

**Violation:**
```
// Domain module directly importing infrastructure
import { Pool } from 'pg'
import { S3Client } from '@aws-sdk/client-s3'

class OrderService {
  private db = new Pool({ connectionString: process.env.DB_URL })
  private s3 = new S3Client({ region: 'us-east-1' })

  async createOrder(data) {
    // Business logic tightly coupled to Postgres and S3
    await this.db.query('INSERT INTO orders ...', [data])
    await this.s3.send(new PutObjectCommand({ ... }))
  }
}
```

**Healthy alternative:**
```
// Domain depends on abstractions
interface OrderRepository {
  save(order: Order): Promise<void>
}

interface FileStorage {
  upload(key: string, data: Buffer): Promise<void>
}

class OrderService {
  constructor(
    private repo: OrderRepository,
    private storage: FileStorage,
  ) {}

  async createOrder(data) {
    const order = Order.create(data)
    await this.repo.save(order)
    await this.storage.upload(order.invoiceKey, order.toPdf())
  }
}

// Infrastructure implements the abstractions
class PostgresOrderRepository implements OrderRepository { ... }
class S3FileStorage implements FileStorage { ... }
```

### Detection Heuristics

- Check import paths in domain/core modules: do they import from `infrastructure/`, `adapters/`, `db/`, `io/`, or driver-specific packages?
- Search for `new` keyword in domain modules creating infrastructure objects (database connections, HTTP clients, cache clients).
- Look for `process.env` access in domain modules — environment configuration is an infrastructure concern.
- Check if the composition root (entry point / DI container) is the only place where concrete implementations are wired to abstractions.
