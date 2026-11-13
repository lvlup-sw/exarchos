---
name: test-campaign
description: Build or improve a repository's native test suite for a stated correctness obligation. Use when a change needs complementary property, metamorphic, model, concurrency, recovery, or other test methods. Return replayable evidence and unresolved obligations.
metadata:
  author: exarchos
  version: 0.2.0
  category: review
---

# Test campaign

1. Pin the repository revision, target configuration, native test command, and accepted behavior. Choose an observable failure that would falsify the behavior. Record any assumption the repository does not settle.
2. Use [test dimensions](references/dimensions.md) to choose the checks that can expose that failure. Pair independent checks where either oracle is partial. Keep each test tied to a property, fault, or boundary.
3. Write tests and replay fixtures in the target's framework. Read a passing test in the same project and match its discovery, assertion, and analyzer conventions. Where a supported testgen command is available, follow [generation](references/generation.md). Review the predicate, input constraints, transformation, and output projection before using emitted code. Existing vector bindings may retain the [legacy contract](references/legacy-vectors.md).
4. Run the native tests. Verify discovery, observation of the intended branch or fault, and at least one negative control that fails at the intended assertion. Replay concrete failures with their original failure signature. A build error, timeout, or unreached fault leaves the affected claim indeterminate.
5. Record meaning, oracle, reach, sensitivity, replay, and limits. Include the revision, environment, command, fixture, and pass, fail, or indeterminate result. Keep maintained tests and fixtures in the owning repository and retain raw logs in the existing artifact store.
6. In a prepared Exarchos task, use the capsule's declared result fields. Return evidence to the existing coordinator. A settlement evidence entry needs a capsule-admitted kind and a reference to an intact recorded evidence row. Retain native reports outside settlement when they have no supported carrier. Keep the product claim distinct from completion of a task that found a defect.

Before execution, write a compact campaign table with the property, selected dimension, accepted oracle, reach condition, negative control, native command, budget, and replay material. Explain omissions that leave a critical path untested. Select methods by the failure they can expose; do not require all 13 dimensions for every change.

Use **pass** only for the stated property within the recorded run bounds, **fail** for an observed contract violation, and **indeterminate** when the evidence cannot decide the claim. Report the test infrastructure result separately: a timeout can violate an accepted liveness deadline, but a harness timeout without a reached target does not establish an application defect. Preserve this distinction through aggregation; do not turn missing evidence into success.

For optional Exarchos composition, inspect the current task capsule and advertised evidence carriers before submitting results. Cite the recorded row, never invent a carrier kind or settlement reference. A supported passing evidence row is not permission to expand its scope. The skill invokes repository commands through the agent's available tools; it adds no scheduler, remote runner, platform abstraction, or second workflow state store.
