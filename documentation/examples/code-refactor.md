---
outline: deep
---

# Code Refactor

This example walks through refactoring a monolithic request handler using the refactor workflow's polish track.

## The codebase

Your `handleRequest` function in `src/server/handler.ts` is 300 lines long. It authenticates the request, validates the payload, routes to the right handler, and formats the response. All in one function, with 8 levels of nesting. The code works, but adding a new route means reading all 300 lines to find the right place to make changes.

## Exploration

Start the refactor workflow:

```
/exarchos:refactor Break up the monolithic handleRequest function in src/server/handler.ts
```

Exarchos analyzes the function and produces a scope assessment:

```
Scope assessment:
  File: src/server/handler.ts (1 file)
  Function: handleRequest — 300 lines, 8 levels of nesting
  Responsibilities identified: 4
    1. Authentication (lines 12-67)
    2. Payload validation (lines 69-134)
    3. Route dispatch (lines 136-245)
    4. Response formatting (lines 247-298)
  Test coverage: good (handler.test.ts has 22 tests)
  Recommended track: polish (single file, <=5 files affected)
```

One file, four clear responsibilities, existing test coverage. This is a textbook polish-track refactor.

## Brief

Exarchos writes a refactoring brief (stored in the workflow state, not a separate document):

```
Brief: Extract handleRequest into focused functions

  Problem: 300-line function with 4 tangled responsibilities.
    Modifications require reading the entire function.

  Goals:
    - Extract authenticateRequest(), validatePayload(),
      routeRequest(), formatResponse()
    - Each function gets its own unit tests
    - handleRequest becomes a pipeline calling the four functions
    - No behavioral changes (all existing tests must pass)

  Affected areas:
    - src/server/handler.ts
    - src/server/handler.test.ts (existing tests preserved,
      new tests added)

  Out of scope:
    - Changing route definitions
    - Modifying authentication logic
    - Adding new response formats

  Success criteria:
    - All 22 existing tests pass without modification
    - Each extracted function has at least 3 unit tests
    - handleRequest is under 50 lines
    - No function exceeds 80 lines
```

The brief is concise and bounded. No scope creep.

## Implementation

The polish track does not create worktrees or delegate to agents. The orchestrator handles the implementation directly since this is a contained, single-file change.

Step 1: Extract `authenticateRequest()`.

Pull lines 12-67 into a new function. Write three tests: valid token, expired token, missing token. Run the full suite. All 22 existing tests pass, plus the 3 new ones.

Step 2: Extract `validatePayload()`.

Pull lines 69-134 into a new function. Write tests for valid payload, missing required fields, and malformed JSON. Run the full suite. 28 tests pass.

Step 3: Extract `routeRequest()`.

Pull lines 136-245 into a new function. Write tests for known route, unknown route, and method not allowed. Run the full suite. 31 tests pass.

Step 4: Extract `formatResponse()`.

Pull lines 247-298 into a new function. Write tests for success response, error response, and custom headers. Run the full suite. 34 tests pass.

Step 5: Rewrite `handleRequest`.

Replace the 300-line body with a pipeline:

```typescript
async function handleRequest(req: Request, res: Response) {
  const authResult = authenticateRequest(req);
  if (!authResult.ok) return formatResponse(res, authResult.error);

  const validation = validatePayload(req, authResult.user);
  if (!validation.ok) return formatResponse(res, validation.error);

  const result = await routeRequest(req, validation.payload);
  return formatResponse(res, result);
}
```

Twelve lines. All 34 tests pass.

## Validation

Convergence gates verify the refactor:

- All 22 original tests pass without modification (no behavioral changes)
- 12 new unit tests pass for the extracted functions
- Static analysis clean
- Context economy check: function lengths are 30 to 65 lines each, down from 300

The brief's success criteria are met: `handleRequest` is 12 lines (under 50), no function exceeds 80 lines, and each extracted function has at least 3 tests.

## Ship

The polish track creates a single commit and pushes directly:

```
PR #93: refactor: extract handleRequest into focused functions

  Summary: Breaks the 300-line handleRequest into four focused functions:
  authenticateRequest, validatePayload, routeRequest, formatResponse.
  No behavioral changes. All existing tests pass unmodified.

  Tests: 34 pass (22 existing + 12 new) · Build 0 errors
```

You merge and run `/exarchos:cleanup`. The workflow resolves to completed.
