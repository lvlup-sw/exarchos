---
name: test-campaign
description: Build or improve a repository's native test suite for a stated correctness obligation. Use when a change needs complementary property, metamorphic, model, concurrency, recovery, or other test methods. Return replayable evidence and unresolved obligations.
metadata:
  author: exarchos
  version: 0.1.0
  category: review
---

# Test campaign

1. Pin the repository revision, target configuration, native test command, and accepted behavior. Choose an observable failure that would falsify the behavior. Record any assumption the repository does not settle.
2. Use [test dimensions](references/dimensions.md) to choose the checks that can expose that failure. Pair independent checks where either oracle is partial. Keep each test tied to a property, fault, or boundary.
3. Write tests and replay fixtures in the target's framework. Read a passing test in the same project and match its discovery, assertion, and analyzer conventions. Where a supported testgen command is available, follow [generation](references/generation.md). Review the predicate, input constraints, transformation, and output projection before using emitted code.
4. Run the native tests. Verify discovery, observation of the intended branch or fault, and at least one negative control that fails at the intended assertion. Replay concrete failures with their original failure signature. A build error, timeout, or unreached fault leaves the affected claim indeterminate.
5. Record meaning, oracle, reach, sensitivity, replay, and limits. Include the revision, environment, command, fixture, and pass, fail, or indeterminate result. Keep maintained tests and fixtures in the owning repository and retain raw logs in the existing artifact store.
6. In a prepared Exarchos task, use the capsule's declared result fields. Return evidence to the existing coordinator. A settlement evidence entry needs a capsule-admitted kind and a reference to an intact recorded evidence row. Retain native reports outside settlement when they have no supported carrier. Keep the product claim distinct from completion of a task that found a defect.
