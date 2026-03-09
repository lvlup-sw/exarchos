---
outline: deep
---

# Feature Development

This example walks through building a rate limiter module for an API server, from initial idea to merged PR.

## The scenario

You have a Node.js API server that handles requests from multiple clients. You want to add per-client-IP rate limiting so that no single client can overwhelm the server. Clients that exceed their limit should get a `429 Too Many Requests` response.

## Ideation

Start the workflow:

```
/exarchos:ideate Add rate limiting to the API server, per-client-IP, configurable limits, return 429 when exceeded
```

Exarchos initializes a feature workflow and asks a few questions. What transport does the server use? Are there existing middleware patterns? Do you need distributed rate limiting or is single-process enough?

After gathering context, it presents three approaches:

1. In-memory token bucket. Each IP gets a bucket that refills at a fixed rate. Simple, no external dependencies, but state is lost on restart.
2. Redis-backed sliding window. Counts requests in a sliding time window stored in Redis. Survives restarts, works across multiple server instances. Adds a Redis dependency.
3. Middleware with pluggable backends. Abstract interface that supports both in-memory and Redis backends. More code upfront, but swappable later.

You choose approach 1 for simplicity. The design document is saved:

```
Design saved to docs/designs/2026-03-08-rate-limiter.md
  DR-1: Token bucket data structure with configurable rate and capacity
  DR-2: Rate limiter middleware that extracts client IP and enforces limits
  DR-3: Configuration parsing from environment variables
  DR-4: 429 response with Retry-After header when limit exceeded
```

The design looks right. The workflow auto-continues to planning.

## Planning

The planning skill reads the design and generates four tasks:

```
Plan: rate-limiter (4 tasks, 2 parallel groups)

  Group 1 (parallel):
    Task 001: Token bucket data structure with tests
              Implements: DR-1
              Files: src/rateLimiter/tokenBucket.ts, tokenBucket.test.ts

    Task 003: Configuration parsing with tests
              Implements: DR-3
              Files: src/rateLimiter/config.ts, config.test.ts

  Group 2 (sequential):
    Task 002: Rate limiter middleware with tests
              Implements: DR-2
              Depends on: 001
              Files: src/rateLimiter/middleware.ts, middleware.test.ts

    Task 004: Integration test for 429 response
              Implements: DR-4
              Depends on: 001, 002, 003
              Files: src/rateLimiter/integration.test.ts
```

Plan-review runs automatically and confirms every DR-N requirement maps to a task. Full coverage.

You review the plan. Four tasks, clean dependencies, each with test-first expectations. You approve.

## Delegation

After plan approval, delegation creates worktrees and dispatches agents.

Tasks 1 and 3 are independent, so they run in parallel. Each implementer agent gets its own git worktree and follows strict TDD:

Task 1 (token bucket): Write `tokenBucket.test.ts` with tests for consume, refill, and capacity. Run tests (RED). Write `tokenBucket.ts` with the token bucket implementation. Run tests (GREEN). Clean up naming and remove dead code (REFACTOR). Task complete.

Task 3 (config): Write `config.test.ts` with tests for default values, environment overrides, and invalid input. Run tests (RED). Write `config.ts` with the parser. Run tests (GREEN). Task complete.

Both tasks pass their convergence gates (TDD compliance, static analysis). Task 2 starts next, followed by task 4 after task 2 finishes. All four tasks complete successfully.

## Review

Two-stage review runs automatically against the combined diff of all task branches.

Stage 1 (spec compliance): The reviewer traces each design requirement to its implementation. DR-1 through DR-4 are all covered by code and tests. TDD compliance verified: test commits precede implementation commits in every task branch.

Stage 2 (code quality): Static analysis is clean. One informational finding: the `tokenBucket.ts` consume method could be shorter by extracting the refill calculation. This is a context economy suggestion, not a blocking issue.

Verdict: **APPROVED**.

## Synthesis

Synthesis runs pre-flight checks (tests pass, typecheck clean), then creates a pull request:

```
PR #142: feat: add per-client-IP rate limiting with token bucket algorithm

  Summary: Adds request rate limiting using an in-memory token bucket
  per client IP. Configurable via environment variables. Returns 429
  with Retry-After header when a client exceeds its limit.

  Changes:
  - tokenBucket.ts — token bucket data structure
  - middleware.ts — Express middleware for rate limiting
  - config.ts — environment variable parsing
  - 4 test files with full coverage

  Tests: 18 pass · Build 0 errors
  Design: docs/designs/2026-03-08-rate-limiter.md
```

CI passes. You review the diff, confirm the merge, and run `/exarchos:cleanup`. Worktrees removed, branches pruned, workflow resolved to completed. The audit trail stays in the event store.
