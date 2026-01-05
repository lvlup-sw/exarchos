import type {
  Source,
  Session,
  Activity,
  CreateSessionParams,
  ListSourcesResponse,
  ListSessionsResponse,
  ListActivitiesResponse,
  JulesApiErrorResponse,
  IJulesClient
} from './types.js';

const BASE_URL = 'https://jules.google/v1alpha';

export class JulesClient implements IJulesClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        ...options.headers
      }
    });

    const data = await response.json();

    if (!response.ok) {
      const errorResponse = data as JulesApiErrorResponse;
      throw new Error(errorResponse.error?.message || 'API request failed');
    }

    return data as T;
  }

  private normalizeSessionId(sessionId: string): string {
    return sessionId.replace(/^sessions\//, '');
  }

  async listSources(): Promise<Source[]> {
    const response = await this.request<ListSourcesResponse>('/sources');
    return response.sources || [];
  }

  async createSession(params: CreateSessionParams): Promise<Session> {
    if (!params.prompt?.trim()) {
      throw new Error('Prompt cannot be empty');
    }

    return this.request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        prompt: params.prompt,
        sourceContext: params.sourceContext,
        title: params.title,
        requirePlanApproval: params.requirePlanApproval,
        automationMode: params.automationMode
      })
    });
  }

  async getSession(sessionId: string): Promise<Session> {
    const normalizedId = this.normalizeSessionId(sessionId);
    return this.request<Session>(`/sessions/${normalizedId}`);
  }

  async listSessions(): Promise<Session[]> {
    const response = await this.request<ListSessionsResponse>('/sessions');
    return response.sessions || [];
  }

  async approvePlan(sessionId: string): Promise<void> {
    const normalizedId = this.normalizeSessionId(sessionId);
    await this.request(`/sessions/${normalizedId}:approvePlan`, {
      method: 'POST'
    });
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    if (!message?.trim()) {
      throw new Error('Message cannot be empty');
    }

    const normalizedId = this.normalizeSessionId(sessionId);
    await this.request(`/sessions/${normalizedId}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ prompt: message })
    });
  }

  async getActivities(sessionId: string): Promise<Activity[]> {
    const normalizedId = this.normalizeSessionId(sessionId);
    const response = await this.request<ListActivitiesResponse>(
      `/sessions/${normalizedId}/activities`
    );
    return response.activities || [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    const normalizedId = this.normalizeSessionId(sessionId);
    await this.request(`/sessions/${normalizedId}`, {
      method: 'DELETE'
    });
  }
}
