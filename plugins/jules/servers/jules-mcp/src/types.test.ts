import { describe, it, expect } from 'vitest';
import type { Activity, Artifact } from './types.js';

describe('Activity Types', () => {
  it('Activity_WithAgentMessage_HasExpectedStructure', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/1',
      id: '1',
      originator: 'agent',
      description: 'Agent asked a question',
      createTime: '2025-01-04T00:00:00Z',
      agentMessaged: { content: 'What framework should I use?' }
    };

    expect(activity.agentMessaged?.content).toBe('What framework should I use?');
    expect(activity.originator).toBe('agent');
  });

  it('Activity_WithPlanGenerated_HasStepsArray', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/2',
      id: '2',
      originator: 'agent',
      description: 'Plan generated',
      createTime: '2025-01-04T00:00:00Z',
      planGenerated: { steps: ['Step 1', 'Step 2', 'Step 3'] }
    };

    expect(activity.planGenerated?.steps).toHaveLength(3);
  });

  it('Artifact_ChangeSet_HasPatchFields', () => {
    const artifact: Artifact = {
      type: 'changeset',
      baseCommitId: 'abc123',
      unidiffPatch: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      suggestedCommitMessage: 'Update file.ts'
    };

    expect(artifact.type).toBe('changeset');
    expect(artifact.unidiffPatch).toContain('--- a/file.ts');
  });
});
