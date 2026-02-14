import { TOOL_REGISTRY } from '../src/registry.js';
import type { CompositeTool } from '../src/registry.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ALL_PHASES = ['ideate', 'plan', 'plan-review', 'delegate', 'review', 'synthesize'] as const;

// ─── Markdown Generation ────────────────────────────────────────────────────

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function formatPhases(phases: ReadonlySet<string>): string {
  const hasAll = ALL_PHASES.every((p) => phases.has(p));
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

function generateActionDetails(registry: readonly CompositeTool[]): string {
  const sections: string[] = ['## Action Details'];

  for (const composite of registry) {
    sections.push('');
    sections.push(`### ${composite.name}`);
    sections.push('');
    sections.push('| Action | Description | Phases | Roles |');
    sections.push('|--------|-------------|--------|-------|');

    for (const action of composite.actions) {
      sections.push(
        `| \`${action.name}\` | ${escapeTableCell(action.description)} | ${formatPhases(action.phases)} | ${formatRoles(action.roles)} |`,
      );
    }
  }

  return sections.join('\n');
}

function generatePhaseMappings(registry: readonly CompositeTool[]): string {
  // Build a map of phase -> list of "composite:action" strings
  const phaseMap = new Map<string, string[]>();
  for (const phase of ALL_PHASES) {
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

  for (const phase of ALL_PHASES) {
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
  const sections: string[] = [
    '# Exarchos MCP Tool Reference',
    '',
    '> Auto-generated from tool registry. Do not edit manually.',
    '',
    generateCompositeTable(TOOL_REGISTRY),
    '',
    generateActionDetails(TOOL_REGISTRY),
    '',
    generatePhaseMappings(TOOL_REGISTRY),
    '',
  ];

  return sections.join('\n');
}

// ─── CLI Entrypoint ─────────────────────────────────────────────────────────

// Only run when executed directly (not imported by tests)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('generate-docs.ts') || process.argv[1].endsWith('generate-docs.js'));

if (isDirectRun) {
  process.stdout.write(generateDocsMarkdown());
}
