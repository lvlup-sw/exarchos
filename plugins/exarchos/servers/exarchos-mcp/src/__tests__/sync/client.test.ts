import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BasileusClient, BasileusApiError } from '../../sync/client.js';
import type { RemoteConfig, ExarchosEventDto } from '../../sync/types.js';

// ─── Mock fetch globally ─────────────────────────────────────────────────────

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

describe('BasileusClient', () => {
  const config: RemoteConfig = {
    apiBaseUrl: 'https://api.basileus.test',
    apiToken: 'test-token-123',
    exarchosId: 'exarchos-1',
    timeoutMs: 5000,
  };

  let client: BasileusClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new BasileusClient(config);
  });

  // ─── Constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create instance with config', () => {
      expect(client).toBeInstanceOf(BasileusClient);
    });
  });

  describe('interface methods exist', () => {
    it('should have registerWorkflow method', () => {
      expect(typeof client.registerWorkflow).toBe('function');
    });

    it('should have appendEvents method', () => {
      expect(typeof client.appendEvents).toBe('function');
    });

    it('should have getEventsSince method', () => {
      expect(typeof client.getEventsSince).toBe('function');
    });

    it('should have getPipeline method', () => {
      expect(typeof client.getPipeline).toBe('function');
    });

    it('should have getPendingCommands method', () => {
      expect(typeof client.getPendingCommands).toBe('function');
    });
  });

  // ─── registerWorkflow ───────────────────────────────────────────────────

  describe('registerWorkflow', () => {
    it('should POST to correct URL with auth header', async () => {
      const response = {
        featureId: 'my-feature',
        workflowType: 'feature',
        registeredAt: '2026-02-08T00:00:00Z',
        streamVersion: 0,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      await client.registerWorkflow('my-feature', 'feature');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.basileus.test/api/exarchos/workflows');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer test-token-123');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({
        featureId: 'my-feature',
        workflowType: 'feature',
        exarchosId: 'exarchos-1',
      });
    });

    it('should return parsed response', async () => {
      const response = {
        featureId: 'my-feature',
        workflowType: 'feature',
        registeredAt: '2026-02-08T00:00:00Z',
        streamVersion: 0,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response));

      const result = await client.registerWorkflow('my-feature', 'feature');
      expect(result).toEqual(response);
    });

    it('should throw BasileusApiError on non-2xx', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'conflict' }, 409),
      );

      await expect(
        client.registerWorkflow('my-feature', 'feature'),
      ).rejects.toThrow(BasileusApiError);
    });
  });

  // ─── appendEvents ──────────────────────────────────────────────────────

  describe('appendEvents', () => {
    const events: ExarchosEventDto[] = [
      {
        streamId: 'stream-1',
        sequence: 1,
        timestamp: '2026-02-08T00:00:00Z',
        type: 'workflow.started',
        data: { featureId: 'test' },
      },
    ];

    it('should POST events to correct URL', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ accepted: 1, streamVersion: 1 }),
      );

      await client.appendEvents('stream-1', events);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://api.basileus.test/api/exarchos/streams/stream-1/events',
      );
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer test-token-123');
    });

    it('should include expectedVersion when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ accepted: 1, streamVersion: 1 }),
      );

      await client.appendEvents('stream-1', events, 0);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.expectedVersion).toBe(0);
    });

    it('should return parsed response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ accepted: 1, streamVersion: 1 }),
      );

      const result = await client.appendEvents('stream-1', events);
      expect(result).toEqual({ accepted: 1, streamVersion: 1 });
    });
  });

  // ─── getEventsSince ────────────────────────────────────────────────────

  describe('getEventsSince', () => {
    it('should GET events from correct URL with query param', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getEventsSince('stream-1', 5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://api.basileus.test/api/exarchos/streams/stream-1/events?sinceVersion=5',
      );
      expect(opts.method).toBe('GET');
      expect(opts.headers['Authorization']).toBe('Bearer test-token-123');
    });

    it('should return array of events', async () => {
      const events: ExarchosEventDto[] = [
        {
          streamId: 'stream-1',
          sequence: 6,
          timestamp: '2026-02-08T00:00:00Z',
          type: 'task.completed',
        },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(events));

      const result = await client.getEventsSince('stream-1', 5);
      expect(result).toEqual(events);
    });
  });

  // ─── getPipeline ───────────────────────────────────────────────────────

  describe('getPipeline', () => {
    it('should GET pipeline from correct URL', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ workflows: [] }));

      await client.getPipeline();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.basileus.test/api/exarchos/pipeline');
      expect(opts.method).toBe('GET');
    });
  });

  // ─── getPendingCommands ────────────────────────────────────────────────

  describe('getPendingCommands', () => {
    it('should GET pending commands from correct URL', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await client.getPendingCommands();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://api.basileus.test/api/exarchos/exarchos-1/commands',
      );
      expect(opts.method).toBe('GET');
    });

    it('should return array of commands', async () => {
      const commands = [
        { id: 'cmd-1', type: 'execute', workflowId: 'wf-1' },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse(commands));

      const result = await client.getPendingCommands();
      expect(result).toEqual(commands);
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw BasileusApiError with status and body on non-2xx', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'not found' }, 404),
      );

      try {
        await client.getEventsSince('stream-1', 0);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BasileusApiError);
        const apiErr = err as BasileusApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.body).toEqual({ error: 'not found' });
      }
    });

    it('should include timeout via AbortController', async () => {
      mockFetch.mockImplementationOnce(
        (_url: string, opts: RequestInit) => {
          expect(opts.signal).toBeDefined();
          return Promise.resolve(jsonResponse([]));
        },
      );

      await client.getEventsSince('stream-1', 0);
    });
  });

  // ─── Circuit Breaker ──────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('should open after 5 consecutive failures', async () => {
      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error: 'server error' }, 500),
        );
        try {
          await client.getPipeline();
        } catch {
          // expected
        }
      }

      // 6th call should fail immediately without calling fetch
      mockFetch.mockClear();
      await expect(client.getPipeline()).rejects.toThrow(
        /circuit breaker open/i,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should half-open after cooldown period', async () => {
      // Use a client with short cooldown for testing
      const shortCooldownClient = new BasileusClient(config);

      // Fail 5 times to open circuit
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error: 'server error' }, 500),
        );
        try {
          await shortCooldownClient.getPipeline();
        } catch {
          // expected
        }
      }

      // Advance time past cooldown (60s)
      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);

      // Should attempt the call (half-open)
      mockFetch.mockResolvedValueOnce(jsonResponse({ workflows: [] }));
      const result = await shortCooldownClient.getPipeline();
      expect(result).toEqual({ workflows: [] });

      vi.useRealTimers();
    });

    it('should close circuit after successful call in half-open state', async () => {
      const cbClient = new BasileusClient(config);

      // Fail 5 times to open
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error: 'err' }, 500),
        );
        try {
          await cbClient.getPipeline();
        } catch {
          // expected
        }
      }

      // Advance past cooldown
      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);

      // Successful call closes circuit
      mockFetch.mockResolvedValueOnce(jsonResponse({ workflows: [] }));
      await cbClient.getPipeline();

      // Should work normally again
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: 'test' }));
      const result = await cbClient.getPipeline();
      expect(result).toEqual({ data: 'test' });

      vi.useRealTimers();
    });
  });
});
