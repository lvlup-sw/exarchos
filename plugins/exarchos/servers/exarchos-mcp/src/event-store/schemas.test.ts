import { describe, it, expect } from 'vitest';
import { validateAgentEvent, AGENT_EVENT_TYPES } from './schemas.js';

describe('validateAgentEvent', () => {
  describe('agent event types', () => {
    it('should reject task.claimed when agentId is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', source: 'test' }),
      ).toThrow();
    });

    it('should reject task.claimed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should reject agent.message when agentId and source are both missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'agent.message' }),
      ).toThrow();
    });

    it('should reject agent.handoff when agentId is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'agent.handoff', source: 'test' }),
      ).toThrow();
    });

    it('should reject task.progressed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should pass task.claimed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });

    it('should pass agent.message when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'agent.message', agentId: 'agent-1', source: 'orchestrator' }),
      ).toBe(true);
    });

    it('should pass agent.handoff when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'agent.handoff', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });

    it('should pass task.progressed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });
  });

  describe('system event types', () => {
    it('should pass workflow.started without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.started' }),
      ).toBe(true);
    });

    it('should pass phase.transitioned without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'phase.transitioned' }),
      ).toBe(true);
    });

    it('should pass task.assigned without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'task.assigned' }),
      ).toBe(true);
    });

    it('should pass team.formed without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'team.formed' }),
      ).toBe(true);
    });
  });

  describe('AGENT_EVENT_TYPES constant', () => {
    it('should contain exactly the four agent event types', () => {
      expect(AGENT_EVENT_TYPES).toEqual([
        'task.claimed',
        'task.progressed',
        'agent.message',
        'agent.handoff',
      ]);
    });
  });
});
