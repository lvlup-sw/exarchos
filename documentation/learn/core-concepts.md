---
outline: deep
---

# Core concepts

## Workflows

A workflow is a structured sequence of phases that takes a unit of work from idea to shipped code. Exarchos supports four workflow types:

Feature workflows move through: ideate, plan, plan-review, delegate, review, synthesize, completed. This is the full path from design exploration through a merged PR.

Debug workflows move through: triage, investigate, root cause analysis, design, then branch into either a hotfix track (implement, validate) or a thorough track (implement, validate, review). Use this when something is broken and you need to fix it.

Refactor workflows move through: explore, brief, then branch into either a polish track (implement, validate, update docs) or an overhaul track (plan, plan-review, delegate, review, update docs). The branch depends on scope.

Oneshot workflows (introduced in v2.6.0) move through: plan, implementing, and then a runtime choice state that forks to either `completed` (direct-commit) or `synthesize → completed` (PR). No subagent dispatch, no two-stage review — everything runs in-session within a single TDD loop. Use oneshot for trivial changes like typo fixes, config tweaks, or exploratory spikes where the ceremony of the feature workflow would be wasteful. The choice between direct-commit and PR is resolved at the end of `implementing` by evaluating a pure event-sourced guard against the `synthesisPolicy` declared at init (`always`, `never`, or `on-request` default) plus any `synthesize.requested` events emitted at runtime.

Each type has its own phase sequence and transition rules. You pick the type when you start a workflow, and the state machine handles the rest.

## Phases and transitions

Workflows move through ordered phases. You can't skip ahead. A state machine enforces valid transitions and rejects invalid ones with clear error messages.

Each transition has guard conditions. For example, transitioning from `plan` to `plan-review` requires that a plan document actually exists. Transitioning from `delegate` to `review` requires that all delegated tasks have completed. If a guard fails, the transition is blocked and you get a message explaining what's missing.

This isn't bureaucracy for its own sake. It prevents the common failure mode where an agent skips verification steps because it "already knows" the code is correct.

## Events and state

Every workflow action produces an immutable event. Events are stored in an append-only JSONL log. The current state of any workflow is a projection of its events, not a mutable record that gets updated in place.

This gives you two things:

1. Crash recovery. If state gets corrupted, the `reconcile` action rebuilds it from scratch by replaying the event history. No data is lost because events are never modified.
2. Audit trail. You can trace every decision, transition, and gate result back to the event that recorded it. When a reviewer agent flags an issue, you can see exactly which gate produced the finding and what data it checked.

The event store uses JSONL files on the local filesystem. No database. No network dependency.

## Convergence gates

Convergence gates are automated verification checks that run at phase boundaries. They assess five dimensions:

### Specification fidelity and TDD compliance
Requirements traced from the design doc to implementation code and tests. Verifies that what was specified is what was built, and that tests exist for the specified behavior.

### Architectural pattern compliance
Static analysis, type checking, and structural invariants. Catches lint errors, type mismatches, and violations of project conventions before they reach review.

### Context economy and token efficiency
Code complexity metrics that affect LLM context consumption. Long functions, deeply nested logic, and overly complex modules waste tokens in future sessions. This dimension flags them.

### Operational resilience
Error handling coverage. Catches swallowed exceptions, missing error boundaries, and unhandled promise rejections. Code that silently fails is code that's hard to debug later.

### Workflow determinism and variance reduction
Test reliability checks. Flags `.only` and `.skip` markers, flaky test patterns, and non-deterministic test ordering. Tests that pass sometimes aren't tests.

Each dimension produces a pass/fail result. A convergence gate passes when all five dimensions have been checked and all pass. The gate can be scoped to a specific phase, so you can check convergence for just the implementation phase without requiring review-phase gates to have run yet.

## Artifact references

Design docs, plans, and specs are referenced by file path. They are never dumped into context. When the agent needs to check a design requirement, it reads the file. When it needs to report on plan coverage, it references the path.

This keeps token usage low. A design doc might be 2,000 tokens. Referencing it by path costs about 20 tokens. The agent reads the full document only when it actually needs the content.

## Agent roles

Exarchos defines three typed agents. Each runs in an isolated git worktree with scoped tool access.

- Implementer. Writes code using strict TDD (red-green-refactor). Has file read/write access. Cannot spawn sub-agents. Must verify it's operating inside a worktree before making changes.
- Fixer. Diagnoses and repairs failed tasks. Receives the failure context from the previous attempt. Follows an adversarial protocol: reproduce the failure, identify root cause, apply a minimal fix, verify, then run the full suite.
- Reviewer. Read-only code review. Cannot write or edit files. Checks design compliance, test coverage, and anti-patterns. Produces structured findings categorized as critical, warning, or suggestion.

Worktree isolation means agents work on separate branches in separate directories. They can't step on each other's changes.
