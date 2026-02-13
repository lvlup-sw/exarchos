import { describe, it, expect } from 'vitest';
import { generateDocsMarkdown } from './generate-docs.js';

describe('generateDocsMarkdown', () => {
  const output = generateDocsMarkdown();

  it('should produce markdown with a composite tools table header', () => {
    expect(output).toContain('| Tool |');
    expect(output).toContain('| Description |');
  });

  it('should include all 5 composite tool names', () => {
    const expectedComposites = [
      'exarchos_workflow',
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_sync',
    ];

    for (const name of expectedComposites) {
      expect(output).toContain(name);
    }
  });

  it('should list all 21 action names', () => {
    const expectedActions = [
      // workflow (4)
      'init',
      'get',
      'set',
      'cancel',
      // event (2)
      'append',
      'query',
      // orchestrate (8)
      'team_spawn',
      'team_message',
      'team_broadcast',
      'team_shutdown',
      'team_status',
      'task_claim',
      'task_complete',
      'task_fail',
      // view (6)
      'pipeline',
      'tasks',
      'workflow_status',
      'team_status',
      'stack_status',
      'stack_place',
      // sync (1)
      'now',
    ];

    for (const action of expectedActions) {
      expect(output, `action '${action}' should appear in output`).toContain(
        `\`${action}\``,
      );
    }
  });

  it('should include a phase mappings section with all phases', () => {
    expect(output).toContain('## Phase Mappings');

    const expectedPhases = [
      'ideate',
      'plan',
      'plan-review',
      'delegate',
      'review',
      'synthesize',
    ];

    for (const phase of expectedPhases) {
      expect(
        output,
        `phase '${phase}' should appear in phase mappings`,
      ).toContain(phase);
    }
  });

  it('should produce valid markdown tables with consistent column counts', () => {
    const lines = output.split('\n');

    // Collect contiguous table blocks
    const tables: string[][] = [];
    let currentTable: string[] = [];

    for (const line of lines) {
      if (line.startsWith('|')) {
        currentTable.push(line);
      } else if (currentTable.length > 0) {
        tables.push(currentTable);
        currentTable = [];
      }
    }
    if (currentTable.length > 0) {
      tables.push(currentTable);
    }

    // Verify we found tables
    expect(tables.length).toBeGreaterThan(0);

    // Each table should have consistent column counts across all rows
    for (const table of tables) {
      const columnCounts = table.map(
        (row) => row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).length,
      );
      const expectedColumns = columnCounts[0];
      for (let i = 1; i < columnCounts.length; i++) {
        expect(
          columnCounts[i],
          `Table row ${i} has ${columnCounts[i]} columns, expected ${expectedColumns}: "${table[i]}"`,
        ).toBe(expectedColumns);
      }
    }
  });

  it('should include the auto-generated header notice', () => {
    expect(output).toContain('Auto-generated');
    expect(output).toContain('# Exarchos MCP Tool Reference');
  });

  it('should include action details sections for each composite', () => {
    expect(output).toContain('## Action Details');
    expect(output).toContain('### exarchos_workflow');
    expect(output).toContain('### exarchos_event');
    expect(output).toContain('### exarchos_orchestrate');
    expect(output).toContain('### exarchos_view');
    expect(output).toContain('### exarchos_sync');
  });
});
