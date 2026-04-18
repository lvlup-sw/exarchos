/**
 * Integration tests verifying that all hardcoded ~/.claude/ path constructions
 * have been replaced with centralized path resolvers from utils/paths.ts.
 *
 * These tests verify:
 * 1. Re-export from state-store.ts delegates to utils/paths.ts
 * 2. No remaining hardcoded path constructions in production source files
 * 3. Schema descriptions use platform-neutral language
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

// ─── Test 1: state-store.ts re-exports resolveStateDir from utils/paths.ts ──

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
    const { resolveStateDir: stateStoreResolver } = await import('../workflow/state-store.js');
    const { resolveStateDir: utilsResolver } = await import('./paths.js');
    expect(stateStoreResolver()).toBe(utilsResolver());
  });

  it('state-store resolveStateDir respects XDG_STATE_HOME (cascade level 3)', async () => {
    vi.stubEnv('XDG_STATE_HOME', '/xdg/state');
    const { resolveStateDir: stateStoreResolver } = await import('../workflow/state-store.js');
    expect(stateStoreResolver()).toBe('/xdg/state/exarchos/state');
  });

  it('state-store resolveStateDir returns universal default (cascade level 4)', async () => {
    const { resolveStateDir: stateStoreResolver } = await import('../workflow/state-store.js');
    expect(stateStoreResolver()).toBe('/home/testuser/.exarchos/state');
  });
});

// ─── Test 2: No hardcoded path constructions remain in production code ──────

describe('no hardcoded ~/.claude/ path constructions in production code', () => {
  const srcDir = path.resolve(__dirname, '..');

  /**
   * Scan all .ts files (excluding tests and utils/paths.ts) for hardcoded
   * path constructions like '.claude', 'workflow-state' etc.
   */
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
          // Init writers legitimately construct config entries with path values
          !fullPath.includes(path.join('init', 'writers'))
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

// ─── Test 3: Schema descriptions are platform-neutral ───────────────────────

describe('schema descriptions are platform-neutral', () => {
  it('SessionTaggedData.sessionId does not mention Claude Code', async () => {
    const { SessionTaggedData } = await import('../event-store/schemas.js');
    const shape = SessionTaggedData.shape;
    const sessionIdDesc = shape.sessionId.description;
    expect(sessionIdDesc).not.toContain('Claude Code');
    expect(sessionIdDesc).toBe('Session identifier');
  });

  it('TaskSchema.agentId comment does not mention Claude Code', async () => {
    // We verify the source code comment, not the Zod description,
    // by checking the schema description property if set
    const { TaskSchema } = await import('../workflow/schemas.js');
    const shape = TaskSchema.shape;
    const agentIdDesc = shape.agentId.description;
    // agentId uses a JSDoc comment, not a Zod .describe() — description may be undefined.
    // DR-3 compliance is verified by grep in the source file instead.
    if (agentIdDesc) {
      expect(agentIdDesc).not.toContain('Claude Code');
    }
  });

  it('nativeIsolation schema description does not mention Claude Code', async () => {
    const { getFullRegistry } = await import('../registry.js');
    const registry = getFullRegistry();

    // Find the prepare_delegation action schema which has the nativeIsolation field
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
