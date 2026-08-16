import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { CompositeTool } from '../../../src/registry.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Derives the complete set of phases from registry action metadata.
 * This avoids hardcoding phases that may drift from the registry.
 */
function collectPhasesFromRegistry(registry: readonly CompositeTool[]): string[] {
  const phases = new Set<string>();
  for (const composite of registry) {
    for (const action of composite.actions) {
      for (const phase of action.phases) {
        phases.add(phase);
      }
    }
  }
  return [...phases].sort();
}

// ─── Markdown Generation ────────────────────────────────────────────────────

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function formatPhases(phases: ReadonlySet<string>, allPhases: string[]): string {
  const hasAll = allPhases.every((p) => phases.has(p));
  if (hasAll) return 'all';
  return [...phases].join(', ');
}

function formatRoles(roles: ReadonlySet<string>): string {
  return [...roles].join(', ');
}

function generateCompositeTable(registry: readonly CompositeTool[]): string {
  const lines: string[] = [
    '## Composite Tools',
    '',
    '| Tool | Description | Actions |',
    '|------|-------------|---------|',
  ];

  for (const composite of registry) {
    const actionNames = composite.actions.map((a) => a.name).join(', ');
    lines.push(`| \`${composite.name}\` | ${escapeTableCell(composite.description)} | ${actionNames} |`);
  }

  return lines.join('\n');
}

function generateActionDetails(registry: readonly CompositeTool[], allPhases: string[]): string {
  const sections: string[] = ['## Action Details'];

  for (const composite of registry) {
    sections.push('');
    sections.push(`### ${composite.name}`);
    sections.push('');
    sections.push('| Action | Description | Phases | Roles |');
    sections.push('|--------|-------------|--------|-------|');

    for (const action of composite.actions) {
      sections.push(
        `| \`${action.name}\` | ${escapeTableCell(action.description)} | ${formatPhases(action.phases, allPhases)} | ${formatRoles(action.roles)} |`,
      );
    }
  }

  return sections.join('\n');
}

function generatePhaseMappings(registry: readonly CompositeTool[], allPhases: string[]): string {
  // Build a map of phase -> list of "composite:action" strings
  const phaseMap = new Map<string, string[]>();
  for (const phase of allPhases) {
    phaseMap.set(phase, []);
  }

  for (const composite of registry) {
    const shortName = composite.name.replace('exarchos_', '');
    for (const action of composite.actions) {
      for (const phase of action.phases) {
        const list = phaseMap.get(phase);
        if (list) {
          list.push(`${shortName}:${action.name}`);
        }
      }
    }
  }

  const lines: string[] = [
    '## Phase Mappings',
    '',
    '| Phase | Available Actions |',
    '|-------|-------------------|',
  ];

  for (const phase of allPhases) {
    const actions = phaseMap.get(phase) ?? [];
    lines.push(`| ${phase} | ${actions.join(', ')} |`);
  }

  return lines.join('\n');
}

/**
 * Generates Markdown documentation from the TOOL_REGISTRY.
 * Exported for testability; the script's main entrypoint writes to stdout.
 */
export function generateDocsMarkdown(): string {
  const allPhases = collectPhasesFromRegistry(TOOL_REGISTRY);
  const sections: string[] = [
    '# Exarchos MCP Tool Reference',
    '',
    '> Auto-generated from tool registry. Do not edit manually.',
    '',
    generateCompositeTable(TOOL_REGISTRY),
    '',
    generateActionDetails(TOOL_REGISTRY, allPhases),
    '',
    generatePhaseMappings(TOOL_REGISTRY, allPhases),
    '',
  ];

  return sections.join('\n');
}

// ─── CLI Entrypoint ─────────────────────────────────────────────────────────
//
// The predicate used to be `process.argv[1].endsWith('generate-docs.ts')`, which
// couples self-execution to the FILE'S NAME. Renaming the file — and updating
// the `generate:docs` script to match, which is what a rename means — leaves an
// invocation that still exists, still runs, still resolves, and writes NOTHING:
// measured as 0 bytes on stdout, 0 on stderr, exit 0, with the empty output then
// flowing wherever the generated reference is redirected. Comparing the RESOLVED
// PATH of the process entrypoint against this module's own URL is rename-proof
// by construction, because both sides move together (DR-4, task 074).

/**
 * A canonical absolute path for comparison: symlinks resolved where possible,
 * falling back to plain resolution for a path that does not exist on disk (so
 * an exotic `argv[1]` degrades to "not the entrypoint" rather than throwing).
 */
function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// Only run when executed directly (not imported by tests)
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.stdout.write(generateDocsMarkdown());
}
