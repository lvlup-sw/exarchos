/**
 * Characterization of the stored liveness pairs. The launcher, the local merge action, the mutation
 * gate and the prune action are retired, so no code emits their pairs. A stored pair of each still
 * parses with the exported Zod schemas and still pairs by its `instanceId`. A launch pair keys on its
 * `worktreeId`. A merge pair keys on `taskId`, or on `<sourceBranch>→<targetBranch>` with no `taskId`.
 */

import { describe, it, expect } from 'vitest';

import {
  MergeExecutingStartedData,
  MergeExecutedData,
  LaunchExecutingStartedData,
  LaunchExecutedData,
  MutationExecutingStartedData,
  MutationExecutedData,
  PruneExecutingStartedData,
  PruneExecutedData,
} from '../../../src/events/schemas.js';
import { getLivenessDescriptor } from '../../../src/events/liveness-registry.js';

/** The data of a launch pair that the retired launcher stored. Its instance key is the `worktreeId`. */
const STORED_LAUNCH_START = { worktreeId: '/srv/wt/launch-a', holderPid: 4242, holderStartedAt: 'boot-4242', instanceId: '/srv/wt/launch-a' };
const STORED_LAUNCH_TERMINAL = { worktreeId: '/srv/wt/launch-a', exitCode: 0, instanceId: '/srv/wt/launch-a' };

/** The data of a merge pair with a `taskId`, as the retired `merge_orchestrate` action stored it. */
const STORED_MERGE_START = { taskId: 'T11', sourceBranch: 'feat/x', targetBranch: 'main', recoveryPointSha: 'b'.repeat(40), startedAt: '2026-11-01T00:00:00.000Z', instanceId: 'T11' };
const STORED_MERGE_TERMINAL = { taskId: 'T11', sourceBranch: 'feat/x', targetBranch: 'main', strategy: 'squash', mergeSha: 'a'.repeat(40), rollbackSha: 'b'.repeat(40), instanceId: 'T11' };

/** The data of a merge pair with no `taskId`, so the instance key is the source and target pair. */
const STORED_UNTASKED_MERGE_START = { sourceBranch: 'feat/y', targetBranch: 'integration', recoveryPointSha: 'd'.repeat(40), startedAt: '2026-11-01T00:00:00.000Z', instanceId: 'feat/y→integration' };
const STORED_UNTASKED_MERGE_TERMINAL = { sourceBranch: 'feat/y', targetBranch: 'integration', strategy: 'merge', mergeSha: 'c'.repeat(40), rollbackSha: 'd'.repeat(40), instanceId: 'feat/y→integration' };

/** The data of a mutation pair that the retired gate stored before its retirement. */
const STORED_MUTATION_START = { command: 'npx stryker run', repoRoot: '/repo', operationId: 'op-mutation-run', instanceId: 'op-mutation-run' };
const STORED_MUTATION_TERMINAL = { ...STORED_MUTATION_START, passed: true, exitCode: 0 };

/** The data of a prune pair that the retired `prune_worktrees` action stored before its retirement. */
const STORED_PRUNE_START = { operationId: 'op-prune-pass', repoRoot: '/repo', holderPid: 4242, holderStartedAt: 'boot-4242', instanceId: 'op-prune-pass' };
const STORED_PRUNE_TERMINAL = { operationId: 'op-prune-pass', deletedCount: 0, instanceId: 'op-prune-pass' };

describe('DR-2 liveness emitters', () => {
  /**
   * Launch, merge, mutation and prune: a stored pair parses with its schemas, and the registry pairs it by its `instanceId`.
   * A merge with a `taskId` keys on the `taskId`. With none, it keys on `<source>→<target>`.
   * Prune uses its `operationId` as the instance key, so start and terminal hold the same value.
   */
  it('TheStoredLaunchMergeMutationAndPrunePairs_CarryCanonicalInstanceIdAdditively', () => {
    {
      const { instanceKeyOf } = getLivenessDescriptor('merge');
      const started = MergeExecutingStartedData.parse(STORED_MERGE_START);
      const terminal = MergeExecutedData.parse(STORED_MERGE_TERMINAL);
      expect(started.instanceId).toBe('T11');
      expect(terminal.instanceId).toBe('T11');
      expect(instanceKeyOf(started)).toBe('T11');
      expect(instanceKeyOf(terminal)).toBe('T11');

      const untaskedStarted = MergeExecutingStartedData.parse(STORED_UNTASKED_MERGE_START);
      const untaskedTerminal = MergeExecutedData.parse(STORED_UNTASKED_MERGE_TERMINAL);
      expect(untaskedStarted.instanceId).toBe('feat/y→integration');
      expect(untaskedTerminal.instanceId).toBe('feat/y→integration');
      expect(instanceKeyOf(untaskedStarted)).toBe('feat/y→integration');
      expect(instanceKeyOf(untaskedTerminal)).toBe('feat/y→integration');
    }

    {
      const { instanceKeyOf } = getLivenessDescriptor('launch');
      const started = LaunchExecutingStartedData.parse(STORED_LAUNCH_START);
      const terminal = LaunchExecutedData.parse(STORED_LAUNCH_TERMINAL);
      expect(started.instanceId).toBe('/srv/wt/launch-a');
      expect(terminal.instanceId).toBe('/srv/wt/launch-a');
      expect(instanceKeyOf(started)).toBe('/srv/wt/launch-a');
      expect(instanceKeyOf(terminal)).toBe('/srv/wt/launch-a');
    }

    {
      const started = MutationExecutingStartedData.parse(STORED_MUTATION_START);
      const terminal = MutationExecutedData.parse(STORED_MUTATION_TERMINAL);
      const { instanceKeyOf } = getLivenessDescriptor('mutation');
      expect(started.instanceId).toBe('op-mutation-run');
      expect(terminal.instanceId).toBe('op-mutation-run');
      expect(instanceKeyOf(started)).toBe('op-mutation-run');
      expect(instanceKeyOf(terminal)).toBe('op-mutation-run');
    }

    {
      const started = PruneExecutingStartedData.parse(STORED_PRUNE_START);
      const terminal = PruneExecutedData.parse(STORED_PRUNE_TERMINAL);
      const { instanceKeyOf } = getLivenessDescriptor('prune');
      expect(started.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(terminal.operationId);
      expect(instanceKeyOf(started)).toBe('op-prune-pass');
      expect(instanceKeyOf(terminal)).toBe('op-prune-pass');
    }
  });
});
