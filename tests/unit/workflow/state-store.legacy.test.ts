import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The hoisted switch for the `fs.link` mock in the crash-safety tests. */
const linkMockConfig = vi.hoisted(() => ({
  shouldFail: false,
  error: null as Error | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (linkMockConfig.shouldFail && linkMockConfig.error) {
        throw linkMockConfig.error;
      }
      return actual.link(...args);
    },
  };
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initStateFile,
  readStateFile,
  writeStateFile,
  applyDotPath,
  listStateFiles,
  resolveStateDir,
  reconcileFromEvents,
  StateStoreError,
  VersionConflictError,
} from '../../../src/workflow/state-store.js';
import { ErrorCode } from '../../../src/workflow/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-state-test-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('State Store', () => {
  describe('InitStateFile_FeatureWorkflow_CreatesV1_1Schema', () => {
    it('should create a valid feature workflow state file', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'my-feature', 'feature');

      expect(stateFile).toBe(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.version).toBe('1.1');
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('plan');
      expect(state.artifacts).toEqual({ design: null, plan: null, pr: null });
      expect(state.tasks).toEqual([]);
      expect(state.worktrees).toEqual({});
      expect(state.reviews).toEqual({});
      expect(state.synthesis).toEqual({
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      });
      expect(state._history).toEqual({});
      expect(state._checkpoint).toBeDefined();
      expect(state._checkpoint.phase).toBe('plan');
      expect(state._checkpoint.summary).toBe('Workflow initialized');

      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.featureId).toBe('my-feature');
    });

    it('should create a debug workflow state starting at triage phase', async () => {
      const { state } = await initStateFile(tmpDir, 'bug-fix', 'debug');

      expect(state.workflowType).toBe('debug');
      expect(state.phase).toBe('triage');
    });

    it('should create a refactor workflow state starting at explore phase', async () => {
      const { state } = await initStateFile(tmpDir, 'cleanup', 'refactor');

      expect(state.workflowType).toBe('refactor');
      expect(state.phase).toBe('explore');
    });

    it('should throw STATE_ALREADY_EXISTS if state file already exists', async () => {
      await initStateFile(tmpDir, 'existing-feature', 'feature');

      await expect(
        initStateFile(tmpDir, 'existing-feature', 'feature')
      ).rejects.toThrow(ErrorCode.STATE_ALREADY_EXISTS);
    });
  });

  describe('InitStateFile_RefactorWorkflow_IncludesExploreField', () => {
    it('should include explore: {} in refactor workflow initial state', async () => {
      const { state } = await initStateFile(tmpDir, 'refactor-explore', 'refactor');

      const stateRecord = state as unknown as Record<string, unknown>;
      expect(stateRecord.explore).toBeDefined();
      expect(stateRecord.explore).toEqual({});
    });

    it('should include explore: {} in feature workflow initial state', async () => {
      const { state } = await initStateFile(tmpDir, 'feature-explore', 'feature');

      const stateRecord = state as unknown as Record<string, unknown>;
      expect(stateRecord.explore).toBeDefined();
      expect(stateRecord.explore).toEqual({});
    });

    it('should include explore: {} in debug workflow initial state', async () => {
      const { state } = await initStateFile(tmpDir, 'debug-explore', 'debug');

      const stateRecord = state as unknown as Record<string, unknown>;
      expect(stateRecord.explore).toBeDefined();
      expect(stateRecord.explore).toEqual({});
    });
  });

  describe('HandleSet_ExploreScope_ThenTransitionToBrief_Succeeds', () => {
    it('should allow setting explore.scopeAssessment on initialized refactor state', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'refactor-scope', 'refactor');

      const stateRecord = state as unknown as Record<string, unknown>;
      applyDotPath(stateRecord, 'explore.scopeAssessment', 'Files assessed: 5 modules');

      const explore = stateRecord.explore as Record<string, unknown>;
      expect(explore.scopeAssessment).toBe('Files assessed: 5 modules');

      await writeStateFile(stateFile, state);
      const reloaded = await readStateFile(stateFile);
      const reloadedRecord = reloaded as unknown as Record<string, unknown>;
      const reloadedExplore = reloadedRecord.explore as Record<string, unknown>;
      expect(reloadedExplore.scopeAssessment).toBe('Files assessed: 5 modules');
    });
  });

  describe('ReadStateFile_ValidJSON_ParsesAndValidates', () => {
    it('should read and validate a state file from disk', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'read-test', 'feature');
      const state = await readStateFile(stateFile);

      expect(state.featureId).toBe('read-test');
      expect(state.version).toBe('1.1');
      expect(state.workflowType).toBe('feature');
    });
  });

  describe('WriteStateFile_AtomicRename_TempThenRename', () => {
    it('should write state file atomically using tmp-then-rename', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'atomic-test', 'feature');

      const updatedState = { ...state, updatedAt: new Date().toISOString() };
      await writeStateFile(stateFile, updatedState);

      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.updatedAt).toBe(updatedState.updatedAt);

      const files = await fs.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('ReadStateFile_CorruptJSON_ReturnsStateCorruptError', () => {
    it('should throw STATE_CORRUPT for invalid JSON', async () => {
      const stateFile = path.join(tmpDir, 'corrupt.state.json');
      await fs.writeFile(stateFile, 'not valid json{{{', 'utf-8');

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_CORRUPT);
    });

    it('should throw STATE_NOT_FOUND for missing file', async () => {
      const stateFile = path.join(tmpDir, 'missing.state.json');

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_NOT_FOUND);
    });
  });

  describe('ApplyDotPath_NestedPath_UpdatesCorrectField', () => {
    it('should update a nested field using dot notation', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };

      applyDotPath(obj, 'artifacts.design', 'docs/design.md');

      expect((obj.artifacts as Record<string, unknown>).design).toBe('docs/design.md');
    });

    it('should create intermediate objects if they do not exist', () => {
      const obj: Record<string, unknown> = {};

      applyDotPath(obj, 'deep.nested.field', 'value');

      expect(
        ((obj.deep as Record<string, unknown>).nested as Record<string, unknown>).field
      ).toBe('value');
    });
  });

  describe('ApplyDotPath_ArrayAccess_UpdatesArrayElement', () => {
    it('should update an array element using bracket notation', () => {
      const obj: Record<string, unknown> = {
        tasks: [
          { id: 'task-1', status: 'pending' },
          { id: 'task-2', status: 'pending' },
        ],
      };

      applyDotPath(obj, 'tasks[1].status', 'complete');

      expect(
        ((obj.tasks as Array<Record<string, unknown>>)[1]).status
      ).toBe('complete');
    });

    it('should handle array at root level', () => {
      const obj: Record<string, unknown> = {
        items: ['a', 'b', 'c'],
      };

      applyDotPath(obj, 'items[0]', 'z');

      expect((obj.items as string[])[0]).toBe('z');
    });
  });

  describe('ApplyDotPath_ReservedField_ReturnsReservedFieldError', () => {
    it('should throw RESERVED_FIELD for paths starting with underscore', () => {
      const obj: Record<string, unknown> = {};

      expect(() => applyDotPath(obj, '_events', [])).toThrow(ErrorCode.RESERVED_FIELD);
    });

    it('should throw RESERVED_FIELD for nested paths with underscore segment', () => {
      const obj: Record<string, unknown> = {
        nested: {},
      };

      expect(() => applyDotPath(obj, 'nested._internal', 'value')).toThrow(
        ErrorCode.RESERVED_FIELD
      );
    });
  });

  describe('ListStateFiles_MultipleWorkflows_ReturnsActiveOnly', () => {
    it('should list all state files in the state directory', async () => {
      await initStateFile(tmpDir, 'feature-a', 'feature');
      await initStateFile(tmpDir, 'feature-b', 'debug');
      await initStateFile(tmpDir, 'feature-c', 'refactor');

      const results = await listStateFiles(tmpDir);

      expect(results.valid).toHaveLength(3);
      const featureIds = results.valid.map((r) => r.featureId).sort();
      expect(featureIds).toEqual(['feature-a', 'feature-b', 'feature-c']);

      for (const entry of results.valid) {
        expect(entry.stateFile).toContain('.state.json');
        expect(entry.state).toBeDefined();
        expect(entry.state.featureId).toBe(entry.featureId);
      }
      expect(results.corrupt).toHaveLength(0);
    });

    it('should return empty array for empty directory', async () => {
      const results = await listStateFiles(tmpDir);
      expect(results.valid).toEqual([]);
      expect(results.corrupt).toEqual([]);
    });

    it('should ignore non-state files', async () => {
      await initStateFile(tmpDir, 'real-state', 'feature');
      await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Notes', 'utf-8');

      const results = await listStateFiles(tmpDir);
      expect(results.valid).toHaveLength(1);
      expect(results.valid[0].featureId).toBe('real-state');
    });
  });

  describe('resolveStateDir', () => {
    it('should use WORKFLOW_STATE_DIR env var when set', () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      try {
        process.env.WORKFLOW_STATE_DIR = '/tmp/custom-state-dir';
        const dir = resolveStateDir();
        expect(dir).toBe('/tmp/custom-state-dir');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKFLOW_STATE_DIR;
        } else {
          process.env.WORKFLOW_STATE_DIR = originalEnv;
        }
      }
    });
  });

  describe('ApplyDotPath_ObjectUpdate_DeepMerges', () => {
    it('should deep-merge when both existing and new values are plain objects', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };
      applyDotPath(obj, 'artifacts', { design: 'docs/design.md' });
      expect(obj.artifacts).toEqual({ design: 'docs/design.md', plan: null, pr: null });
    });

    it('should deep-merge nested objects preserving siblings', () => {
      const obj: Record<string, unknown> = {
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
      };
      applyDotPath(obj, 'synthesis', { prUrl: 'https://github.com/pr/1' });
      expect((obj.synthesis as Record<string, unknown>).prUrl).toBe('https://github.com/pr/1');
      expect((obj.synthesis as Record<string, unknown>).mergeOrder).toEqual([]);
      expect((obj.synthesis as Record<string, unknown>).integrationBranch).toBeNull();
    });

    it('should replace when new value is not a plain object', () => {
      const obj: Record<string, unknown> = { name: 'old' };
      applyDotPath(obj, 'name', 'new');
      expect(obj.name).toBe('new');
    });

    it('should replace when existing value is not a plain object', () => {
      const obj: Record<string, unknown> = { count: 5 };
      applyDotPath(obj, 'count', { nested: true });
      expect(obj.count).toEqual({ nested: true });
    });

    it('should replace arrays of primitives, not merge them', () => {
      const obj: Record<string, unknown> = { tags: ['a', 'b'] };
      applyDotPath(obj, 'tags', ['c']);
      expect(obj.tags).toEqual(['c']);
    });

    it('should replace arrays of objects by id field entirely (#1003)', () => {
      const obj: Record<string, unknown> = {
        tasks: [
          { id: '1', status: 'complete', title: 'Task 1' },
          { id: '2', status: 'complete', title: 'Task 2' },
          { id: '3', status: 'in-progress', title: 'Task 3' },
        ],
      };
      applyDotPath(obj, 'tasks', [{ id: '3', status: 'complete' }]);
      const tasks = obj.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({ id: '3', status: 'complete' });
    });

    it('should replace arrays when incoming has different ids (#1003)', () => {
      const obj: Record<string, unknown> = {
        tasks: [{ id: '1', status: 'complete' }],
      };
      applyDotPath(obj, 'tasks', [{ id: '2', status: 'pending' }]);
      const tasks = obj.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({ id: '2', status: 'pending' });
    });

    it('should replace arrays when incoming has no id fields', () => {
      const obj: Record<string, unknown> = {
        items: [{ id: '1', name: 'A' }],
      };
      applyDotPath(obj, 'items', [{ name: 'B' }, { name: 'C' }]);
      expect(obj.items).toEqual([{ name: 'B' }, { name: 'C' }]);
    });

    it('should still work with dot-path notation for nested values', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };
      applyDotPath(obj, 'artifacts.design', 'docs/design.md');
      expect(obj.artifacts).toEqual({ design: 'docs/design.md', plan: null, pr: null });
    });

    it('should handle deep-merge with nested objects recursively', () => {
      const obj: Record<string, unknown> = {
        explore: {
          startedAt: '2025-01-15T10:00:00Z',
          completedAt: null,
          scopeAssessment: { filesAffected: 5, testCoverage: 'good' },
        },
      };
      applyDotPath(obj, 'explore', { completedAt: '2025-01-15T11:00:00Z' });
      const explore = obj.explore as Record<string, unknown>;
      expect(explore.startedAt).toBe('2025-01-15T10:00:00Z');
      expect(explore.completedAt).toBe('2025-01-15T11:00:00Z');
      expect(explore.scopeAssessment).toEqual({ filesAffected: 5, testCoverage: 'good' });
    });

    it('should replace when existing value is null', () => {
      const obj: Record<string, unknown> = { integration: null };
      applyDotPath(obj, 'integration', { passed: true });
      expect(obj.integration).toEqual({ passed: true });
    });

    it('should recursively merge at multiple nesting levels', () => {
      const obj: Record<string, unknown> = {
        explore: {
          scopeAssessment: { filesAffected: 5, testCoverage: 'good' },
          startedAt: '2025-01-15T10:00:00Z',
        },
      };
      applyDotPath(obj, 'explore', {
        scopeAssessment: { testCoverage: 'excellent', riskLevel: 'low' },
      });
      const explore = obj.explore as Record<string, unknown>;
      const scope = explore.scopeAssessment as Record<string, unknown>;
      expect(scope.filesAffected).toBe(5);
      expect(scope.testCoverage).toBe('excellent');
      expect(scope.riskLevel).toBe('low');
      expect(explore.startedAt).toBe('2025-01-15T10:00:00Z');
    });
  });

  describe('listStateFiles_CorruptFile_SkipsAndReturnValid', () => {
    it('should skip corrupt state files and return only valid ones', async () => {
      await initStateFile(tmpDir, 'valid-feature', 'feature');
      await fs.writeFile(
        path.join(tmpDir, 'corrupt.state.json'),
        'invalid json{{{',
        'utf-8',
      );

      const results = await listStateFiles(tmpDir);
      expect(results.valid).toHaveLength(1);
      expect(results.valid[0].featureId).toBe('valid-feature');
      expect(results.corrupt).toHaveLength(1);
      expect(results.corrupt[0].featureId).toBe('corrupt');
    });

    it('should return empty valid array when all state files are corrupt', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'bad1.state.json'),
        '{not valid}}}',
        'utf-8',
      );
      await fs.writeFile(
        path.join(tmpDir, 'bad2.state.json'),
        '',
        'utf-8',
      );

      const results = await listStateFiles(tmpDir);
      expect(results.valid).toHaveLength(0);
      expect(results.corrupt).toHaveLength(2);
    });
  });

  describe('listStateFiles_ENOENT_ReturnsEmptyArray', () => {
    it('should return empty arrays when directory does not exist', async () => {
      const nonExistentDir = path.join(tmpDir, 'does-not-exist');

      const results = await listStateFiles(nonExistentDir);
      expect(results.valid).toEqual([]);
      expect(results.corrupt).toEqual([]);
    });
  });

  describe('listStateFiles_NonENOENTError_ThrowsStateStoreError', () => {
    /** `readdir` on a regular file fails with `ENOTDIR`, which is not `ENOENT`. */
    it('should throw StateStoreError with FILE_IO_ERROR for non-ENOENT readdir errors', async () => {
      const filePath = path.join(tmpDir, 'not-a-directory');
      await fs.writeFile(filePath, 'just a file', 'utf-8');

      await expect(listStateFiles(filePath)).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
      try {
        await listStateFiles(filePath);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
      }
    });
  });

  describe('listStateFiles_CorruptFileReporting', () => {
    it('ListStateFiles_CorruptFile_ReportsInCorruptArray', async () => {
      await initStateFile(tmpDir, 'valid-feature', 'feature');
      await fs.writeFile(
        path.join(tmpDir, 'corrupt.state.json'),
        'invalid json{{{',
        'utf-8',
      );

      const result = await listStateFiles(tmpDir);
      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].featureId).toBe('valid-feature');
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].featureId).toBe('corrupt');
      expect(result.corrupt[0].stateFile).toContain('corrupt.state.json');
      expect(result.corrupt[0].error).toBeTruthy();
    });

    it('ListStateFiles_MixedFiles_SeparatesValidAndCorrupt', async () => {
      await initStateFile(tmpDir, 'good-one', 'feature');
      await initStateFile(tmpDir, 'good-two', 'debug');
      await fs.writeFile(
        path.join(tmpDir, 'bad.state.json'),
        '{not valid}}}',
        'utf-8',
      );

      const result = await listStateFiles(tmpDir);
      expect(result.valid).toHaveLength(2);
      expect(result.corrupt).toHaveLength(1);
      expect(result.corrupt[0].featureId).toBe('bad');
    });

    it('ListStateFiles_AllCorrupt_ReturnsEmptyValidNonEmptyCorrupt', async () => {
      await fs.writeFile(path.join(tmpDir, 'bad1.state.json'), '{{{', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'bad2.state.json'), '', 'utf-8');

      const result = await listStateFiles(tmpDir);
      expect(result.valid).toHaveLength(0);
      expect(result.corrupt).toHaveLength(2);
    });
  });

  describe('listStateFiles_OrphanedTempCleanup', () => {
    it('ListStateFiles_OrphanedTmpFromDeadPid_CleansUp', async () => {
      const tmpFile = path.join(tmpDir, 'test.state.json.tmp.999999');
      await fs.writeFile(tmpFile, '{}', 'utf-8');

      await listStateFiles(tmpDir);

      await expect(fs.access(tmpFile)).rejects.toThrow();
    });

    it('ListStateFiles_TmpFromLivePid_Preserved', async () => {
      const tmpFile = path.join(tmpDir, `test.state.json.tmp.${process.pid}`);
      await fs.writeFile(tmpFile, '{}', 'utf-8');

      await listStateFiles(tmpDir);

      await expect(fs.access(tmpFile)).resolves.toBeUndefined();
    });

    it('ListStateFiles_InitTmpFromDeadPid_CleansUp', async () => {
      const tmpFile = path.join(tmpDir, 'test.state.json.init.999999');
      await fs.writeFile(tmpFile, '{}', 'utf-8');

      await listStateFiles(tmpDir);

      await expect(fs.access(tmpFile)).rejects.toThrow();
    });

    it('ListStateFiles_NoTmpFiles_NoError', async () => {
      await initStateFile(tmpDir, 'valid-feature', 'feature');

      const result = await listStateFiles(tmpDir);
      expect(result.valid).toHaveLength(1);
    });
  });

  describe('resolveStateDir_NoEnv_FallsToDefault', () => {
    it('should fall back to ~/.exarchos/state when no env vars are set', () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      const originalPlugin = process.env.CLAUDE_PLUGIN_ROOT;
      const originalExPlugin = process.env.EXARCHOS_PLUGIN_ROOT;
      const originalXdg = process.env.XDG_STATE_HOME;
      delete process.env.WORKFLOW_STATE_DIR;
      delete process.env.CLAUDE_PLUGIN_ROOT;
      delete process.env.EXARCHOS_PLUGIN_ROOT;
      delete process.env.XDG_STATE_HOME;

      try {
        const dir = resolveStateDir();
        expect(dir).toMatch(/\.exarchos[/\\]state$/);
      } finally {
        if (originalEnv !== undefined) process.env.WORKFLOW_STATE_DIR = originalEnv;
        else delete process.env.WORKFLOW_STATE_DIR;
        if (originalPlugin !== undefined) process.env.CLAUDE_PLUGIN_ROOT = originalPlugin;
        else delete process.env.CLAUDE_PLUGIN_ROOT;
        if (originalExPlugin !== undefined) process.env.EXARCHOS_PLUGIN_ROOT = originalExPlugin;
        else delete process.env.EXARCHOS_PLUGIN_ROOT;
        if (originalXdg !== undefined) process.env.XDG_STATE_HOME = originalXdg;
        else delete process.env.XDG_STATE_HOME;
      }
    });
  });

  describe('writeStateFile_WritetimeValidation_RejectsInvalidState', () => {
    it('should reject state with invalid worktree (neither taskId nor tasks)', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'validate-test', 'feature');
      const mutated = structuredClone(state) as Record<string, unknown>;
      (mutated.worktrees as Record<string, unknown>)['bad-wt'] = {
        branch: 'feat/bad',
        status: 'active',
      };

      await expect(
        writeStateFile(stateFile, mutated as typeof state),
      ).rejects.toThrow(ErrorCode.INVALID_INPUT);
    });
  });

  describe('writeStateFile_FailurePath_ThrowsStateStoreError', () => {
    /** A path under a regular file makes the write fail with `ENOTDIR` or `ENOENT`. */
    it('should throw StateStoreError with FILE_IO_ERROR when writing to an invalid path', async () => {
      const { state } = await initStateFile(tmpDir, 'write-fail-test', 'feature');

      const blocker = path.join(tmpDir, 'blocker');
      await fs.writeFile(blocker, 'I am a file', 'utf-8');
      const invalidStateFile = path.join(blocker, 'nested', 'state.json');

      await expect(writeStateFile(invalidStateFile, state)).rejects.toThrow(
        ErrorCode.FILE_IO_ERROR,
      );
      try {
        await writeStateFile(invalidStateFile, state);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
      }
    });

    /**
     * On Windows, `chmod(0o444)` on a directory does not block file creation for the owner, so the write succeeds.
     * The cleanup after a failure is the same on every platform. Only this way to force the failure is POSIX-specific.
     */
    it.skipIf(process.platform === 'win32')('should not leave temp files behind after write failure', async () => {
      const { state } = await initStateFile(tmpDir, 'cleanup-test', 'feature');

      const readOnlyDir = path.join(tmpDir, 'readonly');
      await fs.mkdir(readOnlyDir);
      const stateFile = path.join(readOnlyDir, 'test.state.json');
      await fs.chmod(readOnlyDir, 0o444);

      try {
        await expect(writeStateFile(stateFile, state)).rejects.toThrow(
          ErrorCode.FILE_IO_ERROR,
        );
      } finally {
        await fs.chmod(readOnlyDir, 0o755);
      }

      const files = await fs.readdir(readOnlyDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('initStateFile_WriteFailsNonEEXIST_ThrowsFileIOError', () => {
    /** POSIX only. A read-only directory makes `writeFile` fail with `EACCES`, not `EEXIST`, but on Windows it does not block the owner. */
    it.skipIf(process.platform === 'win32')('should throw StateStoreError with FILE_IO_ERROR when writeFile fails with non-EEXIST error', async () => {
      const readOnlyDir = path.join(tmpDir, 'readonly-dir');
      await fs.mkdir(readOnlyDir);
      await fs.chmod(readOnlyDir, 0o444);

      try {
        await expect(
          initStateFile(readOnlyDir, 'write-blocked', 'feature'),
        ).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
        try {
          await initStateFile(readOnlyDir, 'write-blocked2', 'feature');
        } catch (err) {
          expect(err).toBeInstanceOf(StateStoreError);
          expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
        }
      } finally {
        await fs.chmod(readOnlyDir, 0o755);
      }
    });
  });

  describe('applyDotPath_ArrayErrorPaths', () => {
    it('should throw INVALID_INPUT when intermediate path expects array but finds object', () => {
      const obj: Record<string, unknown> = {
        data: { notArray: true },
      };

      expect(() => applyDotPath(obj, 'data[0].value', 'test')).toThrow(
        ErrorCode.INVALID_INPUT,
      );
    });

    it('should throw INVALID_INPUT when final path expects array but finds object', () => {
      const obj: Record<string, unknown> = {
        data: { notArray: true },
      };

      expect(() => applyDotPath(obj, 'data[0]', 'test')).toThrow(
        ErrorCode.INVALID_INPUT,
      );
    });

    /** A missing segment becomes an array when the next segment is numeric, and an object when the next segment is a name. */
    it('should create intermediate array when navigating numeric segments', () => {
      const obj: Record<string, unknown> = {};

      applyDotPath(obj, 'tasks[0].name', 'task-1');

      expect(Array.isArray(obj.tasks)).toBe(true);
      expect((obj.tasks as Array<Record<string, unknown>>)[0].name).toBe('task-1');
    });

    /** `parsePath` needs a dot between two brackets, so the path is `matrix[2].[0]`. */
    it('should create intermediate array for undefined array segment via dot notation', () => {
      const obj: Record<string, unknown> = {
        matrix: [[1, 2], [3, 4]],
      };

      applyDotPath(obj, 'matrix[2].[0]', 99);

      expect((obj.matrix as number[][])[2][0]).toBe(99);
    });
  });

  describe('readStateFile_NonENOENTReadError_ThrowsFileIOError', () => {
    /** A read of a directory fails with `EISDIR`, which is not `ENOENT`. */
    it('should throw StateStoreError with FILE_IO_ERROR for non-ENOENT read errors', async () => {
      const dirPath = path.join(tmpDir, 'a-directory');
      await fs.mkdir(dirPath);

      await expect(readStateFile(dirPath)).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
      try {
        await readStateFile(dirPath);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
      }
    });
  });

  describe('readStateFile_MigrationFails_ThrowsStateCorrupt', () => {
    it('should throw STATE_CORRUPT when migration fails due to unknown version', async () => {
      const stateFile = path.join(tmpDir, 'bad-version.state.json');
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          version: '0.1',
          featureId: 'test',
          workflowType: 'feature',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          phase: 'ideate',
          artifacts: { design: null, plan: null, pr: null },
          tasks: [],
          worktrees: {},
          reviews: {},
          synthesis: {
            integrationBranch: null,
            mergeOrder: [],
            mergedBranches: [],
            prUrl: null,
            prFeedback: [],
          },
          _history: {},
          _checkpoint: {
            timestamp: new Date().toISOString(),
            phase: 'ideate',
            summary: '',
            operationsSince: 0,
            fixCycleCount: 0,
            lastActivityTimestamp: new Date().toISOString(),
            staleAfterMinutes: 120,
          },
        }),
        'utf-8',
      );

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_CORRUPT);
      try {
        await readStateFile(stateFile);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.STATE_CORRUPT);
      }
    });

    it('should migrate versionless state by treating missing version as v1.0', async () => {
      const stateFile = path.join(tmpDir, 'no-version.state.json');
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          featureId: 'test',
          workflowType: 'feature',
          createdAt: '2025-01-15T10:00:00Z',
          updatedAt: '2025-01-15T10:30:00Z',
          phase: 'ideate',
          artifacts: { design: null, plan: null, pr: null },
          tasks: [],
          worktrees: {},
          reviews: {},
          synthesis: {
            integrationBranch: null,
            mergeOrder: [],
            mergedBranches: [],
            prUrl: null,
            prFeedback: [],
          },
          _version: 1,
        }),
        'utf-8',
      );

      const result = await readStateFile(stateFile);
      expect(result.version).toBe('1.1');
      expect(result._history).toBeDefined();
      expect(result._checkpoint).toBeDefined();
    });
  });

  describe('writeStateFile_AutoIncrementsVersion', () => {
    it('should initialize state with _version 1 and increment to 2 on write', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-auto-inc', 'feature');

      const state1 = await readStateFile(stateFile);
      expect(state1._version).toBe(1);

      await writeStateFile(stateFile, state1);
      const state2 = await readStateFile(stateFile);
      expect(state2._version).toBe(2);
    });

    it('should increment _version on each successive write', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-multi-inc', 'feature');

      let state = await readStateFile(stateFile);
      expect(state._version).toBe(1);

      for (let i = 2; i <= 4; i++) {
        await writeStateFile(stateFile, state);
        state = await readStateFile(stateFile);
        expect(state._version).toBe(i);
      }
    });
  });

  describe('writeStateFile_WithExpectedVersion_ThrowsOnMismatch', () => {
    it('should throw VersionConflictError when expectedVersion does not match current', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-conflict', 'feature');

      const state = await readStateFile(stateFile);
      await writeStateFile(stateFile, state);

      const staleState = await readStateFile(stateFile);
      await expect(
        writeStateFile(stateFile, staleState, { expectedVersion: 1 }),
      ).rejects.toThrow(VersionConflictError);
    });

    it('should succeed when expectedVersion matches current version', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-match', 'feature');

      const state = await readStateFile(stateFile);
      await expect(
        writeStateFile(stateFile, state, { expectedVersion: 1 }),
      ).resolves.toBeUndefined();

      const updated = await readStateFile(stateFile);
      expect(updated._version).toBe(2);
    });

    it('should include expected and actual versions in error', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-error-info', 'feature');

      const state = await readStateFile(stateFile);
      await writeStateFile(stateFile, state);

      const staleState = await readStateFile(stateFile);
      try {
        await writeStateFile(stateFile, staleState, { expectedVersion: 1 });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        expect((err as Error).message).toContain('expected 1');
        expect((err as Error).message).toContain('actual 2');
      }
    });
  });

  describe('writeStateFile_WithoutExpectedVersion_AlwaysSucceeds', () => {
    it('should succeed regardless of current version when no expectedVersion is given', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-compat', 'feature');

      for (let i = 0; i < 3; i++) {
        const state = await readStateFile(stateFile);
        await writeStateFile(stateFile, state);
      }

      const final = await readStateFile(stateFile);
      expect(final._version).toBe(4);
    });
  });

  describe('writeStateFile_MissingVersionField_DefaultsToOne', () => {
    it('should default _version to 1 when reading a state file without _version', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'cas-legacy', 'feature');

      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw._version;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const loaded = await readStateFile(stateFile);
      expect(loaded._version).toBe(1);
    });

    it('should increment from default 1 to 2 on first write of legacy file', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'cas-legacy-write', 'feature');

      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw._version;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const loaded = await readStateFile(stateFile);
      expect(loaded._version).toBe(1);

      await writeStateFile(stateFile, loaded);
      const updated = await readStateFile(stateFile);
      expect(updated._version).toBe(2);
    });
  });

  describe('VersionConflictError_IsInstanceOfStateStoreError', () => {
    it('should be an instance of StateStoreError with VERSION_CONFLICT code', () => {
      const err = new VersionConflictError(1, 2);
      expect(err).toBeInstanceOf(StateStoreError);
      expect(err).toBeInstanceOf(VersionConflictError);
      expect(err.code).toBe('VERSION_CONFLICT');
      expect(err.name).toBe('VersionConflictError');
    });
  });

  describe('writeStateFile_SkipValidation', () => {
    /** The write skips the Zod parse but still increments `_version`. */
    it('WriteStateFile_SkipValidation_WritesWithoutZodParse', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'skip-val-test', 'feature');

      const updated = { ...state, updatedAt: new Date().toISOString() };
      await writeStateFile(stateFile, updated, { skipValidation: true });

      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.updatedAt).toBe(updated.updatedAt);
      expect(parsed._version).toBe(2);
    });

    it('WriteStateFile_SkipValidation_StillPerformsCAS', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'skip-val-cas', 'feature');

      await writeStateFile(stateFile, state);

      const freshState = await readStateFile(stateFile);

      await expect(
        writeStateFile(stateFile, freshState, { expectedVersion: 1, skipValidation: true }),
      ).rejects.toThrow(VersionConflictError);
    });

    it('WriteStateFile_WithoutSkipValidation_StillValidates', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'no-skip-val', 'feature');
      const mutated = structuredClone(state) as Record<string, unknown>;
      (mutated.worktrees as Record<string, unknown>)['bad-wt'] = {
        branch: 'feat/bad',
        status: 'active',
      };

      await expect(
        writeStateFile(stateFile, mutated as typeof state),
      ).rejects.toThrow(ErrorCode.INVALID_INPUT);
    });
  });

  describe('reconcileFromEvents', () => {
    let eventStore: EventStore;

    beforeEach(() => {
      eventStore = new EventStore(tmpDir);
    });

    it('should rebuild state from events when no state file exists', async () => {
      await eventStore.append('my-feature', {
        type: 'workflow.started',
        data: { featureId: 'my-feature', workflowType: 'feature' },
      });
      await eventStore.append('my-feature', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'my-feature' },
      });

      const result = await reconcileFromEvents(tmpDir, 'my-feature', eventStore);

      expect(result.reconciled).toBe(true);
      expect(result.eventsApplied).toBe(2);

      const stateFile = path.join(tmpDir, 'my-feature.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');
      expect(state.workflowType).toBe('feature');
      expect(state.featureId).toBe('my-feature');
    });

    it('should replay transition events to reach correct phase', async () => {
      await initStateFile(tmpDir, 'replay-test', 'feature');
      await eventStore.append('replay-test', {
        type: 'workflow.started',
        data: { featureId: 'replay-test', workflowType: 'feature' },
      });
      await eventStore.append('replay-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'replay-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'replay-test', eventStore);

      expect(result.reconciled).toBe(true);
      expect(result.eventsApplied).toBe(2);

      const stateFile = path.join(tmpDir, 'replay-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');
    });

    it('should apply checkpoint events', async () => {
      await initStateFile(tmpDir, 'cp-test', 'feature');
      await eventStore.append('cp-test', {
        type: 'workflow.started',
        data: { featureId: 'cp-test', workflowType: 'feature' },
      });
      await eventStore.append('cp-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'cp-test' },
      });
      await eventStore.append('cp-test', {
        type: 'workflow.checkpoint',
        data: { counter: 0, phase: 'plan', featureId: 'cp-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'cp-test', eventStore);

      expect(result.reconciled).toBe(true);
      expect(result.eventsApplied).toBe(3);

      const stateFile = path.join(tmpDir, 'cp-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');
      expect(state._checkpoint.phase).toBe('plan');
    });

    it('should be idempotent — second call with no new events returns unchanged', async () => {
      await eventStore.append('idem-test', {
        type: 'workflow.started',
        data: { featureId: 'idem-test', workflowType: 'feature' },
      });
      await eventStore.append('idem-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'idem-test' },
      });

      const result1 = await reconcileFromEvents(tmpDir, 'idem-test', eventStore);
      expect(result1.reconciled).toBe(true);
      expect(result1.eventsApplied).toBe(2);

      const result2 = await reconcileFromEvents(tmpDir, 'idem-test', eventStore);

      expect(result2.reconciled).toBe(false);
      expect(result2.eventsApplied).toBe(0);

      const stateFile = path.join(tmpDir, 'idem-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');
    });

    it('should preserve event timestamps when creating state from workflow.started', async () => {
      const pastTimestamp = '2024-06-15T10:30:00.000Z';
      await eventStore.append('ts-test', {
        type: 'workflow.started',
        timestamp: pastTimestamp,
        data: { featureId: 'ts-test', workflowType: 'feature' },
      });

      const result = await reconcileFromEvents(tmpDir, 'ts-test', eventStore);

      expect(result.reconciled).toBe(true);
      const stateFile = path.join(tmpDir, 'ts-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.createdAt).toBe(pastTimestamp);
      expect(state.updatedAt).toBe(pastTimestamp);
      expect(state._checkpoint.timestamp).toBe(pastTimestamp);
      expect(state._checkpoint.lastActivityTimestamp).toBe(pastTimestamp);
    });

    /**
     * Reconcile reads the state at `_version` 999 and writes version 1000.
     * The test forces no race, so it shows only that the write increments the version that reconcile read.
     */
    it('should use CAS versioning when writing reconciled state', async () => {
      await eventStore.append('cas-test', {
        type: 'workflow.started',
        data: { featureId: 'cas-test', workflowType: 'feature' },
      });
      await eventStore.append('cas-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'cas-test' },
      });

      await reconcileFromEvents(tmpDir, 'cas-test', eventStore);

      const stateFile = path.join(tmpDir, 'cas-test.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._version).toBe(2);

      raw._version = 999;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      await eventStore.append('cas-test', {
        type: 'workflow.transition',
        data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'cas-test' },
      });

      const result2 = await reconcileFromEvents(tmpDir, 'cas-test', eventStore);
      expect(result2.reconciled).toBe(true);

      const raw2 = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw2._version).toBe(1000);
    });

    it('should use sinceSequence optimization when state has _eventSequence', async () => {
      await initStateFile(tmpDir, 'since-test', 'feature');
      await eventStore.append('since-test', {
        type: 'workflow.started',
        data: { featureId: 'since-test', workflowType: 'feature' },
      });
      await eventStore.append('since-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'since-test' },
      });

      const result1 = await reconcileFromEvents(tmpDir, 'since-test', eventStore);
      expect(result1.eventsApplied).toBe(2);

      await eventStore.append('since-test', {
        type: 'workflow.transition',
        data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'since-test' },
      });

      const querySpy = vi.spyOn(eventStore, 'query');

      const result2 = await reconcileFromEvents(tmpDir, 'since-test', eventStore);

      expect(result2.reconciled).toBe(true);
      expect(result2.eventsApplied).toBe(1);

      expect(querySpy).toHaveBeenCalledWith('since-test', { sinceSequence: 2 });

      const stateFile = path.join(tmpDir, 'since-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('delegate');

      querySpy.mockRestore();
    });

    it('should track _eventSequence on state file', async () => {
      await eventStore.append('seq-test', {
        type: 'workflow.started',
        data: { featureId: 'seq-test', workflowType: 'feature' },
      });
      await eventStore.append('seq-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'seq-test' },
      });
      await eventStore.append('seq-test', {
        type: 'workflow.checkpoint',
        data: { counter: 0, phase: 'plan', featureId: 'seq-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'seq-test', eventStore);
      expect(result.eventsApplied).toBe(3);

      const stateFile = path.join(tmpDir, 'seq-test.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(3);

      const result2 = await reconcileFromEvents(tmpDir, 'seq-test', eventStore);
      expect(result2.eventsApplied).toBe(0);
      expect(result2.reconciled).toBe(false);
    });

    /** The test sets the phase back to `ideate` and keeps `_eventSequence`. Reconcile must take the phase from the last transition in the delta. */
    it('should use event-derived phase when delta contains a transition after state tampering', async () => {
      await initStateFile(tmpDir, 'mismatch-test', 'feature');
      await eventStore.append('mismatch-test', {
        type: 'workflow.started',
        data: { featureId: 'mismatch-test', workflowType: 'feature' },
      });
      await eventStore.append('mismatch-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'mismatch-test' },
      });

      await reconcileFromEvents(tmpDir, 'mismatch-test', eventStore);

      const stateFile = path.join(tmpDir, 'mismatch-test.state.json');
      const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      rawState.phase = 'ideate';
      await fs.writeFile(stateFile, JSON.stringify(rawState, null, 2), 'utf-8');

      await eventStore.append('mismatch-test', {
        type: 'workflow.transition',
        data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'mismatch-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'mismatch-test', eventStore);
      expect(result.reconciled).toBe(true);

      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('delegate');
    });

    it('should not correct phase when state matches last transition', async () => {
      await eventStore.append('match-test', {
        type: 'workflow.started',
        data: { featureId: 'match-test', workflowType: 'feature' },
      });
      await eventStore.append('match-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'match-test' },
      });

      await reconcileFromEvents(tmpDir, 'match-test', eventStore);
      const stateFile = path.join(tmpDir, 'match-test.state.json');
      const state1 = await readStateFile(stateFile);
      expect(state1.phase).toBe('plan');

      await eventStore.append('match-test', {
        type: 'workflow.transition',
        data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'match-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'match-test', eventStore);
      expect(result.reconciled).toBe(true);

      const state2 = await readStateFile(stateFile);
      expect(state2.phase).toBe('delegate');
    });

    /** Reconcile sets the phase from the `to` field of a `workflow.transition` event. */
    it('should set phase from workflow.transition event to field', async () => {
      await initStateFile(tmpDir, 'apply-phase-test', 'feature');

      await eventStore.append('apply-phase-test', {
        type: 'workflow.started',
        data: { featureId: 'apply-phase-test', workflowType: 'feature' },
      });
      await eventStore.append('apply-phase-test', {
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'execute-transition', featureId: 'apply-phase-test' },
      });

      const result = await reconcileFromEvents(tmpDir, 'apply-phase-test', eventStore);
      expect(result.reconciled).toBe(true);

      const stateFile = path.join(tmpDir, 'apply-phase-test.state.json');
      const state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');
    });
  });

  describe('applyDotPath_SparseArrayBounds', () => {
    it('ApplyDotPath_SparseArrayIndex_ThrowsInvalidInput', () => {
      const obj: Record<string, unknown> = { tasks: [] };
      expect(() => applyDotPath(obj, 'tasks[50].name', 'x')).toThrow(ErrorCode.INVALID_INPUT);
    });

    it('ApplyDotPath_AppendIndex_Succeeds', () => {
      const obj: Record<string, unknown> = { tasks: ['a', 'b'] };
      applyDotPath(obj, 'tasks[2]', 'c');
      expect((obj.tasks as string[])[2]).toBe('c');
    });

    /** Index 2 on an array of length 1 is a gap of one, which `MAX_ARRAY_GAP` allows. */
    it('ApplyDotPath_NextGapIndex_Succeeds', () => {
      const obj: Record<string, unknown> = { tasks: ['a'] };
      applyDotPath(obj, 'tasks[2]', 'c');
      expect((obj.tasks as unknown[])[2]).toBe('c');
    });

    /** The missing `items` becomes an empty array, and index 100 is far past its length. */
    it('ApplyDotPath_IntermediateSparseArray_ThrowsInvalidInput', () => {
      const obj: Record<string, unknown> = {};
      expect(() => applyDotPath(obj, 'items[100].name', 'x')).toThrow(ErrorCode.INVALID_INPUT);
    });

    it('ApplyDotPath_FinalSparseIndex_ThrowsInvalidInput', () => {
      const obj: Record<string, unknown> = { items: [1, 2] };
      expect(() => applyDotPath(obj, 'items[50]', 99)).toThrow(ErrorCode.INVALID_INPUT);
    });
  });

  describe('writeStateFile_CASCorruptHandling', () => {
    it('WriteStateFile_CorruptExistingFile_ThrowsStateCorrupt', async () => {
      const stateFile = path.join(tmpDir, 'corrupt.state.json');
      await fs.writeFile(stateFile, 'invalid json{{{', 'utf-8');

      const { state } = await initStateFile(tmpDir, 'test-feature', 'feature');

      await expect(
        writeStateFile(stateFile, state, { expectedVersion: 1 }),
      ).rejects.toThrow(ErrorCode.STATE_CORRUPT);
    });

    /** A missing file counts as version 1 for the CAS check. */
    it('WriteStateFile_MissingFile_CASDefaultsToVersion1', async () => {
      const stateFile = path.join(tmpDir, 'nonexistent.state.json');
      const { state } = await initStateFile(tmpDir, 'test-feature', 'feature');

      await expect(
        writeStateFile(stateFile, state, { expectedVersion: 1 }),
      ).resolves.toBeUndefined();
    });

    it('WriteStateFile_ValidFile_CASSucceeds', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'test-feature', 'feature');

      await expect(
        writeStateFile(stateFile, state, { expectedVersion: 1 }),
      ).resolves.toBeUndefined();
    });

    it('WriteStateFile_ValidFile_CASConflict_ThrowsVersionConflict', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'test-feature', 'feature');

      await expect(
        writeStateFile(stateFile, state, { expectedVersion: 5 }),
      ).rejects.toThrow('VERSION_CONFLICT');
    });
  });

  describe('initStateFile_CrashSafety', () => {
    it('InitStateFile_Success_NoTempFileRemains', async () => {
      await initStateFile(tmpDir, 'test-feature', 'feature');

      const entries = await fs.readdir(tmpDir);
      const initTmpFiles = entries.filter((f) => f.includes('.init.'));
      expect(initTmpFiles).toHaveLength(0);
    });

    it('InitStateFile_ExistingFile_ThrowsAlreadyExists', async () => {
      await initStateFile(tmpDir, 'test-feature', 'feature');

      await expect(
        initStateFile(tmpDir, 'test-feature', 'feature'),
      ).rejects.toThrow(ErrorCode.STATE_ALREADY_EXISTS);
    });

    /** The loser gets `STATE_ALREADY_EXISTS` from the `EEXIST` of `link`. The test also accepts `FILE_IO_ERROR`. */
    it('InitStateFile_ConcurrentInit_OneSucceedsOneFailsEEXIST', async () => {
      const results = await Promise.allSettled([
        initStateFile(tmpDir, 'race-feature', 'feature'),
        initStateFile(tmpDir, 'race-feature', 'feature'),
      ]);

      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const failureReason = (failures[0] as PromiseRejectedResult).reason;
      const msg = failureReason.message;
      expect(
        msg.includes(ErrorCode.STATE_ALREADY_EXISTS) || msg.includes(ErrorCode.FILE_IO_ERROR),
      ).toBe(true);
    });

    /** The `fs.link` mock fails with `ENOSPC`. The init must throw `FILE_IO_ERROR`, remove its temp file, and create no state file. */
    it('InitStateFile_SimulatedCrashBeforeLink_OnlyTempExists', async () => {
      linkMockConfig.shouldFail = true;
      linkMockConfig.error = Object.assign(
        new Error('ENOSPC: no space left on device'),
        { code: 'ENOSPC' },
      );

      try {
        await expect(
          initStateFile(tmpDir, 'crash-test', 'feature'),
        ).rejects.toThrow(ErrorCode.FILE_IO_ERROR);

        const entries = await fs.readdir(tmpDir);
        const initTmpFiles = entries.filter((f) => f.includes('.init.'));
        expect(initTmpFiles).toHaveLength(0);

        const stateFile = path.join(tmpDir, 'crash-test.state.json');
        await expect(fs.access(stateFile)).rejects.toThrow();
      } finally {
        linkMockConfig.shouldFail = false;
        linkMockConfig.error = null;
      }
    });
  });
});
