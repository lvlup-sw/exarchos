# Jules Conversation & Question Detection Tools

## Problem Statement

### Issue 1: No Visibility into Jules Conversations

The current Jules MCP integration lacks visibility into session conversations and pending questions:

1. **`jules_check_status`** only returns basic metadata (id, state, title, url, timestamp)
2. **Session state is unreliable** — sessions with pending questions show `state: "COMPLETED"` despite having no PR and awaiting user input
3. **No way to view conversation history** — cannot see what Jules is doing or has asked
4. **Activities API exists but isn't exposed** — `JulesClient.getActivities()` exists but no MCP tool uses it

This blocks the `/delegate` workflow from detecting when Jules needs clarification.

### Issue 2: CodeRabbit Skips Jules PRs

CodeRabbit is not reviewing PRs created by Jules (bot user). This means automated PRs bypass the code review workflow.

**Current state:** `coderabbit-config/config.yaml` has no explicit `auto_review` settings
**Required:** Configure CodeRabbit to review PRs from Jules bot user

## Solution

### Part A: Jules MCP Tools

Add two specialized MCP tools:

### Tool 1: `jules_get_conversation`

Returns the chronological conversation history for a session.

**Input:**
```typescript
{
  sessionId: string;   // Required: Jules session ID
  limit?: number;      // Optional: max activities to return (default: 50)
}
```

**Output:**
```typescript
{
  sessionId: string;
  activities: Array<{
    id: string;
    type: 'plan' | 'user_message' | 'agent_message' | 'progress' | 'completed' | 'failed';
    timestamp: string;
    content: string;           // The message/plan/progress text
    originator?: 'user' | 'agent' | 'system';
    artifacts?: Array<{
      type: 'changeset' | 'bash_output' | 'media';
      summary: string;         // Brief description
    }>;
  }>;
}
```

**Use case:** Monitoring progress, debugging, viewing full conversation.

### Tool 2: `jules_get_pending_question`

Detects if Jules is waiting for user input and extracts the question.

**Input:**
```typescript
{
  sessionId: string;   // Required: Jules session ID
}
```

**Output:**
```typescript
{
  sessionId: string;
  hasPendingQuestion: boolean;
  question?: string;           // The question text (if any)
  context?: string;            // Surrounding context from agent
  detectedAt?: string;         // Timestamp of the question
}
```

**Detection logic:**
1. Fetch recent activities (last 10)
2. Find the most recent `agentMessaged` activity
3. Check if it contains question indicators:
   - Ends with `?`
   - Contains phrases like "please clarify", "which option", "should I", "do you want"
   - Session state is `AWAITING_USER_FEEDBACK` (when API is accurate)
4. If the last activity is agent-originated and appears to be a question, return it

**Use case:** Workflow automation to detect when Jules needs input.

## Implementation

### 1. Update Activity Types (`types.ts`)

Expand the `Activity` interface to match the actual API response:

```typescript
export type ActivityEventType =
  | 'planGenerated'
  | 'planApproved'
  | 'userMessaged'
  | 'agentMessaged'
  | 'progressUpdated'
  | 'sessionCompleted'
  | 'sessionFailed';

export interface Artifact {
  type: 'changeset' | 'bashOutput' | 'media';
  // ChangeSet fields
  baseCommitId?: string;
  unidiffPatch?: string;
  suggestedCommitMessage?: string;
  // Bash output fields
  command?: string;
  output?: string;
  exitCode?: number;
  // Media fields
  mimeType?: string;
  data?: string;  // base64
}

export interface Activity {
  name: string;
  id: string;
  originator: 'system' | 'agent' | 'user';
  description: string;
  createTime: string;

  // Event-specific content (exactly one will be present)
  planGenerated?: { steps: string[] };
  planApproved?: { approvedBy: string };
  userMessaged?: { content: string };
  agentMessaged?: { content: string };
  progressUpdated?: { status: string };
  sessionCompleted?: { summary: string };
  sessionFailed?: { reason: string };

  artifacts?: Artifact[];
}
```

### 2. Add Tool Schemas (`tools.ts`)

```typescript
const getConversationSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  limit: z.number().optional().default(50)
});

const getPendingQuestionSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});
```

### 3. Implement Tool Functions (`tools.ts`)

```typescript
async jules_get_conversation(input): Promise<ToolResult> {
  const activities = await client.getActivities(input.sessionId);
  // Transform to simplified format
  // Return chronological list
}

async jules_get_pending_question(input): Promise<ToolResult> {
  const activities = await client.getActivities(input.sessionId);
  const lastAgentMessage = activities
    .filter(a => a.agentMessaged)
    .pop();

  if (!lastAgentMessage) {
    return { hasPendingQuestion: false };
  }

  const content = lastAgentMessage.agentMessaged.content;
  const isQuestion = detectQuestion(content);

  return {
    hasPendingQuestion: isQuestion,
    question: isQuestion ? content : undefined,
    detectedAt: lastAgentMessage.createTime
  };
}

function detectQuestion(content: string): boolean {
  // Heuristics for question detection
  const questionPatterns = [
    /\?$/,                           // Ends with ?
    /please (clarify|confirm|let me know)/i,
    /which (option|approach|method)/i,
    /should I/i,
    /do you (want|prefer|need)/i,
    /can you (provide|specify|confirm)/i,
    /what (should|would you)/i
  ];
  return questionPatterns.some(p => p.test(content));
}
```

### 4. Register Tools (`index.ts`)

Add tool registrations following the existing pattern.

### Part B: CodeRabbit Configuration

Update `coderabbit-config/config.yaml` to enable reviews for bot users:

```yaml
reviews:
  auto_review:
    enabled: true
    ignore_usernames: []  # Explicitly empty - don't skip any users including bots
```

This ensures CodeRabbit reviews all PRs regardless of author, including those from Jules.

## Files Changed

| File | Change |
|------|--------|
| `plugins/jules/servers/jules-mcp/src/types.ts` | Expand `Activity` interface, add `Artifact` type |
| `plugins/jules/servers/jules-mcp/src/tools.ts` | Add schemas, descriptions, and implementations for both tools |
| `plugins/jules/servers/jules-mcp/src/index.ts` | Register `jules_get_conversation` and `jules_get_pending_question` |
| `coderabbit-config/config.yaml` | Add `auto_review` settings to include bot users |

## Testing Strategy

1. **Unit tests** for `detectQuestion()` heuristics
2. **Integration tests** mocking API responses with various activity types
3. **Manual verification** with real Jules sessions that have pending questions

## Workflow Integration

After implementation, the `/delegate` skill can:

```typescript
// Poll for completion or questions
const status = await jules_check_status({ sessionId });
const question = await jules_get_pending_question({ sessionId });

if (question.hasPendingQuestion) {
  // Surface to user or auto-respond
  await jules_send_feedback({ sessionId, message: response });
}
```

## Open Questions

1. **Pagination** — Should `jules_get_conversation` handle pagination automatically or expose `pageToken`?
   - **Recommendation:** Auto-paginate up to `limit`, hide complexity

2. **Question detection accuracy** — Heuristics may have false positives/negatives
   - **Mitigation:** Start with conservative patterns, iterate based on real usage

## References

- [Jules Activities API](https://jules.google/docs/api/reference/activities)
- [Jules Sessions API](https://jules.google/docs/api/reference/sessions)
