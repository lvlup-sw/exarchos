import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleGet,
  handleInit,
  handleSet,
  configureWorkflowEventStore,
  configureWorkflowMaterializer,
} from './tools.js';

describe('handleGet playbook field', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'playbook-test-'));
  });

  afterEach(async () => {
    configureWorkflowEventStore(null);
    configureWorkflowMaterializer(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleGet_PlaybookField_ReturnsPhasePlaybook', async () => {
    // Arrange: create feature workflow (starts in 'ideate' phase)
    const initResult = await handleInit({ featureId: 'test-feature', workflowType: 'feature' }, tmpDir);
    expect(initResult.success).toBe(true);
    // Transition to delegate (ideate -> plan -> plan-review -> delegate)
    const toPlan = await handleSet(
      { featureId: 'test-feature', updates: { 'artifacts.design': 'docs/design.md' }, phase: 'plan' },
      tmpDir,
    );
    expect(toPlan.success).toBe(true);
    const toPlanReview = await handleSet(
      { featureId: 'test-feature', updates: { 'artifacts.plan': 'docs/plan.md' }, phase: 'plan-review' },
      tmpDir,
    );
    expect(toPlanReview.success).toBe(true);
    const toDelegate = await handleSet(
      { featureId: 'test-feature', updates: { 'planReview.approved': true }, phase: 'delegate' },
      tmpDir,
    );
    expect(toDelegate.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-feature', fields: ['playbook'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('playbook');
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('delegate');
    expect((playbook as Record<string, unknown>).skill).toBe('delegation');
  });

  it('handleGet_PlaybookField_ReturnsPlaybookForInitialPhase', async () => {
    // Arrange: create feature workflow (starts in 'ideate' phase)
    const initResult = await handleInit({ featureId: 'test-ideate', workflowType: 'feature' }, tmpDir);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-ideate', fields: ['playbook'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('ideate');
    expect((playbook as Record<string, unknown>).skill).toBe('brainstorming');
    expect((playbook as Record<string, unknown>).workflowType).toBe('feature');
  });

  it('handleGet_PlaybookWithOtherFields_ReturnsBoth', async () => {
    // Arrange
    const initResult = await handleInit({ featureId: 'test-both', workflowType: 'feature' }, tmpDir);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-both', fields: ['playbook', 'phase'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('playbook');
    expect(data).toHaveProperty('phase');
    expect(data.phase).toBe('ideate');
    const playbook = data.playbook as Record<string, unknown>;
    expect(playbook.phase).toBe('ideate');
  });

  it('handleGet_PlaybookField_WorksForDebugWorkflow', async () => {
    // Arrange: create debug workflow (starts in 'triage' phase)
    const initResult = await handleInit({ featureId: 'test-debug', workflowType: 'debug' }, tmpDir);
    expect(initResult.success).toBe(true);

    // Act
    const result = await handleGet(
      { featureId: 'test-debug', fields: ['playbook'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const playbook = (result.data as Record<string, unknown>).playbook;
    expect(playbook).not.toBeNull();
    expect((playbook as Record<string, unknown>).phase).toBe('triage');
    expect((playbook as Record<string, unknown>).skill).toBe('debug');
  });
});
