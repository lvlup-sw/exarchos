/**
 * Production code resolves the state directory through `utils/paths.ts`, with no
 * hardcoded `~/.claude/` path. The suite checks the `state-store.ts` re-export, scans
 * `src/` for hardcoded path constructions, and checks that schema descriptions name no platform.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

describe('state-store resolveStateDir re-export', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    vi.stubEnv('WORKFLOW_STATE_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('state-store resolveStateDir returns same result as utils/paths resolveStateDir', async () => {
    const { resolveStateDir: stateStoreResolver } = await import('../../../src/workflow/state-store.js');
    const { resolveStateDir: utilsResolver } = await import('../../../src/utils/paths.js');
    expect(stateStoreResolver()).toBe(utilsResolver());
  });

  it('state-store resolveStateDir respects XDG_STATE_HOME (cascade level 3)', async () => {
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    const { resolveStateDir: stateStoreResolver } = await import('../../../src/workflow/state-store.js');
    expect(stateStoreResolver()).toBe('/xdg/state/exarchos/state');
  });

  it('state-store resolveStateDir returns universal default (cascade level 4)', async () => {
    const { resolveStateDir: stateStoreResolver } = await import('../../../src/workflow/state-store.js');
    expect(stateStoreResolver()).toBe('/home/testuser/.exarchos/state');
  });
});

/**
 * `findHardcodedPaths` scans each production `.ts` file under `src/`, except `utils/paths.ts`
 * and the `CONFIG_WRITERS` modules. A config writer writes a path for another process to
 * read, so the literal is its payload. The map names each writer by file, because an
 * exclusion by directory misses a writer that lives in another directory.
 */
describe('no hardcoded ~/.claude/ path constructions in production code', () => {
  const srcDir = path.resolve(__dirname, '../../../src');

  const CONFIG_WRITERS: ReadonlyMap<string, string> = new Map([
    ['verbs/init/writers/claude-code.ts', 'writes WORKFLOW_STATE_DIR into the generated Claude Code config'],
    ['install/install-skills.ts', 'writes the MCP registration (with WORKFLOW_STATE_DIR) into ~/.claude.json'],
  ]);

  function findHardcodedPaths(dir: string): Array<{ file: string; line: number; content: string }> {
    const violations: Array<{ file: string; line: number; content: string }> = [];
    const patterns = [
      /['"]\.claude['"],\s*['"]workflow-state['"]/,
      /['"]\.claude['"],\s*['"]teams['"]/,
      /['"]\.claude['"],\s*['"]tasks['"]/,
    ];

    function walk(currentDir: string): void {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(fullPath);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.d.ts') &&
          fullPath !== path.resolve(srcDir, 'utils', 'paths.ts') &&
          !CONFIG_WRITERS.has(path.relative(srcDir, fullPath).split(path.sep).join('/'))
        ) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            for (const pattern of patterns) {
              if (pattern.test(lines[i])) {
                violations.push({
                  file: path.relative(srcDir, fullPath),
                  line: i + 1,
                  content: lines[i].trim(),
                });
              }
            }
          }
        }
      }
    }

    walk(dir);
    return violations;
  }

  /**
   * An exemption for a file that moved excludes nothing.
   * So each exempted file must exist and must still construct such a path.
   */
  it('every config-writer exemption resolves and still spells a path out', () => {
    expect(CONFIG_WRITERS.size).toBeGreaterThan(0);
    for (const [rel, reason] of CONFIG_WRITERS) {
      const abs = path.resolve(srcDir, rel);
      expect(fs.existsSync(abs), `exempted config writer ${rel} does not exist (${reason})`).toBe(
        true,
      );
      const content = fs.readFileSync(abs, 'utf-8');
      expect(
        /['"]\.claude['"],\s*['"](workflow-state|teams|tasks)['"]/.test(content),
        `${rel} is exempted but no longer constructs such a path — drop the exemption`,
      ).toBe(true);
    }
  });

  it('no hardcoded workflow-state path constructions remain', () => {
    const violations = findHardcodedPaths(srcDir);
    const workflowStateViolations = violations.filter((v) =>
      v.content.includes('workflow-state'),
    );
    expect(workflowStateViolations).toEqual([]);
  });

  it('no hardcoded teams path constructions remain', () => {
    const violations = findHardcodedPaths(srcDir);
    const teamsViolations = violations.filter((v) =>
      v.content.includes("'teams'") || v.content.includes('"teams"'),
    );
    expect(teamsViolations).toEqual([]);
  });

  it('no hardcoded tasks path constructions remain', () => {
    const violations = findHardcodedPaths(srcDir);
    const tasksViolations = violations.filter((v) =>
      (v.content.includes("'tasks'") || v.content.includes('"tasks"')) && v.content.includes('.claude'),
    );
    expect(tasksViolations).toEqual([]);
  });
});

describe('schema descriptions are platform-neutral', () => {
  it('SessionTaggedData.sessionId does not mention Claude Code', async () => {
    const { SessionTaggedData } = await import('../../../src/events/schemas.js');
    const shape = SessionTaggedData.shape;
    const sessionIdDesc = shape.sessionId.description;
    expect(sessionIdDesc).not.toContain('Claude Code');
    expect(sessionIdDesc).toBe('Session identifier');
  });

  /** The test reads only the Zod description of `agentId`. When the field has none, the test asserts nothing. */
  it('TaskSchema.agentId comment does not mention Claude Code', async () => {
    const { TaskSchema } = await import('../../../src/workflow/schemas.js');
    const shape = TaskSchema.shape;
    const agentIdDesc = shape.agentId.description;
    if (agentIdDesc) {
      expect(agentIdDesc).not.toContain('Claude Code');
    }
  });

  it('nativeIsolation schema description does not mention Claude Code', async () => {
    const { getFullRegistry } = await import('../../../src/registry.js');
    const registry = getFullRegistry();

    let found = false;
    for (const tool of registry) {
      for (const action of tool.actions) {
        if (action.name === 'prepare_delegation') {
          const shape = action.schema.shape as Record<string, { description?: string }>;
          if (shape['nativeIsolation']) {
            const desc = shape['nativeIsolation'].description;
            expect(desc).not.toContain('Claude Code');
            expect(desc).toContain('the host platform handles isolation natively');
            found = true;
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
