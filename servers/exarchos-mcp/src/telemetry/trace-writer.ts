import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TraceEntry {
  readonly toolName: string;
  readonly action: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly featureId: string;
  readonly sessionId: string;
  readonly skillContext?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SUMMARY_BYTES = 2048;
const DEFAULT_CAPTURE_DIR = 'evals/captured';

// ─── Truncation ─────────────────────────────────────────────────────────────

/** Truncates a JSON-serialised value to at most `maxBytes` bytes. */
function truncate(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf-8') <= maxBytes) return serialized;
  // Truncate by slicing the string conservatively (multi-byte safe via Buffer)
  const buf = Buffer.from(serialized, 'utf-8');
  return buf.subarray(0, maxBytes).toString('utf-8');
}

// ─── TraceWriter ────────────────────────────────────────────────────────────

/**
 * Writes tool call traces to session-scoped JSONL files.
 *
 * Opt-in via `EXARCHOS_EVAL_CAPTURE=1`. Output directory defaults to
 * `evals/captured` but can be overridden with `EXARCHOS_EVAL_CAPTURE_DIR`.
 *
 * Env vars are read lazily on each call so that tests can stub them after
 * module import. Zero performance impact when disabled — the env var check
 * is the first operation.
 *
 * Write failures are silently swallowed — trace capture must never interfere
 * with tool execution.
 */
/** Strips path separators and parent-directory sequences from an identifier. */
function sanitizeId(id: string): string {
  return id.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
}

export class TraceWriter {
  async writeTrace(entry: TraceEntry): Promise<void> {
    if (process.env.EXARCHOS_EVAL_CAPTURE !== '1') return;

    try {
      const captureDir = process.env.EXARCHOS_EVAL_CAPTURE_DIR || DEFAULT_CAPTURE_DIR;
      await fs.mkdir(captureDir, { recursive: true });

      const filename = `${sanitizeId(entry.featureId)}-${sanitizeId(entry.sessionId)}.trace.jsonl`;
      const filepath = path.join(captureDir, filename);

      const record = {
        toolName: entry.toolName,
        action: entry.action,
        input: truncate(entry.input, MAX_SUMMARY_BYTES),
        output: truncate(entry.output, MAX_SUMMARY_BYTES),
        durationMs: entry.durationMs,
        timestamp: entry.timestamp,
        ...(entry.skillContext ? { skillContext: entry.skillContext } : {}),
      };

      await fs.appendFile(filepath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Swallow errors — trace capture must never throw or block the tool call
    }
  }
}
