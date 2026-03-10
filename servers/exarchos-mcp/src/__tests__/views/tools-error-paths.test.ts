import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  handleViewShepherdStatus,
  handleViewConvergence,
  handleViewIdeateReadiness,
  handleViewProvenance,
  resetMaterializerCache,
} from '../../views/tools.js';
import { handleView } from '../../views/composite.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'view-error-paths-'));
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('views/tools.ts composite error paths', () => {
  // ─── T-12.1: ShepherdStatus — queryDeltaEvents throws non-Error ───────────

  describe('HandleViewShepherdStatus_QueryThrowsNonError_ReturnsViewError', () => {
    it('should return VIEW_ERROR when queryDeltaEvents throws a string error', async () => {
      // The handler internally calls getOrCreateEventStore which creates an
      // EventStore. We can make the EventStore.query throw by providing
      // an invalid streamId with uppercase characters, which fails assertSafeId.
      // But a simpler approach: mock the module function.
      //
      // For a non-Error throw, we mock the EventStore.query to throw a string.
      const storeModule = await import('../../event-store/store.js');
      vi.spyOn(storeModule.EventStore.prototype, 'query').mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error from query';
      });

      const result = await handleViewShepherdStatus({}, tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('VIEW_ERROR');
      // Non-Error objects are stringified via String()
      expect(result.error!.message).toBe('string error from query');
    });
  });

  // ─── T-12.2: Convergence — queryDeltaEvents throws Error ──────────────────

  describe('HandleViewConvergence_QueryThrowsError_ReturnsViewError', () => {
    it('should return VIEW_ERROR when queryDeltaEvents throws an Error', async () => {
      const storeModule = await import('../../event-store/store.js');
      vi.spyOn(storeModule.EventStore.prototype, 'query').mockImplementation(() => {
        throw new Error('connection lost');
      });

      const result = await handleViewConvergence({}, tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('VIEW_ERROR');
      expect(result.error!.message).toBe('connection lost');
    });
  });

  // ─── T-12.3: IdeateReadiness — queryDeltaEvents throws non-Error ─────────

  describe('HandleViewIdeateReadiness_QueryThrowsNonError_ReturnsViewError', () => {
    it('should return VIEW_ERROR when queryDeltaEvents throws a non-Error', async () => {
      const storeModule = await import('../../event-store/store.js');
      vi.spyOn(storeModule.EventStore.prototype, 'query').mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw 42; // non-Error, non-string throwable
      });

      const result = await handleViewIdeateReadiness({}, tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('VIEW_ERROR');
      expect(result.error!.message).toBe('42');
    });
  });

  // ─── T-12.4: Provenance — queryDeltaEvents throws Error ───────────────────

  describe('HandleViewProvenance_QueryThrowsError_ReturnsViewError', () => {
    it('should return VIEW_ERROR when queryDeltaEvents throws an Error', async () => {
      const storeModule = await import('../../event-store/store.js');
      vi.spyOn(storeModule.EventStore.prototype, 'query').mockImplementation(() => {
        throw new Error('provenance query failed');
      });

      const result = await handleViewProvenance({}, tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('VIEW_ERROR');
      expect(result.error!.message).toBe('provenance query failed');
    });
  });

  // ─── T-12.5: Unknown action returns UNKNOWN_ACTION ────────────────────────

  describe('HandleViewAction_UnknownAction_ReturnsUnknownAction', () => {
    it('should return UNKNOWN_ACTION for an unrecognized action string', async () => {
      const result = await handleView(
        { action: 'nonexistent_view_action' },
        tempDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNKNOWN_ACTION');
      expect(result.error!.message).toContain('nonexistent_view_action');
    });
  });
});
