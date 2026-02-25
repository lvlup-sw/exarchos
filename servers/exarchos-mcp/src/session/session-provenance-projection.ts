// ─── Session Provenance Projection ──────────────────────────────────────────
//
// CQRS view projection that materializes session events into queryable
// aggregates. Completely lazy — never hydrated at startup, reads session
// JSONL files on-demand with a bounded LRU cache.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SessionEvent,
  SessionToolEvent,
  SessionTurnEvent,
  SessionSummaryEvent,
} from './types.js';
import { readManifestEntries } from './manifest.js';

// ─── Public Types ───────────────────────────────────────────────────────────

export interface SessionProvenanceQuery {
  sessionId?: string;
  workflowId?: string;
  metric?: 'cost' | 'attribution';
}

export interface SessionProvenanceResult {
  sessionId?: string;
  workflowId?: string;
  sessions?: number;
  tools?: Record<string, number>;
  toolsByCategory?: { native: number; mcp_exarchos: number; mcp_other: number };
  tokens?: { in: number; out: number; cacheR: number; cacheW: number };
  files?: string[];
  duration?: number;
  turns?: number;
  costBySession?: Array<{ sid: string; tokens: { in: number; out: number } }>;
  fileAttribution?: Array<{ file: string; tools: string[] }>;
}

// ─── LRU Cache ──────────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 20;
const sessionCache = new Map<string, SessionEvent[]>();

function getCachedEvents(key: string): SessionEvent[] | undefined {
  const value = sessionCache.get(key);
  if (value !== undefined) {
    // Move to end (most recently used)
    sessionCache.delete(key);
    sessionCache.set(key, value);
  }
  return value;
}

function setCachedEvents(key: string, events: SessionEvent[]): void {
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest (first key)
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) {
      sessionCache.delete(oldest);
    }
  }
  sessionCache.set(key, events);
}

// ─── Event File Reading ─────────────────────────────────────────────────────

async function readSessionEvents(
  stateDir: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const cacheKey = `${stateDir}:${sessionId}`;
  const cached = getCachedEvents(cacheKey);
  if (cached) return cached;

  const eventsPath = path.join(stateDir, 'sessions', `${sessionId}.events.jsonl`);
  let content: string;
  try {
    content = await fs.readFile(eventsPath, 'utf-8');
  } catch {
    return [];
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  const events = trimmed
    .split('\n')
    .map((line) => JSON.parse(line) as SessionEvent);

  setCachedEvents(cacheKey, events);
  return events;
}

// ─── Single-Session Aggregation ─────────────────────────────────────────────

function aggregateSession(events: SessionEvent[]): {
  tools: Record<string, number>;
  toolsByCategory: { native: number; mcp_exarchos: number; mcp_other: number };
  tokens: { in: number; out: number; cacheR: number; cacheW: number };
  files: string[];
  duration: number;
  turns: number;
} {
  const tools: Record<string, number> = {};
  const toolsByCategory = { native: 0, mcp_exarchos: 0, mcp_other: 0 };
  const tokens = { in: 0, out: 0, cacheR: 0, cacheW: 0 };
  const filesSet = new Set<string>();
  let duration = 0;
  let turns = 0;

  // Summary events are authoritative — if present, use them for tools/tokens/turns/duration.
  // Individual tool/turn events are only used for aggregation when no summary exists.
  const summaryEvents = events.filter((e): e is SessionSummaryEvent => e.t === 'summary');
  const hasSummary = summaryEvents.length > 0;

  if (hasSummary) {
    for (const su of summaryEvents) {
      for (const [name, count] of Object.entries(su.tools)) {
        tools[name] = (tools[name] ?? 0) + count;
      }
      tokens.in += su.tokTotal.in;
      tokens.out += su.tokTotal.out;
      tokens.cacheR += su.tokTotal.cacheR;
      tokens.cacheW += su.tokTotal.cacheW;
      for (const f of su.files) filesSet.add(f);
      duration += su.dur;
      turns += su.turns;
    }
    // Still process tool events for category breakdown and file tracking
    for (const event of events) {
      if (event.t === 'tool') {
        const te = event as SessionToolEvent;
        toolsByCategory[te.cat] += 1;
        if (te.files) {
          for (const f of te.files) filesSet.add(f);
        }
      }
    }
  } else {
    // No summary — aggregate from individual events
    for (const event of events) {
      switch (event.t) {
        case 'tool': {
          const te = event as SessionToolEvent;
          tools[te.tool] = (tools[te.tool] ?? 0) + 1;
          toolsByCategory[te.cat] += 1;
          if (te.files) {
            for (const f of te.files) filesSet.add(f);
          }
          break;
        }
        case 'turn': {
          const tu = event as SessionTurnEvent;
          tokens.in += tu.tokIn;
          tokens.out += tu.tokOut;
          tokens.cacheR += tu.tokCacheR;
          tokens.cacheW += tu.tokCacheW;
          turns += 1;
          break;
        }
      }
    }
  }

  return {
    tools,
    toolsByCategory,
    tokens,
    files: [...filesSet],
    duration,
    turns,
  };
}

// ─── Attribution (file → tool mapping) ──────────────────────────────────────

function buildFileAttribution(
  events: SessionEvent[],
): Array<{ file: string; tools: string[] }> {
  const fileToTools = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.t !== 'tool') continue;
    const te = event as SessionToolEvent;
    if (!te.files) continue;
    for (const f of te.files) {
      const existing = fileToTools.get(f);
      if (existing) {
        existing.add(te.tool);
      } else {
        fileToTools.set(f, new Set([te.tool]));
      }
    }
  }

  return [...fileToTools.entries()].map(([file, toolSet]) => ({
    file,
    tools: [...toolSet],
  }));
}

// ─── Cost breakdown by session ──────────────────────────────────────────────

function buildCostBySession(
  sessionsEvents: Array<{ sid: string; events: SessionEvent[] }>,
): Array<{ sid: string; tokens: { in: number; out: number } }> {
  return sessionsEvents.map(({ sid, events }) => {
    let tokIn = 0;
    let tokOut = 0;
    for (const event of events) {
      if (event.t === 'turn') {
        const tu = event as SessionTurnEvent;
        tokIn += tu.tokIn;
        tokOut += tu.tokOut;
      } else if (event.t === 'summary') {
        const su = event as SessionSummaryEvent;
        tokIn += su.tokTotal.in;
        tokOut += su.tokTotal.out;
      }
    }
    return { sid, tokens: { in: tokIn, out: tokOut } };
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function materializeSessionProvenance(
  stateDir: string,
  query: SessionProvenanceQuery,
): Promise<SessionProvenanceResult> {
  // Single session query
  if (query.sessionId && !query.workflowId) {
    const events = await readSessionEvents(stateDir, query.sessionId);
    const agg = aggregateSession(events);

    const result: SessionProvenanceResult = {
      sessionId: query.sessionId,
      ...agg,
    };

    if (query.metric === 'attribution') {
      result.fileAttribution = buildFileAttribution(events);
    }

    return result;
  }

  // Workflow query — find all sessions with matching workflowId
  if (query.workflowId) {
    const entries = await readManifestEntries(stateDir);
    const matchingEntries = entries.filter((e) => e.workflowId === query.workflowId);

    const sessionsEvents: Array<{ sid: string; events: SessionEvent[] }> = [];
    for (const entry of matchingEntries) {
      const events = await readSessionEvents(stateDir, entry.sessionId);
      sessionsEvents.push({ sid: entry.sessionId, events });
    }

    // Aggregate across all sessions
    const allEvents = sessionsEvents.flatMap((s) => s.events);
    const agg = aggregateSession(allEvents);

    const result: SessionProvenanceResult = {
      workflowId: query.workflowId,
      sessions: matchingEntries.length,
      ...agg,
    };

    if (query.metric === 'cost') {
      result.costBySession = buildCostBySession(sessionsEvents);
    }

    if (query.metric === 'attribution') {
      result.fileAttribution = buildFileAttribution(allEvents);
    }

    return result;
  }

  // Neither sessionId nor workflowId — return empty
  return {
    tools: {},
    toolsByCategory: { native: 0, mcp_exarchos: 0, mcp_other: 0 },
    tokens: { in: 0, out: 0, cacheR: 0, cacheW: 0 },
  };
}
