/**
 * Renders a ToolResult or an envelope as terminal output.
 * Data goes to stdout so that a pipe can read it. Metadata goes to stderr.
 */

import type {
  ToolResult,
  PerfMetrics,
  EventHintsPayload,
  CorrectionsPayload,
  Envelope,
  ErrorEnvelope,
} from '../../format.js';

function isTabular(data: unknown): data is ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.every(item => typeof item === 'object' && item !== null && !Array.isArray(item));
}

function isTreeLike(data: unknown): data is Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  return Object.values(data).some(v => typeof v === 'object' && v !== null);
}

function inferFormat(data: unknown): 'table' | 'tree' | 'json' {
  if (isTabular(data)) return 'table';
  if (isTreeLike(data)) return 'tree';
  return 'json';
}

function formatTable(data: ReadonlyArray<Record<string, unknown>>): string {
  if (data.length === 0) return '';

  const keys = [...new Set(data.flatMap(row => Object.keys(row)))];
  const columns: string[][] = keys.map(key => [
    key,
    ...data.map(row => String(row[key] ?? '')),
  ]);

  const widths = columns.map(col => Math.max(...col.map(cell => cell.length)));

  const lines: string[] = [];
  const rowCount = data.length + 1;
  for (let r = 0; r < rowCount; r++) {
    const cells = columns.map((col, c) => (col[r] ?? '').padEnd(widths[c] ?? 0));
    lines.push(cells.join('  '));
  }

  return lines.join('\n') + '\n';
}

const MAX_TREE_DEPTH = 5;

function formatTree(data: Record<string, unknown>, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  let output = '';

  if (indent >= MAX_TREE_DEPTH) {
    output += `${prefix}[...]\n`;
    return output;
  }

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      output += `${prefix}${key}:\n`;
      output += formatTree(value as Record<string, unknown>, indent + 1);
    } else if (Array.isArray(value)) {
      output += `${prefix}${key}:\n`;
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          output += formatTree(item as Record<string, unknown>, indent + 1);
        } else {
          output += `${prefix}  - ${String(item)}\n`;
        }
      }
    } else {
      output += `${prefix}${key}: ${String(value)}\n`;
    }
  }

  return output;
}

function formatData(data: unknown, format: 'table' | 'json' | 'tree'): string {
  if (data === undefined || data === null) return '';
  if (format === 'table' && isTabular(data)) {
    return formatTable(data);
  }
  if (format === 'tree' && isTreeLike(data)) {
    return formatTree(data);
  }
  return JSON.stringify(data, null, 2) + '\n';
}

export function printError(error: ToolResult['error']): void {
  if (!error) return;

  process.stderr.write(`Error [${error.code}]: ${error.message}\n`);

  if (error.validTargets && error.validTargets.length > 0) {
    const targets = error.validTargets.map(t =>
      typeof t === 'string'
        ? t
        : t.guard
          ? `${t.phase} (guard: ${t.guard.id})`
          : t.phase,
    );
    process.stderr.write(`  Valid targets: ${targets.join(', ')}\n`);
  }

  if (error.suggestedFix) {
    const params = Object.entries(error.suggestedFix.params)
      .filter(([, v]) => v !== undefined && v !== null)
      .flatMap(([k, v]) => {
        const flag = `--${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
        if (v === true) return [flag];
        if (v === false) return [];
        if (typeof v === 'object') return [`${flag} '${JSON.stringify(v)}'`];
        return [`${flag} ${String(v)}`];
      })
      .join(' ');
    process.stderr.write(`  Suggested fix: exarchos ${error.suggestedFix.tool} ${params}\n`);
  }
}

export function prettyPrint(result: ToolResult, format?: 'table' | 'json' | 'tree'): void {
  if (!result.success) {
    printError(result.error);
  } else {
    const effectiveFormat = format ?? inferFormat(result.data);
    process.stdout.write(formatData(result.data, effectiveFormat));
  }

  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`  ! ${warning}\n`);
    }
  }

  if (result._perf) {
    process.stderr.write(`  ${result._perf.ms}ms | ${result._perf.bytes}B | ~${result._perf.tokens} tokens\n`);
  }

  if (result._eventHints && result._eventHints.missing && result._eventHints.missing.length > 0) {
    process.stderr.write(`  Missing events for phase "${result._eventHints.phase}":\n`);
    for (const item of result._eventHints.missing) {
      process.stderr.write(`    - ${item.eventType}: ${item.description}\n`);
    }
  }

  const meta = result._meta as Record<string, unknown> | undefined;
  if (meta && meta['checkpointAdvised'] === true) {
    process.stderr.write(`  Checkpoint advised — run: exarchos wf checkpoint\n`);
  }

  if (result._corrections && result._corrections.applied.length > 0) {
    process.stderr.write('\n  Auto-corrections applied:\n');
    for (const c of result._corrections.applied) {
      process.stderr.write(`    • ${c.param}: ${c.rule}\n`);
    }
  }
}

/**
 * Converts an {@link Envelope} or {@link ErrorEnvelope} back to a {@link ToolResult} for {@link prettyPrint}.
 * On success it is the inverse of `toEnvelope`.
 * It copies `warnings` and `_corrections` on both branches, and `_eventHints` on success, so that the stderr lines stay the same.
 */
function envelopeToToolResult(env: Envelope<unknown> | ErrorEnvelope): ToolResult {
  if (env.success === false) {
    const errEnv = env as ErrorEnvelope;
    return {
      success: false,
      error: errEnv.error as NonNullable<ToolResult['error']>,
      _meta: errEnv._meta,
      _perf: errEnv._perf,
      ...(errEnv.warnings !== undefined ? { warnings: errEnv.warnings } : {}),
      ...(errEnv._corrections !== undefined ? { _corrections: errEnv._corrections } : {}),
    };
  }
  const okEnv = env as Envelope<unknown>;
  const withSidebars = okEnv as Envelope<unknown> & {
    warnings?: readonly string[];
    _corrections?: CorrectionsPayload;
  };
  return {
    success: true,
    data: okEnv.data,
    _meta: okEnv._meta,
    _perf: okEnv._perf,
    ...(withSidebars.warnings !== undefined ? { warnings: withSidebars.warnings } : {}),
    ...(withSidebars._corrections !== undefined ? { _corrections: withSidebars._corrections } : {}),
    ...(okEnv._eventHints !== undefined
      ? { _eventHints: okEnv._eventHints as EventHintsPayload }
      : {}),
  };
}

/**
 * Renders an {@link Envelope} or {@link ErrorEnvelope} on the CLI.
 * The CLI and MCP facades must give equal output.
 * With `json`, it writes the full envelope to stdout as one JSON document, equal to the MCP `structuredContent` except for timestamps.
 * With `table` or `tree`, it uses {@link prettyPrint}.
 * When `EXARCHOS_CLI_ENVELOPE` is the literal `'0'`, it always uses {@link prettyPrint}: data on stdout and metadata on stderr.
 * Any other value, or no value, selects the envelope.
 */
export function toCliResult(
  env: Envelope<unknown> | ErrorEnvelope,
  format: 'table' | 'json' | 'tree',
): void {
  if (process.env.EXARCHOS_CLI_ENVELOPE === '0') {
    prettyPrint(envelopeToToolResult(env), format);
    return;
  }

  if (format === 'json') {
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    return;
  }

  prettyPrint(envelopeToToolResult(env), format);
}
