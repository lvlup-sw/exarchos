import { z } from 'zod';
import type { IJulesClient, ToolResult, Activity } from './types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const listSourcesSchema = z.object({});

const createTaskSchema = z.object({
  repo: z.string().min(1, 'repo is required'),
  prompt: z.string().min(1, 'prompt is required'),
  branch: z.string().optional().default('main'),
  title: z.string().optional()
});

const checkStatusSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

const approvePlanSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

const sendFeedbackSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  message: z.string().min(1, 'message is required')
});

const cancelSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

const getConversationSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  limit: z.number().optional().default(50)
});

const getPendingQuestionSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

// ============================================================================
// Exported Schemas and Descriptions
// ============================================================================

export const toolSchemas = {
  jules_list_sources: listSourcesSchema,
  jules_create_task: createTaskSchema,
  jules_check_status: checkStatusSchema,
  jules_approve_plan: approvePlanSchema,
  jules_send_feedback: sendFeedbackSchema,
  jules_cancel: cancelSchema,
  jules_get_conversation: getConversationSchema,
  jules_get_pending_question: getPendingQuestionSchema
};

export const toolDescriptions = {
  jules_list_sources: 'List repositories connected to Jules',
  jules_create_task: 'Delegate a coding task to Jules autonomous agent',
  jules_check_status: 'Check the status of a Jules session',
  jules_approve_plan: 'Approve a pending Jules execution plan',
  jules_send_feedback: 'Send feedback or instructions to a Jules session',
  jules_cancel: 'Cancel/delete a Jules session',
  jules_get_conversation: 'Get conversation history for a Jules session',
  jules_get_pending_question: 'Check if Jules has a pending question requiring user input'
};

// ============================================================================
// Helper Functions
// ============================================================================

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError
  };
}

function jsonResult(data: object, isError = false): ToolResult {
  return textResult(JSON.stringify(data, null, 2), isError);
}

function errorResult(message: string): ToolResult {
  return textResult(`Error: ${message}`, true);
}

// ============================================================================
// Activity Helpers
// ============================================================================

function getActivityType(activity: Activity): string {
  if (activity.planGenerated) return 'plan';
  if (activity.planApproved) return 'plan_approved';
  if (activity.userMessaged) return 'user_message';
  if (activity.agentMessaged) return 'agent_message';
  if (activity.progressUpdated) return 'progress';
  if (activity.sessionCompleted) return 'completed';
  if (activity.sessionFailed) return 'failed';
  return 'unknown';
}

function getActivityContent(activity: Activity): string {
  if (activity.planGenerated) return activity.planGenerated.steps.join('\n');
  if (activity.planApproved) return `Approved by: ${activity.planApproved.approvedBy}`;
  if (activity.userMessaged) return activity.userMessaged.content;
  if (activity.agentMessaged) return activity.agentMessaged.content;
  if (activity.progressUpdated) return activity.progressUpdated.status;
  if (activity.sessionCompleted) return activity.sessionCompleted.summary;
  if (activity.sessionFailed) return activity.sessionFailed.reason;
  return activity.description;
}

// ============================================================================
// TDD Enforcement
// ============================================================================

const TDD_INSTRUCTIONS = `

## TDD Requirements (MANDATORY)

Follow strict Test-Driven Development (Red-Green-Refactor):

1. **RED Phase**: Write a failing test FIRST
   - Test must compile but fail when run
   - Test must fail for the RIGHT reason
   - Use descriptive test names: Method_Scenario_ExpectedOutcome

2. **GREEN Phase**: Write MINIMUM code to pass
   - Only implement what the test requires
   - No additional features or optimizations

3. **REFACTOR Phase**: Clean up while tests stay green
   - Apply SOLID principles
   - Remove duplication
   - Run tests after each change

### Test Patterns

For TypeScript (Vitest):
\`\`\`typescript
describe('Component', () => {
  it('should do expected behavior', async () => {
    // Arrange
    const input = ...;
    // Act
    const result = await method(input);
    // Assert
    expect(result).toBe(expected);
  });
});
\`\`\`

For C# (TUnit):
\`\`\`csharp
[Test]
public async Task Method_Scenario_Outcome()
{
    // Arrange
    var sut = new SystemUnderTest();
    // Act
    var result = sut.Method();
    // Assert (MUST await)
    await Assert.That(result).IsEqualTo(expected);
}
\`\`\`

### Deliverables
- Tests written BEFORE implementation
- All tests passing
- Code coverage for new functionality
`;

function buildPromptWithTDD(userPrompt: string): string {
  return `${userPrompt}${TDD_INSTRUCTIONS}`;
}

// ============================================================================
// Question Detection
// ============================================================================

/**
 * Detects if content appears to be a question requiring user input.
 * Uses heuristics to identify common question patterns.
 */
export function detectQuestion(content: string): boolean {
  if (!content || content.trim().length === 0) {
    return false;
  }

  const trimmed = content.trim();

  // Pattern: ends with question mark (but not optional chaining like config?.json)
  // Must have a space before the question mark or be a short string
  if (/\?\s*$/.test(trimmed) && !/\w\?\.\w/.test(trimmed)) {
    return true;
  }

  // Question phrase patterns (case insensitive)
  const questionPatterns = [
    /\bshould I\b/i,
    /\bdo you (want|prefer|need)\b/i,
    /\bcan you (provide|specify|confirm|clarify)\b/i,
    /\bplease (clarify|confirm|let me know|specify)\b/i,
    /\bwhich (option|approach|method|way)\b/i,
    /\bwhat (should|would you)\b/i,
    /\bwould you (like|prefer)\b/i,
    /\bcould you (provide|clarify|confirm)\b/i
  ];

  return questionPatterns.some((pattern) => pattern.test(trimmed));
}

// ============================================================================
// Tool Factory
// ============================================================================

export function createJulesTools(client: IJulesClient) {
  return {
    async jules_list_sources(
      _input: z.infer<typeof listSourcesSchema>
    ): Promise<ToolResult> {
      try {
        const sources = await client.listSources();

        if (sources.length === 0) {
          return textResult(
            'No repositories connected to Jules. Connect a repo at https://jules.google'
          );
        }

        return jsonResult({
          sources: sources.map((s) => ({
            repo: `${s.githubRepo.owner}/${s.githubRepo.repo}`,
            isPrivate: s.githubRepo.isPrivate,
            defaultBranch: s.githubRepo.defaultBranch.displayName,
            branches: s.githubRepo.branches.map((b) => b.displayName)
          }))
        });
      } catch (error) {
        return errorResult((error as Error).message);
      }
    },

    async jules_create_task(
      input: z.infer<typeof createTaskSchema>
    ): Promise<ToolResult> {
      try {
        const validated = createTaskSchema.parse(input);

        // Automatically inject TDD instructions into the prompt
        const enhancedPrompt = buildPromptWithTDD(validated.prompt);

        // Validate repo is connected to Jules
        const sources = await client.listSources();
        const expectedSource = `sources/github/${validated.repo}`;
        const sourceExists = sources.some((s) => s.name === expectedSource);

        if (!sourceExists) {
          const connectedRepos = sources
            .map((s) => `${s.githubRepo.owner}/${s.githubRepo.repo}`)
            .join(', ');
          return errorResult(
            `Repository "${validated.repo}" is not connected to Jules. ` +
              `Connected repos: ${connectedRepos || 'none'}. ` +
              `Connect at https://jules.google`
          );
        }

        const session = await client.createSession({
          prompt: enhancedPrompt,
          sourceContext: {
            source: expectedSource,
            githubRepoContext: validated.branch
              ? { startingBranch: validated.branch }
              : undefined
          },
          title: validated.title,
          requirePlanApproval: true,
          automationMode: 'AUTO_CREATE_PR'
        });

        return jsonResult({
          sessionId: session.id,
          state: session.state,
          url: session.url,
          message:
            'Task delegated to Jules with TDD requirements. Use jules_check_status to monitor progress.'
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_check_status(
      input: z.infer<typeof checkStatusSchema>
    ): Promise<ToolResult> {
      try {
        const validated = checkStatusSchema.parse(input);
        const session = await client.getSession(validated.sessionId);

        const result: Record<string, unknown> = {
          sessionId: session.id,
          state: session.state,
          title: session.title,
          url: session.url,
          updatedAt: session.updateTime
        };

        // Add PR URL if completed with outputs
        if (session.outputs && session.outputs.length > 0) {
          result.pullRequestUrl = session.outputs[0].url;
        }

        return jsonResult(result);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_approve_plan(
      input: z.infer<typeof approvePlanSchema>
    ): Promise<ToolResult> {
      try {
        const validated = approvePlanSchema.parse(input);
        await client.approvePlan(validated.sessionId);

        return jsonResult({
          success: true,
          sessionId: validated.sessionId,
          message: 'Plan approved. Jules will begin implementation.'
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_send_feedback(
      input: z.infer<typeof sendFeedbackSchema>
    ): Promise<ToolResult> {
      try {
        const validated = sendFeedbackSchema.parse(input);
        await client.sendMessage(validated.sessionId, validated.message);

        return jsonResult({
          success: true,
          sessionId: validated.sessionId,
          message: 'Feedback sent to Jules.'
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_cancel(
      input: z.infer<typeof cancelSchema>
    ): Promise<ToolResult> {
      try {
        const validated = cancelSchema.parse(input);
        await client.deleteSession(validated.sessionId);

        return jsonResult({
          success: true,
          sessionId: validated.sessionId,
          message: 'Session cancelled.'
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_get_conversation(
      input: z.infer<typeof getConversationSchema>
    ): Promise<ToolResult> {
      try {
        const validated = getConversationSchema.parse(input);
        const activities = await client.getActivities(validated.sessionId);

        const limitedActivities = activities.slice(0, validated.limit);

        const formattedActivities = limitedActivities.map((activity) => ({
          id: activity.id,
          type: getActivityType(activity),
          timestamp: activity.createTime,
          content: getActivityContent(activity),
          originator: activity.originator,
          artifacts: activity.artifacts?.map((a) => ({
            type: a.type,
            summary:
              a.type === 'changeset'
                ? a.suggestedCommitMessage || 'Code changes'
                : a.type === 'bashOutput'
                  ? `Command: ${a.command}`
                  : 'Media attachment'
          }))
        }));

        return jsonResult({
          sessionId: validated.sessionId,
          activities: formattedActivities
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    },

    async jules_get_pending_question(
      input: z.infer<typeof getPendingQuestionSchema>
    ): Promise<ToolResult> {
      try {
        const validated = getPendingQuestionSchema.parse(input);
        const activities = await client.getActivities(validated.sessionId);

        // Find the last agent message
        const agentMessages = activities.filter((a) => a.agentMessaged);
        const lastAgentMessage = agentMessages[agentMessages.length - 1];

        if (!lastAgentMessage || !lastAgentMessage.agentMessaged) {
          return jsonResult({
            sessionId: validated.sessionId,
            hasPendingQuestion: false
          });
        }

        const content = lastAgentMessage.agentMessaged.content;
        const isQuestion = detectQuestion(content);

        if (isQuestion) {
          return jsonResult({
            sessionId: validated.sessionId,
            hasPendingQuestion: true,
            question: content,
            detectedAt: lastAgentMessage.createTime
          });
        }

        return jsonResult({
          sessionId: validated.sessionId,
          hasPendingQuestion: false
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return errorResult(error.errors[0].message);
        }
        return errorResult((error as Error).message);
      }
    }
  };
}

// Export types for tool inputs
export type ListSourcesInput = z.infer<typeof listSourcesSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CheckStatusInput = z.infer<typeof checkStatusSchema>;
export type ApprovePlanInput = z.infer<typeof approvePlanSchema>;
export type SendFeedbackInput = z.infer<typeof sendFeedbackSchema>;
export type CancelInput = z.infer<typeof cancelSchema>;
export type GetConversationInput = z.infer<typeof getConversationSchema>;
export type GetPendingQuestionInput = z.infer<typeof getPendingQuestionSchema>;
