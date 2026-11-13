# Generate native tests

Use `testgen describe --json` from the installed package as the capability authority. Version 2 supports property, metamorphic, differential, and stateful methods for TUnit 1.2.11 and Vitest 3.2.7. Older published packages may expose fewer methods. Requests without `contractVersion: 2` retain the [legacy integer-vector contract](legacy-vectors.md).

The CLI and optional `testgen-mcp` stdio server share validation, generation, and result schemas. They return create-only patches. They do not apply files, discover application semantics, execute tests, or start an execution service. Use the repository's existing runner and typecheck commands.

## Start a suite

```sh
testgen describe --json
testgen init Normalize --framework vitest --method metamorphic --property-ref text/normalization > scaffold.patch
# C# alternative:
testgen init Normalize --framework tunit --project tests/App.Tests/App.Tests.csproj --method metamorphic --property-ref text/normalization > scaffold.patch
git apply --check scaffold.patch
git apply scaffold.patch
```

Choose one language command. The patch adds a request and binding stubs. Every stub throws until implemented. `--domain domain.json` supplies an argument domain; use `scaffold_tests --input scaffold.json` to supply distinct stateful operation domains. The JSON result names the next operation and request path.

Review the property reference, assumptions, domain, budgets, and binding before generation. Do not replace throwing stubs with unconditional success. The acceptance rule must come from the application contract or an independent model, not from copied implementation behavior.

```sh
testgen generate_metamorphic_tests --input tests/generated/Normalize.testgen.json > suite.patch
git apply --check suite.patch
git apply suite.patch
npm exec --no -- vitest run tests/generated/Normalize.test.ts
```

Use `--json` for the patch, fixture, generation accounting, obligations, and suggested native command. C# requests name the existing test project. Run its returned `dotnet` command with the project's normal analyzers. C# emitted files identify themselves as generated source; handwritten bindings remain subject to normal review and analyzers. Compile TypeScript with the project's typecheck command as well as running Vitest.

## Domains and budgets

| Domain | Representation and restrictions |
|---|---|
| `boolean` | JSON boolean |
| `integer` | Canonical decimal string, inclusive `min` and `max`; at most 128 characters; no floating-point conversion |
| `number` | Finite JSON number within inclusive bounds; negative zero excluded |
| `string` | Unicode scalar alphabet, minimum and maximum scalar count |
| `enum` | One of the declared strings |
| `nullable` | Null or a value in its nested domain |
| `array` | Bounded length and one element domain |
| `record` | Exactly the declared fields, each with its own domain |

All request text must contain Unicode scalar values. The reserved own key `__proto__` is rejected before parsing, so it cannot silently disappear from a domain or fixture. Domains have bounded depth and materialized size. Consult operation schemas for numeric limits. These are JSON domains: objects with methods, cyclic graphs, dates, and arbitrary binary values need an explicit reviewed encoding.

Stateless requests contain `domain` and `cases`. Optional `generation: {seed, count, maxAttempts}` adds deterministic boundary and random candidates. Inspect requested/actual counts, duplicates, and exhaustion; a passing undersized sample does not satisfy a larger exploration budget. Rejected native preconditions are explicit failures, not successful tests. Optional `reduction: {maxAttempts}` bounds native reduction; zero disables it. The native test runner owns timeouts and process/resource budgets.

## Stateless binding contract

Let `I` be the domain input and `O` the observation. TypeScript may use a concrete `I` compatible with the runtime domain. C# receives `JsonElement`; return observation types accepted by the oracle methods. C# asynchronous bindings return `Task<T>`; TypeScript permits values or promises except for the synchronous precondition.

| Purpose | TypeScript export | C# method |
|---|---|---|
| Source/follow-up validity | `isValid(input): boolean` | `IsValid(JsonElement): bool` |
| Target execution | `observe(input): O` | `Observe(JsonElement): Task<O>` |
| Property | `predicate(input, observed): boolean` | `Predicate(JsonElement, O): Task<bool>` |
| Metamorphic transformation | `transform(input): I` | `Transform(JsonElement): Task<JsonElement>` |
| Metamorphic oracle | `relation(source, follow, before, after): boolean` | `Relation(JsonElement, JsonElement, O, O): Task<bool>` |
| Independent reference | `reference(input): R` | `Reference(JsonElement): Task<R>` |
| Differential oracle | `equivalent(input, actual, expected): boolean` | `Equivalent(JsonElement, O, R): Task<bool>` |

Property requires the first three methods. Metamorphic requires validity, observation, transformation, and relation. Differential requires validity, observation, reference, and equivalence. Compare normalized outputs explicitly when their representations differ.

Only target observation may have application effects; reset those effects between observations when needed. Keep predicates and transformations deterministic. Metamorphic follow-ups must satisfy the same domain and precondition and differ from the source. Invalid or identical follow-ups reject the case before target execution. A returned false is an oracle failure; an exception is not interchangeable with that failure.

## Stateful binding contract

A request contains named operation domains and explicit `histories`, optionally supplemented by `generation: {seed, count, maxSteps, maxAttempts}`. Each history step is `{operation, args}`. The native binding supplies:

| Role | TypeScript | C# |
|---|---|---|
| Independent initial model | `createModel()` | `CreateModel(): Task<M>` |
| Fresh application instance | `createSystem()` | `CreateSystem(): Task<S>` |
| Cleanup | `disposeSystem(system)` | `DisposeSystem(S): Task` |
| Model precondition | `isEnabled(model, operation, args): boolean` | `IsEnabled(M, string, JsonElement): bool` |
| Independent transition | `transition(model, operation, args)` | `Transition(M, string, JsonElement): Task<M>` |
| Application operation | `execute(system, operation, args)` | `Execute(S, string, JsonElement): Task` |
| Application observation | `observe(system)` | `Observe(S): Task<O>` |
| State comparison | `equivalent(model, observed): boolean` | `Equivalent(M, O): Task<bool>` |

The runner compares initial state and every executed step. Each history and reduction attempt gets a fresh model and system; cleanup runs in `finally` after successful creation. Creation must clean up partial allocation if it throws. Cleanup must complete before the next history can affect shared resources.

Generated candidate pools skip model-disabled operations and report attempts, rejections, and exhaustion in `TESTGEN_HISTORY`. Explicit disabled histories reject. Exhaustion before the requested step count rejects rather than passing an empty history. The model must not consult the application to decide expected state or enabled operations.

These are sequential histories. They do not establish linearizability, concurrent safety, or crash durability. Select native scheduling, history checking, and real-provider process controls separately when the obligation requires them.

## Reduce and replay

On an oracle mismatch the native test emits `TESTGEN_REPLAY` containing concrete values or the executed history, operation/domain definitions, property reference, signature, and reduction accounting. Reduction retains candidates only if they remain valid and fail with the original signature. If another candidate crashes, the reducer reports an abort and retains the known failure. Reduction is bounded and does not guarantee a globally minimal counterexample.

```sh
testgen replay --input original.testgen.json --fixture failure.json > replay.patch
# A native log may contain multiple records:
testgen replay --input original.testgen.json --fixture native.log --case Case_1 > replay.patch
```

Replay checks the property reference, domain or operation definitions, and supported failure signature; it removes random generation and disables further reduction. Apply its create-only patch to an absent destination in a scratch checkout, or change the request's target to a new test file before emission. Do not overwrite a maintained suite without review.

Run the replay with the same reviewed bindings, application revision, dependencies, configuration, and relevant environment. The record does not authenticate these inputs. A matching signature identifies the same oracle site, not necessarily the same root cause. A seed alone cannot reproduce native schedules or external state.

## Evidence and limits

For each language and selected method, require native discovery, a valid passing baseline, a deliberately introduced fault detected by the intended oracle, and replay of concrete failure data. Record binding and review effort separately from generation time. Keep compiler failures, invalid domains, timeouts, missing prerequisites, and unreached faults separate from assertion failures.

The package smoke checks all four methods in both languages outside an Exarchos checkout. Application bindings still need their own controls. Exarchos's text normalization and replay-ledger fixtures exercise real TypeScript functions; the Bifrost WorkerRegistry campaign exercises real C# lifecycle operations. These finite checks do not certify an emitter, oracle, or application free of defects.
