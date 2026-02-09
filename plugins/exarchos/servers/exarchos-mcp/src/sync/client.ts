import type {
  RemoteConfig,
  ExarchosEventDto,
  WorkflowRegistration,
  AppendEventsResponse,
  PendingCommand,
} from './types.js';

// ─── API Error ───────────────────────────────────────────────────────────────

export class BasileusApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'BasileusApiError';
  }
}

// ─── Circuit Breaker State ───────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

// ─── Basileus HTTP Client ────────────────────────────────────────────────────

export class BasileusClient {
  private consecutiveFailures = 0;
  private circuitState: CircuitState = 'closed';
  private lastFailureAt = 0;

  constructor(private readonly config: RemoteConfig) {}

  // ─── Circuit Breaker ────────────────────────────────────────────────────

  private checkCircuit(): void {
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.lastFailureAt;
      if (elapsed >= COOLDOWN_MS) {
        this.circuitState = 'half-open';
      } else {
        throw new BasileusApiError(
          503,
          'Circuit breaker open — remote API unavailable',
        );
      }
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitState = 'open';
    }
  }

  // ─── HTTP Helpers ───────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<T> {
    this.checkCircuit();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const url = `${this.config.apiBaseUrl}${urlPath}`;
      const opts: RequestInit = {
        method,
        headers: this.buildHeaders(),
        signal: controller.signal,
      };

      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }

      const response = await fetch(url, opts);

      if (!response.ok) {
        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text();
        }
        this.recordFailure();
        throw new BasileusApiError(
          response.status,
          `HTTP ${response.status}: ${response.statusText}`,
          responseBody,
        );
      }

      this.recordSuccess();
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof BasileusApiError) {
        throw err;
      }
      this.recordFailure();
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── API Methods ────────────────────────────────────────────────────────

  async registerWorkflow(
    featureId: string,
    workflowType: string,
  ): Promise<WorkflowRegistration> {
    return this.request<WorkflowRegistration>(
      'POST',
      '/api/exarchos/workflows',
      {
        featureId,
        workflowType,
        exarchosId: this.config.exarchosId,
      },
    );
  }

  async appendEvents(
    streamId: string,
    events: ExarchosEventDto[],
    expectedVersion?: number,
  ): Promise<AppendEventsResponse> {
    const body: Record<string, unknown> = { events };
    if (expectedVersion !== undefined) {
      body.expectedVersion = expectedVersion;
    }
    return this.request<AppendEventsResponse>(
      'POST',
      `/api/exarchos/streams/${streamId}/events`,
      body,
    );
  }

  async getEventsSince(
    streamId: string,
    sinceVersion: number,
  ): Promise<ExarchosEventDto[]> {
    return this.request<ExarchosEventDto[]>(
      'GET',
      `/api/exarchos/streams/${streamId}/events?sinceVersion=${sinceVersion}`,
    );
  }

  async getPipeline(): Promise<unknown> {
    return this.request<unknown>('GET', '/api/exarchos/pipeline');
  }

  async getPendingCommands(): Promise<PendingCommand[]> {
    return this.request<PendingCommand[]>(
      'GET',
      `/api/exarchos/${this.config.exarchosId}/commands`,
    );
  }
}
