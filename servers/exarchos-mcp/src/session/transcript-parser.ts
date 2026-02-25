import * as fs from 'node:fs/promises';
import type {
  SessionToolEvent,
  SessionTurnEvent,
  SessionSummaryEvent,
  SessionEvent,
  SessionMetadata,
} from './types.js';

const NATIVE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'TodoWrite', 'TodoRead',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'ToolSearch',
]);

function categorizeTool(toolName: string): 'native' | 'mcp_exarchos' | 'mcp_other' {
  if (NATIVE_TOOLS.has(toolName)) return 'native';
  if (toolName.startsWith('mcp__plugin_exarchos') || toolName.startsWith('mcp__exarchos')) return 'mcp_exarchos';
  return 'mcp_other';
}

function extractFilePaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];

  if (typeof input.file_path === 'string') {
    paths.push(input.file_path);
  }
  if (typeof input.path === 'string') {
    paths.push(input.path);
  }
  if (Array.isArray(input.file_paths)) {
    for (const fp of input.file_paths) {
      if (typeof fp === 'string') {
        paths.push(fp);
      }
    }
  }

  // Deduplicate
  return [...new Set(paths)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContentArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

interface ToolResultBlock {
  toolUseId: string;
  content: string;
}

export function extractToolCalls(lines: unknown[], metadata: SessionMetadata): SessionToolEvent[] {
  const toolUses: ToolUseBlock[] = [];
  const toolResults = new Map<string, ToolResultBlock>();

  for (const line of lines) {
    if (!isRecord(line)) continue;

    const type = line.type as string | undefined;
    const message = isRecord(line.message) ? line.message : undefined;
    if (!message) continue;

    const content = isContentArray(message.content) ? message.content : undefined;
    if (!content) continue;

    const timestamp = typeof line.timestamp === 'string' ? line.timestamp : '';

    if (type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: isRecord(block.input) ? block.input : {},
            timestamp,
          });
        }
      }
    } else if (type === 'user') {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          toolResults.set(block.tool_use_id, {
            toolUseId: block.tool_use_id,
            content: resultContent,
          });
        }
      }
    }
  }

  const events: SessionToolEvent[] = [];
  for (const tu of toolUses) {
    const result = toolResults.get(tu.id);
    const inputBytes = JSON.stringify(tu.input).length;
    const outputBytes = result ? result.content.length : 0;
    const filePaths = extractFilePaths(tu.name, tu.input);

    const event: SessionToolEvent = {
      t: 'tool',
      ts: tu.timestamp,
      tool: tu.name,
      cat: categorizeTool(tu.name),
      inB: inputBytes,
      outB: outputBytes,
      sid: metadata.sessionId,
      ...(metadata.workflowId ? { wid: metadata.workflowId } : {}),
      ...(filePaths.length > 0 ? { files: filePaths } : {}),
    };
    events.push(event);
  }

  return events;
}

export function extractTurns(lines: unknown[], metadata: SessionMetadata): SessionTurnEvent[] {
  const events: SessionTurnEvent[] = [];

  for (const line of lines) {
    if (!isRecord(line)) continue;
    if (line.type !== 'assistant') continue;

    const message = isRecord(line.message) ? line.message : undefined;
    if (!message) continue;

    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (!usage) continue;

    const timestamp = typeof line.timestamp === 'string' ? line.timestamp : '';
    const model = typeof message.model === 'string' ? message.model : 'unknown';

    const event: SessionTurnEvent = {
      t: 'turn',
      ts: timestamp,
      model,
      tokIn: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      tokOut: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      tokCacheR: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
      tokCacheW: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
      sid: metadata.sessionId,
      ...(metadata.workflowId ? { wid: metadata.workflowId } : {}),
    };
    events.push(event);
  }

  return events;
}

export function buildSessionSummary(
  toolEvents: SessionToolEvent[],
  turnEvents: SessionTurnEvent[],
  metadata: SessionMetadata,
): SessionSummaryEvent {
  // Aggregate tools by name
  const tools: Record<string, number> = {};
  for (const te of toolEvents) {
    tools[te.tool] = (tools[te.tool] ?? 0) + 1;
  }

  // Sum tokens across all turns
  let tokIn = 0;
  let tokOut = 0;
  let tokCacheR = 0;
  let tokCacheW = 0;
  for (const turn of turnEvents) {
    tokIn += turn.tokIn;
    tokOut += turn.tokOut;
    tokCacheR += turn.tokCacheR;
    tokCacheW += turn.tokCacheW;
  }

  // Collect unique file paths
  const fileSet = new Set<string>();
  for (const te of toolEvents) {
    if (te.files) {
      for (const f of te.files) {
        fileSet.add(f);
      }
    }
  }

  // Calculate duration from timestamps
  const allTimestamps: number[] = [];
  for (const te of toolEvents) {
    if (te.ts) allTimestamps.push(new Date(te.ts).getTime());
  }
  for (const turn of turnEvents) {
    if (turn.ts) allTimestamps.push(new Date(turn.ts).getTime());
  }

  let dur = 0;
  if (allTimestamps.length >= 2) {
    const minTs = Math.min(...allTimestamps);
    const maxTs = Math.max(...allTimestamps);
    dur = maxTs - minTs;
  }

  const now = new Date().toISOString();

  return {
    t: 'summary',
    ts: now,
    sid: metadata.sessionId,
    ...(metadata.workflowId ? { wid: metadata.workflowId } : {}),
    tools,
    tokTotal: {
      in: tokIn,
      out: tokOut,
      cacheR: tokCacheR,
      cacheW: tokCacheW,
    },
    files: [...fileSet],
    dur,
    turns: turnEvents.length,
  };
}

export async function parseTranscript(
  transcriptPath: string,
  metadata: SessionMetadata,
): Promise<SessionEvent[]> {
  const content = await fs.readFile(transcriptPath, 'utf-8');
  const lines: unknown[] = [];

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  const toolEvents = extractToolCalls(lines, metadata);
  const turnEvents = extractTurns(lines, metadata);
  const summary = buildSessionSummary(toolEvents, turnEvents, metadata);

  return [...toolEvents, ...turnEvents, summary];
}
