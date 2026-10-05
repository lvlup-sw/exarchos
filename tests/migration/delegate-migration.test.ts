/**
 * Render tests for the delegate skill.
 *
 * The skill source holds no runtime-specific dispatch call. Each `{{SPAWN_AGENT_CALL}}` placeholder
 * renders to the dispatch call that the YAML of the runtime supplies.
 *
 * - Three tests pin the source: it holds no `Task({` call and no runtime-specific dispatch section.
 * - Seven tests read the six rendered variants for the dispatch text of each runtime.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/install/build-skills.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillPath as resolveSkillPath } from '../../tools/test-helpers/content-tree.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'content');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'delegation-migration-'));
  tempDirs.push(dir);
  return dir;
}

function buildIntoTemp(): string {
  const outDir = makeTempDir();
  buildAllSkills({ srcDir: SRC_DIR, outDir, runtimesDir: RUNTIMES_DIR });
  return outDir;
}

function readSource(): string {
  return readFileSync(resolveSkillPath('delegate'), 'utf8');
}

function readVariant(runtime: string): string {
  const p = join(buildIntoTemp(), runtime, 'delegate', 'SKILL.md');
  expect(existsSync(p)).toBe(true);
  return readFileSync(p, 'utf8');
}

/** Removes each temp directory. The removal is best-effort, so the hook ignores a failure. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
    }
  }
});

describe('task 017 — delegation skill refactor', () => {
  /**
   * The source holds no `Task({` call. The placeholder gives the dispatch call, so each runtime
   * supplies its own primitive.
   */
  it('DelegationSource_ContainsNoTaskTool_OnlyPlaceholder', () => {
    const source = readSource();
    expect(source).not.toContain('Task({');
  });

  it('DelegationSource_ContainsNoClaudeNativeSection_CollapsedIntoPlaceholder', () => {
    const source = readSource();
    expect(source).not.toContain('Claude Code Dispatch (native agents)');
  });

  it('DelegationSource_ContainsNoCrossPlatformSection_Unified', () => {
    const source = readSource();
    expect(source).not.toContain('Cross-platform Dispatch');
  });

  /** After the substitution, the claude variant holds the Task tool call with background execution. */
  it('DelegationClaudeVariant_EquivalentBehaviorToPreMigration', () => {
    const rendered = readVariant('claude');
    expect(rendered).toContain('Task({');
    expect(rendered).toContain('subagent_type');
    expect(rendered).toContain('run_in_background');
  });

  /** Cursor 2.5 and later has native sub-agents, so the variant calls `Task({ ... })`. */
  it('DelegationCursorVariant_UsesNativeTaskTool', () => {
    const rendered = readVariant('cursor');
    expect(rendered).toContain('Task({');
    expect(rendered).toContain('subagent_type');
  });

  /** The phrase marks the sequential-fallback prose, which the cursor variant must not hold. */
  it('DelegationCursorVariant_NoLongerEmitsSequentialFallback', () => {
    const rendered = readVariant('cursor');
    expect(rendered).not.toContain('no in-session subagent primitive');
  });

  it('DelegationOpenCodeVariant_UsesTaskTool', () => {
    const rendered = readVariant('opencode');
    expect(rendered).toContain('Task({');
  });

  /** `spawn_agent` is the native multi-agent primitive of the Codex CLI. */
  it('DelegationCodexVariant_UsesNativePrimitive', () => {
    const rendered = readVariant('codex');
    expect(rendered).toContain('spawn_agent');
  });

  it('DelegationCopilotVariant_UsesDelegateSlashCommand', () => {
    const rendered = readVariant('copilot');
    expect(rendered).toContain('/delegate');
  });

  /** The generic variant has no spawn primitive, so it tells the agent to do the tasks sequentially. */
  it('DelegationGenericVariant_SequentialFallback', () => {
    const rendered = readVariant('generic');
    expect(rendered.toLowerCase()).toContain('sequentially');
  });
});
