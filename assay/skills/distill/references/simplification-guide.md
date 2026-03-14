# Simplification Guide

Reference guide for reducing code complexity, identifying vestigial patterns, and deciding when to simplify versus when to remove entirely.

## Complexity Reduction Patterns

### When to Inline vs Extract

**Inline when:**
- A function is called exactly once and its name does not add clarity beyond reading the body
- A wrapper function merely delegates to another function without transformation
- An abstraction layer adds indirection but no behavioral difference (pass-through adapters)
- The extraction was premature — the "reusable" function is only used in one place

**Extract when:**
- The same logic appears in three or more locations (see "three uses" rule below)
- A block of code has a clear name that communicates intent better than the implementation details
- Testing the logic in isolation would significantly improve test coverage or clarity
- The extracted function represents a domain concept that should be named

**Decision heuristic:** If removing the function name forces the reader to re-derive the intent from the implementation, keep the extraction. If the name is just a restatement of the single line it wraps, inline it.

### When Abstraction Helps vs Hurts

**Abstraction helps when:**
- Multiple concrete implementations exist and the abstraction captures their shared contract
- The abstraction enables meaningful testability (swapping real for fake implementations)
- Domain boundaries are clarified by the interface

**Abstraction hurts when:**
- Only one implementation exists and no second is planned or plausible
- The abstraction mirrors the implementation 1:1 (an interface with the same shape as the single class)
- Navigating through the abstraction layer requires more cognitive effort than understanding the concrete code
- "Dependency injection" is really just passing a single concrete instance through extra layers

### Reducing Conditional Complexity

- **Collapse nested conditionals:** Replace `if (a) { if (b) { ... } }` with `if (a && b) { ... }` when the nesting adds no clarity
- **Use early returns:** Convert deep nesting into guard clauses that return/throw early
- **Replace flag variables:** When a boolean flag is set and then checked once, inline the condition
- **Simplify boolean expressions:** `if (x === true)` becomes `if (x)`; `if (!x === false)` becomes `if (x)`

## Vestigial Pattern Identification

### Code Archaeology Approach

Vestigial patterns are evolutionary leftovers — code structures that made sense in a previous design but persist after the design changed. To identify them:

1. **Look for patterns that reference removed features:** Search for imports of deleted modules, references to renamed types, or configuration keys for features that no longer exist
2. **Identify partial migrations:** When a codebase migrated from pattern A to pattern B, look for leftover pattern A code that was never converted
3. **Check adapter layers:** If an adapter wraps a dependency that was replaced, and the adapter's interface matches the new dependency's interface directly, the adapter is vestigial
4. **Examine defensive code:** Guards against conditions that were possible in a previous version but are now structurally impossible (e.g., null checks after a field became required)

### Common Vestigial Pattern Types

- **Dead adapters:** Wrapper classes that were introduced to bridge between two APIs, but one API was since removed or the wrapper now delegates directly
- **Orphaned configuration:** Config keys, environment variables, or feature flags that no active code reads
- **Compatibility shims:** Polyfills or compatibility layers for platform versions no longer supported
- **Migration scaffolding:** Temporary code introduced to migrate data or APIs that was never removed after migration completed
- **Defensive checks for impossible states:** Null checks, type guards, or fallback values for conditions that the current type system or architecture prevents

## Wiring Simplification

### From Manual Configure/Register to Simpler Patterns

**Identify over-engineered wiring when:**
- A registration function manually lists every dependency and wires them together, but the dependency graph is simple and linear
- A factory creates objects by resolving dependencies one-by-one when direct construction with `new` would suffice
- A configuration object has dozens of keys, most of which are always set to the same default value
- A "plugin system" exists but there is only one plugin and no mechanism for external plugins

**Simplification strategies:**
- Replace manual DI containers with direct construction when there are fewer than 3 dependencies
- Replace factory functions with constructors when the factory adds no logic beyond `new`
- Replace configuration objects with sensible defaults and optional overrides
- Replace event bus / pub-sub patterns with direct function calls when there is only one subscriber

### Recognizing Unnecessary Indirection

Indirection that does not serve a purpose:

- **Pass-through functions:** `function doThing(x) { return actuallyDoThing(x); }` with no additional logic
- **Single-method interfaces with one implementation:** The interface and class are isomorphic
- **Manager/controller classes that only delegate:** A `FooManager` that holds a `Foo` and forwards all calls
- **Middleware chains with one middleware:** The chain infrastructure adds complexity but only one handler exists

## The "Three Uses" Rule

Do not abstract until you have seen the pattern three times:

1. **First occurrence:** Write the code inline. Do not extract.
2. **Second occurrence:** Note the duplication but tolerate it. Copy-paste is acceptable.
3. **Third occurrence:** Now extract. You have enough examples to see the true shape of the abstraction.

**Why three?** Two occurrences often look similar by coincidence. The third occurrence confirms the pattern is real and reveals which parts vary (parameters) and which are fixed (the abstraction body). Abstracting after two uses risks creating an abstraction shaped for the wrong generalization.

**Exception:** If the duplicated code is long (>20 lines) or contains complex logic with known bug risk, extract after two uses. The cost of a slightly wrong abstraction is lower than the cost of a bug fix applied to only one copy.

## Simplification vs Deletion

### When to Simplify

Simplify (reduce complexity without removing) when:
- The code serves a current purpose but is more complicated than necessary
- The functionality is needed but the implementation has accumulated accidental complexity
- A refactoring pass changed the surroundings but left this code with now-unnecessary guards or abstractions
- The code works but is hard to understand — simplification improves readability without changing behavior

### When to Remove Entirely

Remove (delete the code) when:
- The code is unreachable or provably never executed
- The feature the code supports has been decommissioned
- The code is commented out and has been for more than one release cycle
- A replacement implementation exists and the old one is no longer used
- The code is a workaround for a bug that has been fixed at its source

### Decision Framework

Ask these questions in order:

1. **Is this code reachable?** If no, delete it.
2. **Does this code serve an active feature?** If no, delete it.
3. **Is this code more complex than it needs to be?** If yes, simplify it.
4. **Is there a simpler way to achieve the same result?** If yes, simplify to that.
5. **Would a reader understand this code without extra context?** If no, simplify for clarity.

When in doubt, prefer deletion over simplification. Dead code that is simplified is still dead code. Version control preserves history — you can always retrieve deleted code if needed.
