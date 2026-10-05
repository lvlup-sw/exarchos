/**
 * Materializes session events into provenance aggregates. It reads the session JSONL files on demand,
 * never at startup, and keeps the parsed events in a bounded LRU cache.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SessionEvent,
  SessionToolEvent,
  SessionTurnEvent,
  SessionSummaryEvent,
} from './types.js';
import { readManifestEntries } from './manifest.js';

export interface SessionProvenanceQuery {
  sessionId?: string | undefined;
  workflowId?: string | undefined;
  metric?: 'cost' | 'attribution' | undefined;
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

const MAX_CACHE_SIZE = 20;

interface CacheEntry {
  events: SessionEvent[];
  mtimeMs: number;
}

/** The LRU cache. A `Map` keeps insertion order, so its first key is the least recently used. */
const sessionCache = new Map<string, CacheEntry>();

/** Returns the cached events and marks them as most recently used. A changed file mtime drops the entry. */
function getCachedEvents(key: string, currentMtimeMs: number): SessionEvent[] | undefined {
  const entry = sessionCache.get(key);
  if (entry !== undefined) {
    if (entry.mtimeMs !== currentMtimeMs) {
      sessionCache.delete(key);
      return undefined;
    }
    sessionCache.delete(key);
    sessionCache.set(key, entry);
    return entry.events;
  }
  return undefined;
}

/** Caches the events. When the cache is full, it first evicts the least recently used entry. */
function setCachedEvents(key: string, events: SessionEvent[], mtimeMs: number): void {
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) {
      sessionCache.delete(oldest);
    }
  }
  sessionCache.set(key, { events, mtimeMs });
}

/**
 * Reads the events of one session. A session id with characters outside `[a-zA-Z0-9_-]` gives no events,
 * so the id cannot traverse paths. A missing file gives no events. A malformed line, from a partial write
 * or corruption, is skipped.
 */
async function readSessionEvents(
  stateDir: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return [];

  const eventsPath = path.join(stateDir, 'sessions', `${sessionId}.events.jsonl`);
  const cacheKey = `${stateDir}:${sessionId}`;

  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(eventsPath);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const cached = getCachedEvents(cacheKey, stat.mtimeMs);
  if (cached) return cached;

  const content = await fs.readFile(eventsPath, 'utf-8');
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  const events: SessionEvent[] = [];
  for (const line of trimmed.split('\n')) {
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      continue;
    }
  }

  setCachedEvents(cacheKey, events, stat.mtimeMs);
  return events;
}

/**
 * Aggregates the tools, tokens, files, duration, and turns of the events. Summary events are authoritative
 * for tools, tokens, turns, and duration. With no summary, tool and turn events give the tools, tokens,
 * and turns, and the duration stays 0.
 * Tool events always give the category counts and add their files.
 */
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

/** Maps each file to the tools that touched it. */
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

/**
 * Returns the input and output tokens of each session. Summary events take priority over turn events,
 * so the tokens are not counted twice.
 */
function buildCostBySession(
  sessionsEvents: Array<{ sid: string; events: SessionEvent[] }>,
): Array<{ sid: string; tokens: { in: number; out: number } }> {
  return sessionsEvents.map(({ sid, events }) => {
    const summaryEvents = events.filter((e): e is SessionSummaryEvent => e.t === 'summary');
    if (summaryEvents.length > 0) {
      let tokIn = 0;
      let tokOut = 0;
      for (const su of summaryEvents) {
        tokIn += su.tokTotal.in;
        tokOut += su.tokTotal.out;
      }
      return { sid, tokens: { in: tokIn, out: tokOut } };
    }
    let tokIn = 0;
    let tokOut = 0;
    for (const event of events) {
      if (event.t === 'turn') {
        const tu = event as SessionTurnEvent;
        tokIn += tu.tokIn;
        tokOut += tu.tokOut;
      }
    }
    return { sid, tokens: { in: tokIn, out: tokOut } };
  });
}

/**
 * Aggregates one session, or every session of a workflow from the manifest. A `workflowId` takes
 * priority over a `sessionId`, and with neither the result holds empty totals. The `attribution` metric
 * adds the file-to-tool map. The `cost` metric adds the tokens of each session to a workflow result.
 */
export async function materializeSessionProvenance(
  stateDir: string,
  query: SessionProvenanceQuery,
): Promise<SessionProvenanceResult> {
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

  if (query.workflowId) {
    const entries = await readManifestEntries(stateDir);
    const matchingEntries = entries.filter((e) => e.workflowId === query.workflowId);

    const sessionsEvents: Array<{ sid: string; events: SessionEvent[] }> = [];
    for (const entry of matchingEntries) {
      const events = await readSessionEvents(stateDir, entry.sessionId);
      sessionsEvents.push({ sid: entry.sessionId, events });
    }

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

  return {
    tools: {},
    toolsByCategory: { native: 0, mcp_exarchos: 0, mcp_other: 0 },
    tokens: { in: 0, out: 0, cacheR: 0, cacheW: 0 },
  };
}
