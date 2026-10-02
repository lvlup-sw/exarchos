import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { CompositeTool } from '../../../src/registry.js';

/** Returns the sorted set of phases that the registry actions declare, so no phase list is hardcoded. */
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
 * Renders the `TOOL_REGISTRY` as a Markdown tool reference. A direct run of this script
 * writes it to stdout.
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

/**
 * Returns the absolute path with symlinks resolved. When `realpathSync` fails, it
 * returns the plain absolute path, so an odd `argv[1]` reads as "not the entrypoint".
 */
function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * True when this file is the process entrypoint, not an import. It compares resolved
 * paths, not the file name. A name check fails silently after a rename: the script
 * runs, writes nothing, and exits 0.
 */
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.stdout.write(generateDocsMarkdown());
}
