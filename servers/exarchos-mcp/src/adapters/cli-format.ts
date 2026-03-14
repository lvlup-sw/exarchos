// ─── CLI Pretty Printer ─────────────────────────────────────────────────────
// Converts ToolResult JSON into human-readable terminal output.
// Main data → stdout (pipeable), metadata → stderr (human-visible).

import type { ToolResult, PerfMetrics, EventHintsPayload, CorrectionsPayload } from '../format.js';

// ─── Format Inference ───────────────────────────────────────────────────────

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

// ─── Table Formatter ────────────────────────────────────────────────────────

function formatTable(data: ReadonlyArray<Record<string, unknown>>): string {
  if (data.length === 0) return '';

  const keys = [...new Set(data.flatMap(row => Object.keys(row)))];
  const columns: string[][] = keys.map(key => [
    key,
    ...data.map(row => String(row[key] ?? '')),
  ]);

  const widths = columns.map(col => Math.max(...col.map(cell => cell.length)));

  const lines: string[] = [];
  const rowCount = data.length + 1; // header + data rows
  for (let r = 0; r < rowCount; r++) {
    const cells = columns.map((col, c) => col[r].padEnd(widths[c]));
    lines.push(cells.join('  '));
  }

  return lines.join('\n') + '\n';
}

// ─── Tree Formatter ─────────────────────────────────────────────────────────

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

// ─── Data Formatting ────────────────────────────────────────────────────────

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

// ─── Public API ─────────────────────────────────────────────────────────────

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
  // Error case: delegate to printError, then fall through to metadata
  if (!result.success) {
    printError(result.error);
  } else {
    // Main data to stdout
    const effectiveFormat = format ?? inferFormat(result.data);
    process.stdout.write(formatData(result.data, effectiveFormat));
  }

  // Warnings to stderr (present on both success and error results)
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`  ! ${warning}\n`);
    }
  }

  // Enriched metadata fields (set by telemetry middleware)

  // _perf footer
  if (result._perf) {
    process.stderr.write(`  ${result._perf.ms}ms | ${result._perf.bytes}B | ~${result._perf.tokens} tokens\n`);
  }

  // _eventHints advisory
  if (result._eventHints && result._eventHints.missing && result._eventHints.missing.length > 0) {
    process.stderr.write(`  Missing events for phase "${result._eventHints.phase}":\n`);
    for (const item of result._eventHints.missing) {
      process.stderr.write(`    - ${item.eventType}: ${item.description}\n`);
    }
  }

  // _meta checkpoint
  const meta = result._meta as Record<string, unknown> | undefined;
  if (meta && meta['checkpointAdvised'] === true) {
    process.stderr.write(`  Checkpoint advised — run: exarchos wf checkpoint\n`);
  }

  // _corrections notice
  if (result._corrections && result._corrections.applied.length > 0) {
    process.stderr.write('\n  Auto-corrections applied:\n');
    for (const c of result._corrections.applied) {
      process.stderr.write(`    • ${c.param}: ${c.rule}\n`);
    }
  }
}
