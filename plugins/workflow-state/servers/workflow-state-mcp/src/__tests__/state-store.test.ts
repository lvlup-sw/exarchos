import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../state-store.js';
import { ErrorCode } from '../schemas.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-state-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('State Store', () => {
  describe('InitStateFile_FeatureWorkflow_CreatesV1_1Schema', () => {
    it('should create a valid feature workflow state file', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'my-feature', 'feature');

      expect(stateFile).toBe(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.version).toBe('1.1');
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');
      expect(state.artifacts).toEqual({ design: null, plan: null, pr: null });
      expect(state.tasks).toEqual([]);
      expect(state.worktrees).toEqual({});
      expect(state.julesSessions).toEqual({});
      expect(state.reviews).toEqual({});
      expect(state.synthesis).toEqual({
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      });
      expect(state._history).toEqual({});
      expect(state._events).toEqual([]);
      expect(state._eventSequence).toBe(0);
      expect(state._checkpoint).toBeDefined();
      expect(state._checkpoint.phase).toBe('ideate');
      expect(state._checkpoint.summary).toBe('Workflow initialized');

      // Verify file was written to disk
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

      // Modify state and write
      const updatedState = { ...state, updatedAt: new Date().toISOString() };
      await writeStateFile(stateFile, updatedState);

      // Verify the file was written
      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.updatedAt).toBe(updatedState.updatedAt);

      // Verify no leftover temp files
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

      expect(results).toHaveLength(3);
      const featureIds = results.map((r) => r.featureId).sort();
      expect(featureIds).toEqual(['feature-a', 'feature-b', 'feature-c']);

      // Each entry should have stateFile and state
      for (const entry of results) {
        expect(entry.stateFile).toContain('.state.json');
        expect(entry.state).toBeDefined();
        expect(entry.state.featureId).toBe(entry.featureId);
      }
    });

    it('should return empty array for empty directory', async () => {
      const results = await listStateFiles(tmpDir);
      expect(results).toEqual([]);
    });

    it('should ignore non-state files', async () => {
      await initStateFile(tmpDir, 'real-state', 'feature');
      // Write a non-state file
      await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Notes', 'utf-8');

      const results = await listStateFiles(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].featureId).toBe('real-state');
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

    it('should replace arrays, not merge them', () => {
      const obj: Record<string, unknown> = { tags: ['a', 'b'] };
      applyDotPath(obj, 'tags', ['c']);
      expect(obj.tags).toEqual(['c']);
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
  });
});
