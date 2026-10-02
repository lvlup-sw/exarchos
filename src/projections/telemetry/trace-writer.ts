import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

const MAX_SUMMARY_BYTES = 2048;
const DEFAULT_CAPTURE_DIR = 'tests/evals/captured';

/** Serializes `value` as JSON and keeps the first `maxBytes` bytes of the UTF-8 text. */
function truncate(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf-8') <= maxBytes) return serialized;
  const buf = Buffer.from(serialized, 'utf-8');
  return buf.subarray(0, maxBytes).toString('utf-8');
}

/** Strips path separators and parent-directory sequences from an identifier. */
function sanitizeId(id: string): string {
  return id.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
}

/**
 * Writes tool-call traces to one JSONL file for each feature and session.
 *
 * Capture runs only when `EXARCHOS_EVAL_CAPTURE=1`. `EXARCHOS_EVAL_CAPTURE_DIR`
 * overrides the default directory `tests/evals/captured`. Each call reads the
 * environment, so tests can stub it after import. The writer ignores a write
 * error, so capture never blocks the tool call.
 */
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
    }
  }
}
