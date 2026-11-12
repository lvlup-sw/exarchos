# Generate TUnit candidates

Use `generate_property_tests` for reviewed signed-integer properties in TUnit 1.2.11. Set `"framework": "tunit"` and `"frameworkVersion": "1.2.11"` in the request. Use `generate_metamorphic_tests` as an experimental operation. Keep the reviewed bindings and emitted C# in the target repository so its native runner can execute the tests.

```sh
testgen describe generate_property_tests --json
testgen generate_property_tests --input request.json --json
testgen generate_metamorphic_tests --input request.json --json
```

A request names the test project and a new C# file, an accepted property reference, assumptions, cases, and fully qualified methods already available to the test assembly. Encode signed 64-bit inputs as decimal strings. Each optional boundary axis varies a single field of the first case at the declared minimum, maximum, and their adjacent values. Supply explicit cases for dependent inputs. The case budget includes expanded cases.

- `precondition(long[]) -> bool` checks the source and follow-up domain.
- `observe(long[]) -> long` executes the target and projects its result.
- `predicate(long[], long) -> bool` checks the property against a source observation.
- `transform(long[]) -> long[]?` constructs a follow-up from a copy of the source. Return null when the transformation cannot apply.
- `relation(long[], long[], long, long) -> bool` checks both observations and the intended transformation relation.

Keep these bindings pure apart from the target execution in `observe`. The emitted test reports invalid source, invalid follow-up, and identical input as invalid cases. Count these separately from assertion failures. Inspect the patch, apply it in the target checkout, run the returned native command, and compare the discovered case count with the fixture. To replay a case, keep its concrete vector and the same bindings. Reduce by selecting or replacing cases only when the precondition and original failure signature survive.

For interval Coalesce, use positive intervals, zero jitter, UTC ticks, and representable source and follow-up timestamps. Require at least one due occurrence. Compare against the latest aligned timestamp at or before now, then test time translation and one-interval advancement separately. Include the 100/101 boundary and an unaligned current time.
