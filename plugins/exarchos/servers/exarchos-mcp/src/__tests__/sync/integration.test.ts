import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleEventAppend } from '../../event-store/tools.js';
import { Outbox } from '../../sync/outbox.js';

// Mock fetch for client tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Headers(),
  } as Response;
}

describe('Sync Integration', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'sync-integration-'));
    stateDir = path.join(tempDir, 'state');
    await mkdir(stateDir, { recursive: true });
    mockFetch.mockReset();
    // Clear env vars
    delete process.env.EXARCHOS_API_TOKEN;
    delete process.env.BASILEUS_API_URL;
    delete process.env.EXARCHOS_SYNC_MODE;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.EXARCHOS_API_TOKEN;
    delete process.env.BASILEUS_API_URL;
    delete process.env.EXARCHOS_SYNC_MODE;
  });

  // ─── event_append dual-write ──────────────────────────────────────────

  describe('event_append dual-write', () => {
    it('should write to outbox when sync mode is not local', async () => {
      // Set up bridge-config.json for remote mode
      await writeFile(
        path.join(tempDir, 'bridge-config.json'),
        JSON.stringify({
          mode: 'dual',
          remote: {
            apiBaseUrl: 'https://api.test',
            apiToken: 'test-token',
            exarchosId: 'test',
            timeoutMs: 5000,
          },
        }),
        'utf-8',
      );

      const result = await handleEventAppend(
        {
          stream: 'test-stream',
          event: {
            type: 'workflow.started',
            data: { featureId: 'test', workflowType: 'feature' },
          },
        },
        stateDir,
      );

      expect(result.success).toBe(true);

      // Check outbox has an entry
      const outbox = new Outbox(stateDir);
      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('pending');
      expect(entries[0].event.type).toBe('workflow.started');
    });

    it('should NOT write to outbox when sync mode is local', async () => {
      // No bridge-config, no env vars → default local mode
      const result = await handleEventAppend(
        {
          stream: 'test-stream',
          event: {
            type: 'workflow.started',
            data: { featureId: 'test', workflowType: 'feature' },
          },
        },
        stateDir,
      );

      expect(result.success).toBe(true);

      // Check outbox does NOT have entries
      const outbox = new Outbox(stateDir);
      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(0);
    });
  });
});
