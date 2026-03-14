# Dependency Patterns Reference

Coupling metrics, dependency direction analysis, and circular dependency detection for architecture review.

---

## Healthy vs Unhealthy Dependency Patterns

### Healthy: Inward-Pointing Dependencies

Dependencies flow from outer layers (infrastructure, I/O, frameworks) toward inner layers (domain, core business logic). The core has no knowledge of the outer layers.

```text
+-------------------------------------------------------+
|                    Infrastructure                      |
|   (HTTP, Database, Filesystem, External APIs)          |
|                                                        |
|   +-----------------------------------------------+   |
|   |              Application Layer                |   |
|   |   (Use Cases, Orchestration, Commands)        |   |
|   |                                               |   |
|   |   +---------------------------------------+   |   |
|   |   |           Domain Core                 |   |   |
|   |   |   (Entities, Value Objects, Rules)    |   |   |
|   |   |                                       |   |   |
|   |   |   * No imports from outer layers      |   |   |
|   |   |   * Defines interfaces others impl    |   |   |
|   |   +---------------------------------------+   |   |
|   |                                               |   |
|   +-----------------------------------------------+   |
|                                                        |
+-------------------------------------------------------+

  Dependency direction:  Infrastructure --> Application --> Domain
  (arrows point INWARD)
```

**Characteristics of healthy patterns:**
- Domain core has zero imports from infrastructure or framework code
- Interfaces are defined in the domain, implemented in infrastructure
- The composition root (entry point) is the only place that wires concrete implementations
- Modules at the same layer communicate through well-defined interfaces

### Unhealthy: Outward-Pointing Dependencies

Domain or core modules import directly from infrastructure, creating tight coupling.

```text
+-------------------------------------------------------+
|                    Infrastructure                      |
|   (HTTP, Database, Filesystem, External APIs)          |
|                                                        |
|   +-----------------------------------------------+   |
|   |              Application Layer                |   |
|   |                                               |   |
|   |   +---------------------------------------+   |   |
|   |   |           Domain Core                 |   |   |
|   |   |                                       |   |   |
|   |   |   import { Pool } from 'pg'      <---+---+---+----- VIOLATION
|   |   |   import { S3 } from 'aws-sdk'   <---+---+---+----- VIOLATION
|   |   |   import { readFile } from 'fs'  <---+---+---+----- VIOLATION
|   |   |                                       |   |   |
|   |   +---------------------------------------+   |   |
|   |                                               |   |
|   +-----------------------------------------------+   |
|                                                        |
+-------------------------------------------------------+

  Dependency direction: Domain --> Infrastructure
  (arrows point OUTWARD = unhealthy)
```

**Symptoms of unhealthy patterns:**
- Business logic modules import database drivers, HTTP clients, or framework packages
- Changing an infrastructure library forces changes in domain code
- Unit-testing domain logic requires mocking infrastructure dependencies
- Module-level globals hold infrastructure state (lazy-init singletons)

### Unhealthy: Peer-to-Peer Coupling

Modules at the same layer bypass interfaces and depend on each other's internals.

```text
  Module A <---------> Module B
     |                    |
     +-------> Module C <-+
                  |
                  +-------> Module A   (circular!)

  Every module knows about every other module's internals.
  Changes propagate unpredictably.
```

---

## Coupling Metrics

### Afferent Coupling (Ca)

**Definition:** The number of external modules that depend on (import from) a given module.

**Interpretation:**
- High Ca = many dependents = this module is heavily relied upon
- Modules with high Ca should be very stable (changes break many consumers)
- If a high-Ca module is also frequently changing, it is a fragility risk

**How to measure:**
```text
For module M:
  Ca(M) = count of unique modules that import from M
```

### Efferent Coupling (Ce)

**Definition:** The number of external modules that a given module depends on (imports).

**Interpretation:**
- High Ce = many dependencies = this module is vulnerable to upstream changes
- Modules with high Ce are hard to test in isolation
- High Ce in a core module signals possible DIP violation

**How to measure:**
```text
For module M:
  Ce(M) = count of unique modules that M imports from
```

### Instability (I)

**Definition:** `I = Ce / (Ca + Ce)` where 0 means maximally stable and 1 means maximally unstable.

**Interpretation:**

| I value | Meaning | Expectation |
|---------|---------|-------------|
| I = 0 | Maximally stable | Many dependents, no dependencies. Hard to change. Should be abstract. |
| I = 1 | Maximally unstable | No dependents, many dependencies. Easy to change. Should be concrete. |
| 0 < I < 1 | Mixed | Assess whether stability matches the module's role. |

**The Stable Dependencies Principle:** Modules should depend only on modules that are more stable than themselves. An unstable module (I near 1) depending on another unstable module creates fragility chains.

```text
  STABLE (I=0.1) <---- UNSTABLE (I=0.8)     OK: unstable depends on stable
  STABLE (I=0.1) ----> UNSTABLE (I=0.8)     BAD: stable depends on unstable
```

### Abstractness (A)

**Definition:** `A = abstract_types / total_types` where 0 means fully concrete and 1 means fully abstract.

**Interpretation:**
- High abstractness = mostly interfaces, abstract classes, type definitions
- Low abstractness = mostly concrete implementations

### The Main Sequence

The ideal relationship between abstractness (A) and instability (I) follows the "main sequence" diagonal:

```text
  A (Abstractness)
  1 |  Zone of          .
    |  Uselessness    .
    |               .      Main Sequence
    |             .          (A + I = 1)
    |           .
    |         .
    |       .
    |     .        Zone of
    |   .            Pain
    | .
  0 +---+---+---+---+----> I (Instability)
    0                   1
```

- **Zone of Pain (low A, low I):** Concrete and stable. Hard to change but heavily depended on. Database schemas, core utilities.
- **Zone of Uselessness (high A, high I):** Abstract and unstable. Interfaces nobody implements. Dead abstractions.
- **Main Sequence (A + I ~ 1):** Balanced. Stable modules are abstract; unstable modules are concrete.

**Distance from Main Sequence:** `D = |A + I - 1|` — closer to 0 is better. Modules with D > 0.5 deserve investigation.

---

## Circular Dependency Detection

### What Are Circular Dependencies?

A circular dependency exists when module A depends on module B, and module B (directly or transitively) depends back on module A.

### Types of Circular Dependencies

**Direct cycles:**
```text
  A ----imports----> B
  B ----imports----> A
```

**Transitive cycles:**
```text
  A ----imports----> B
  B ----imports----> C
  C ----imports----> A
```

**Barrel-file-mediated cycles:**
```text
  feature/index.ts re-exports from:
    - feature/handler.ts
    - feature/types.ts

  feature/handler.ts imports from feature/index.ts
    (to get types — but barrel re-exports handler too!)
```

### Detection Approach

1. **Build the import graph:** Parse all source files, extract import/require statements, resolve to file paths
2. **Run cycle detection:** Apply depth-first search (DFS) with back-edge detection on the import graph
3. **Classify cycles:** Direct (2 modules), short transitive (3-4 modules), long transitive (5+ modules)
4. **Assess severity:**
   - Direct cycles involving core/domain modules: **HIGH**
   - Barrel-file-mediated cycles: **MEDIUM** (often accidental, easy to fix)
   - Transitive cycles in leaf modules: **LOW**

### Remediation Strategies

| Pattern | Fix |
|---------|-----|
| Direct A <-> B cycle | Extract shared types into a third module C, both A and B depend on C |
| Barrel-file cycle | Use direct imports instead of barrel re-exports |
| Transitive cycle through shared state | Introduce an event bus or mediator pattern |
| Cycle caused by type imports only | Use `import type` (TypeScript) to break the runtime cycle |

---

## Layered Architecture Violations

### What Constitutes a Layer

A layered architecture organizes code into horizontal layers with strict dependency rules:

```text
  +-------------------------------------------------------+
  | Infrastructure |              | Presentation          |
  | (DB, FS, APIs) |              | (routes, controllers) |
  +----------|-----+--------------+-----|------------------+
             |                          |
             v                          v
  +-----------------------------------------------+
  |              Application                      |
  |   (use cases, orchestrators, commands)        |
  +----------------------|------------------------+
                         |
                         v
  +-----------------------------------------------+
  |              Domain (core)                    |
  |   (entities, value objects, domain services)  |
  +-----------------------------------------------+

  Arrows = dependency direction (pointing INWARD toward the core).
  Infrastructure and Presentation both depend inward on Application/Domain.
  Domain (core) NEVER imports from any outer layer.
```

### Common Layer Violations

| Violation | Signal | Severity |
|-----------|--------|----------|
| Domain imports infrastructure | `import { query } from '../db'` in a domain file | **HIGH** |
| Application imports presentation | Use case module imports an HTTP request type | **MEDIUM** |
| Skip-layer dependency | Presentation directly calls infrastructure, bypassing application | **MEDIUM** |
| Bidirectional layer dependency | Application imports domain AND domain imports application | **HIGH** |

### How to Detect Layer Violations

1. **Establish layer boundaries:** Map directories to layers (e.g., `src/domain/`, `src/infra/`, `src/app/`)
2. **Build import graph with layer annotations:** Tag each module with its layer
3. **Check direction:** For each import, verify the importing module's layer is the same or closer to the periphery than the imported module's layer
4. **Flag violations:** Any import pointing outward (from a core layer to a peripheral layer) is a violation

---

## Dependency Inversion in Practice

### When to Use Interfaces vs Direct Dependencies

**Use an interface (abstraction boundary) when:**
- The dependency crosses an architectural layer boundary (e.g., application -> infrastructure)
- You need to swap implementations (testing, multi-environment, migration)
- The dependency is volatile (external API, third-party library likely to change)
- Multiple implementations exist or are planned (e.g., FileStorage: local, S3, GCS)

**Use a direct dependency when:**
- Both modules are in the same layer and same bounded context
- The dependency is a stable, well-tested utility (e.g., a date library, a hash function)
- The abstraction would be a 1:1 mirror of the concrete API (pointless indirection)
- The module is a pure function or value object with no side effects

### Practical Decision Flowchart

```text
  Does the dependency cross a layer boundary?
       |                    |
      YES                  NO
       |                    |
  Use interface        Is the dependency volatile?
                            |              |
                           YES            NO
                            |              |
                       Use interface   Direct dependency is fine
```

### Common Anti-Patterns

| Anti-Pattern | Description | Fix |
|-------------|-------------|-----|
| Interface mirroring | Interface is an exact copy of one concrete class | Remove interface, use direct dependency |
| God interface | One interface with 15+ methods for all possible operations | Split into role-specific interfaces (ISP) |
| Premature abstraction | Interface created "just in case" with only one implementation | Remove until a second implementation materializes |
| Leaky abstraction | Interface exposes implementation details (SQL in method names, HTTP status codes in domain interface) | Redesign interface using domain language |
