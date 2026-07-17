# Implementation Plan: Jules Conversation & Question Detection Tools

**Design:** `docs/designs/2026-01-05-jules-conversation-tools.md`
**Created:** 2026-01-05

## Summary

Implement two new MCP tools for Jules session visibility:
1. `jules_get_conversation` - View chronological activity history
2. `jules_get_pending_question` - Detect if Jules is waiting for user input

Plus: Update CodeRabbit config to review Jules bot PRs.

## Task Overview

| ID | Task | Dependencies | Parallelizable |
|----|------|--------------|----------------|
| 001 | Expand Activity types | None | Yes |
| 002 | Add Activity fixtures | 001 | Yes |
| 003 | Implement detectQuestion helper | None | Yes |
| 004 | Implement jules_get_conversation tool | 001, 002 | No |
| 005 | Implement jules_get_pending_question tool | 001, 002, 003 | No |
| 006 | Register new tools in index.ts | 004, 005 | No |
| 007 | Update CodeRabbit config | None | Yes |

## Parallel Groups

- **Group A (can run in parallel):** Tasks 001, 003, 007
- **Group B (sequential after A):** Tasks 002, 004, 005, 006

---

## Task Details

### Task 001: Expand Activity Types
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write type tests to validate Activity structure
   - File: `plugins/jules/servers/jules-mcp/src/types.test.ts` (create)
   - Test: `Activity_WithAgentMessage_HasExpectedStructure`
   - Test: `Activity_WithPlanGenerated_HasStepsArray`
   - Test: `Artifact_ChangeSet_HasPatchFields`
   - Expected failure: Types don't exist yet

2. [GREEN] Update types.ts with expanded Activity interface
   - File: `plugins/jules/servers/jules-mcp/src/types.ts`
   - Add: `ActivityEventType` union type
   - Add: `Artifact` interface with changeset/bash/media fields
   - Update: `Activity` interface with event-specific fields

3. [REFACTOR] Ensure backward compatibility with existing code

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Add Activity Fixtures for Testing
**Phase:** RED → GREEN

1. [RED] Import new activity fixtures in tools.test.ts
   - File: `plugins/jules/servers/jules-mcp/src/tools.test.ts`
   - Expected failure: Fixtures don't exist

2. [GREEN] Create expanded activity fixtures
   - File: `plugins/jules/servers/jules-mcp/src/test/fixtures.ts`
   - Add: `mockActivityAgentMessage` with question content
   - Add: `mockActivityAgentMessageNoQuestion` with statement
   - Add: `mockActivityUserMessage`
   - Add: `mockActivityPlanGenerated`
   - Add: `mockActivityWithArtifacts`

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 003: Implement detectQuestion Helper
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests for question detection heuristics
   - File: `plugins/jules/servers/jules-mcp/src/tools.test.ts`
   - Test: `detectQuestion_EndsWithQuestionMark_ReturnsTrue`
   - Test: `detectQuestion_ContainsShouldI_ReturnsTrue`
   - Test: `detectQuestion_ContainsDoYouWant_ReturnsTrue`
   - Test: `detectQuestion_ContainsPleaseConfirm_ReturnsTrue`
   - Test: `detectQuestion_PlainStatement_ReturnsFalse`
   - Test: `detectQuestion_EmptyString_ReturnsFalse`
   - Expected failure: Function doesn't exist

2. [GREEN] Implement detectQuestion function
   - File: `plugins/jules/servers/jules-mcp/src/tools.ts`
   - Export: `detectQuestion(content: string): boolean`
   - Implement regex patterns for question detection

3. [REFACTOR] Optimize regex patterns, add jsdoc

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 004: Implement jules_get_conversation Tool
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests for jules_get_conversation
   - File: `plugins/jules/servers/jules-mcp/src/tools.test.ts`
   - Test: `jules_get_conversation_ValidSession_ReturnsActivities`
   - Test: `jules_get_conversation_WithLimit_RespectsLimit`
   - Test: `jules_get_conversation_EmptyActivities_ReturnsEmptyArray`
   - Test: `jules_get_conversation_EmptySessionId_ReturnsError`
   - Test: `jules_get_conversation_ApiError_ReturnsError`
   - Expected failure: Tool doesn't exist

2. [GREEN] Implement tool function
   - File: `plugins/jules/servers/jules-mcp/src/tools.ts`
   - Add: `getConversationSchema` with sessionId and optional limit
   - Add: `jules_get_conversation` to tool factory
   - Transform activities to simplified output format

3. [REFACTOR] Extract activity transformation logic

**Dependencies:** Tasks 001, 002
**Parallelizable:** No

---

### Task 005: Implement jules_get_pending_question Tool
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests for jules_get_pending_question
   - File: `plugins/jules/servers/jules-mcp/src/tools.test.ts`
   - Test: `jules_get_pending_question_HasQuestion_ReturnsQuestion`
   - Test: `jules_get_pending_question_NoQuestion_ReturnsFalse`
   - Test: `jules_get_pending_question_NoAgentMessages_ReturnsFalse`
   - Test: `jules_get_pending_question_EmptySessionId_ReturnsError`
   - Test: `jules_get_pending_question_ApiError_ReturnsError`
   - Expected failure: Tool doesn't exist

2. [GREEN] Implement tool function
   - File: `plugins/jules/servers/jules-mcp/src/tools.ts`
   - Add: `getPendingQuestionSchema` with sessionId
   - Add: `jules_get_pending_question` to tool factory
   - Use `detectQuestion` helper for detection

3. [REFACTOR] Improve question extraction (context handling)

**Dependencies:** Tasks 001, 002, 003
**Parallelizable:** No

---

### Task 006: Register New Tools in MCP Server
**Phase:** RED → GREEN

1. [RED] Verify tools are not yet registered
   - File: `plugins/jules/servers/jules-mcp/src/index.ts`
   - Manual verification: tools not in server registration

2. [GREEN] Register both new tools
   - File: `plugins/jules/servers/jules-mcp/src/index.ts`
   - Add: `server.tool('jules_get_conversation', ...)`
   - Add: `server.tool('jules_get_pending_question', ...)`
   - Follow existing registration pattern

3. [VERIFY] Run full test suite to ensure integration

**Dependencies:** Tasks 004, 005
**Parallelizable:** No

---

### Task 007: Update CodeRabbit Configuration
**Phase:** GREEN (config change, no test needed)

1. [GREEN] Add auto_review settings to config
   - File: `coderabbit-config/config.yaml`
   - Add: `auto_review.enabled: true`
   - Add: `auto_review.ignore_usernames: []`

2. [VERIFY] Validate YAML syntax

**Dependencies:** None
**Parallelizable:** Yes

---

## Execution Order

```
Parallel Group 1:
├── Task 001: Expand Activity types
├── Task 003: Implement detectQuestion helper
└── Task 007: Update CodeRabbit config

Sequential Chain:
Task 001 → Task 002 → Task 004 → Task 005 → Task 006
                 ↑
            Task 003
```

## Test File Summary

| File | New Tests |
|------|-----------|
| `src/types.test.ts` | 3 type validation tests |
| `src/tools.test.ts` | ~16 new tests (6 detectQuestion + 5 get_conversation + 5 get_pending_question) |

## Definition of Done

- [ ] All new tests pass
- [ ] Existing tests still pass
- [ ] No TypeScript errors
- [ ] Tools registered and callable via MCP
- [ ] CodeRabbit config updated
