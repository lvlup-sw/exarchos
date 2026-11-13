# Legacy integer-vector requests

Both generation operations support TUnit 1.2.11 for C# and Vitest 3.2.7 for TypeScript. Set `framework` and `frameworkVersion` to the target's supported values. Inspect the installed package with `testgen describe --json` for its actual release capabilities. Use this contract for existing vector bindings; new application domains should use version 2.

Keep reviewed bindings, requests, and emitted tests in the target repository. The native runner discovers and executes each `Case_N`. Inputs are finite signed 64-bit vectors, with at most 256 expanded cases. The generator does not infer a domain or oracle.

```sh
testgen describe generate_property_tests --json
testgen generate_property_tests --input request.json --json
testgen generate_metamorphic_tests --input request.json --json
```

A C# request names the test project and a new C# file, an accepted property reference, assumptions, cases, and fully qualified methods already available to the test assembly. Encode signed 64-bit inputs as decimal strings. Each optional boundary axis varies a single field of the first case at the declared minimum, maximum, and their adjacent values. Supply explicit cases for dependent inputs. The case budget includes expanded cases.

- `precondition(long[]) -> bool` checks the source and follow-up domain.
- `observe(long[]) -> long` executes the target and projects its result.
- `predicate(long[], long) -> bool` checks the property against a source observation.
- `transform(long[]) -> long[]?` constructs a follow-up from a copy of the source. Return null when the transformation cannot apply.
- `relation(long[], long[], long, long) -> bool` checks both observations and the intended transformation relation.

Keep these bindings pure apart from the target execution in `observe`. The emitted test reports invalid source, invalid follow-up, and identical input as invalid cases. Count these separately from assertion failures. Inspect the patch, apply it in the target checkout, run the returned native command, and compare the discovered case count with the fixture. To replay a case, keep its concrete vector and the same bindings. Reduce by selecting or replacing cases only when the precondition and original failure signature survive.

For interval Coalesce, use positive intervals, zero jitter, UTC ticks, and representable source and follow-up timestamps. Require at least one due occurrence. Compare against the latest aligned timestamp at or before now, then test time translation and one-interval advancement separately. Include the 100/101 boundary and an unaligned current time.

## TypeScript bindings

Set `framework` to `vitest` and `frameworkVersion` to `3.2.7`. The target contains `path` for a new `.test.ts` file and `bindingModule` for a repository-relative `.ts` module. Both operations use the same request structure. The operation selects the required exports.

```json
{
  "framework": "vitest",
  "frameworkVersion": "3.2.7",
  "target": {
    "path": "tests/generated/property.test.ts",
    "bindingModule": "tests/support/property-binding.ts"
  },
  "propertyRef": "accepted-property-reference",
  "assumptions": ["Replace with the reviewed domain assumptions."],
  "cases": [["1"], ["-1"]]
}
```

Export `isValid(input: readonly bigint[]): boolean` and `observe(input: readonly bigint[])` from the binding module. Property generation also requires `predicate(input, observed): boolean`. Metamorphic generation requires `transform(input): bigint[] | null` and `relation(source, follow, sourceResult, followResult): boolean`. Observation, predicate, transformation, and relation can return promises. `isValid` must return a synchronous boolean. Observation values can have any TypeScript type accepted by the predicate or relation.

Metamorphic tests reject null, wrong-width, noninteger, out-of-range, out-of-domain, and identical follow-up inputs before target execution. A rejected case fails explicitly. A relation must return true. Keep bindings pure apart from target execution in `observe`.

```sh
testgen generate_property_tests --input request.json > candidate.patch
git apply --check candidate.patch
git apply candidate.patch
npm exec --no -- vitest run tests/generated/property.test.ts
npm exec --no -- vitest run tests/generated/property.test.ts -t '^Case_1$'
```

Use the target project's typecheck command as well. For metamorphic generation, change the operation to `generate_metamorphic_tests` and supply its bindings. Review the proposed patch before applying it. The Exarchos fixtures `vitest-property.json` and `vitest-metamorphic.json` exercise the real `burstStaggerDelayMs` function through the repository's existing Vitest configuration.
