import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleSubagentStop } from './subagent-stop.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('subagent-stop', () => {
  let originalFeatureId: string | undefined;
  let originalTaskId: string | undefined;

  beforeEach(() => {
    originalFeatureId = process.env.EXARCHOS_FEATURE_ID;
    originalTaskId = process.env.EXARCHOS_TASK_ID;
  });

  afterEach(() => {
    if (originalFeatureId !== undefined) {
      process.env.EXARCHOS_FEATURE_ID = originalFeatureId;
    } else {
      delete process.env.EXARCHOS_FEATURE_ID;
    }
    if (originalTaskId !== undefined) {
      process.env.EXARCHOS_TASK_ID = originalTaskId;
    } else {
      delete process.env.EXARCHOS_TASK_ID;
    }
  });

  it('HandleSubagentStop_ValidInput_ReturnsAgentContext', async () => {
    // Arrange
    process.env.EXARCHOS_FEATURE_ID = 'my-feature';
    process.env.EXARCHOS_TASK_ID = 'task-001';

    const stdinData = {
      agent_type: 'exarchos-implementer',
      agent_id: 'agent-abc-123',
      exit_reason: 'complete',
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert
    expect(result).toHaveProperty('agentId', 'agent-abc-123');
    expect(result).toHaveProperty('exitReason', 'complete');
    expect(result).toHaveProperty('featureId', 'my-feature');
    expect(result).toHaveProperty('taskId', 'task-001');
    expect(result.error).toBeUndefined();
  });

  it('HandleSubagentStop_NonExarchosAgent_ReturnsNoOp', async () => {
    // Arrange
    const stdinData = {
      agent_type: 'some-other-agent',
      agent_id: 'agent-xyz-789',
      exit_reason: 'complete',
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert — should return a no-op result (continue: true, no agentId/exitReason)
    expect(result).toHaveProperty('continue', true);
    expect(result).not.toHaveProperty('agentId');
    expect(result).not.toHaveProperty('exitReason');
    expect(result.error).toBeUndefined();
  });

  it('HandleSubagentStop_MissingAgentId_ReturnsError', async () => {
    // Arrange
    const stdinData = {
      agent_type: 'exarchos-implementer',
      // agent_id is missing
      exit_reason: 'complete',
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert
    expect(result).toHaveProperty('error');
    expect(result.error).toHaveProperty('code', 'MISSING_AGENT_ID');
    expect(result.error).toHaveProperty('message');
  });

  it('HandleSubagentStop_MissingExitReason_ReturnsError', async () => {
    // Arrange
    const stdinData = {
      agent_type: 'exarchos-fixer',
      agent_id: 'agent-abc-123',
      // exit_reason is missing
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert
    expect(result).toHaveProperty('error');
    expect(result.error).toHaveProperty('code', 'MISSING_EXIT_REASON');
    expect(result.error).toHaveProperty('message');
  });

  it('HandleSubagentStop_NoContext_ReturnsAgentInfoOnly', async () => {
    // Arrange — no env vars set for feature/task context
    delete process.env.EXARCHOS_FEATURE_ID;
    delete process.env.EXARCHOS_TASK_ID;

    const stdinData = {
      agent_type: 'exarchos-implementer',
      agent_id: 'agent-abc-123',
      exit_reason: 'error',
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert — should still return agentId and exitReason, but no featureId/taskId
    expect(result).toHaveProperty('agentId', 'agent-abc-123');
    expect(result).toHaveProperty('exitReason', 'error');
    expect(result).not.toHaveProperty('featureId');
    expect(result).not.toHaveProperty('taskId');
    expect(result.error).toBeUndefined();
  });

  it('HandleSubagentStop_ExarchosFixerAgent_ReturnsAgentContext', async () => {
    // Arrange — verify prefix matching works for different exarchos agent types
    process.env.EXARCHOS_FEATURE_ID = 'fix-feature';
    process.env.EXARCHOS_TASK_ID = 'task-fix-001';

    const stdinData = {
      agent_type: 'exarchos-fixer',
      agent_id: 'agent-fixer-456',
      exit_reason: 'max_turns',
    };

    // Act
    const result = await handleSubagentStop(stdinData);

    // Assert
    expect(result).toHaveProperty('agentId', 'agent-fixer-456');
    expect(result).toHaveProperty('exitReason', 'max_turns');
    expect(result).toHaveProperty('featureId', 'fix-feature');
    expect(result).toHaveProperty('taskId', 'task-fix-001');
  });
});
