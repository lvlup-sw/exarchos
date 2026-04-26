/**
 * Task 017 — Delegation skill migration tests.
 *
 * The delegation skill is the only source in the migration wave that
 * needs STRUCTURAL refactoring beyond placeholder substitution. The
 * pre-migration `skills/delegation/SKILL.md` has two forked dispatch
 * sections — "Claude Code Dispatch (native agents)" and "Cross-platform
 * Dispatch (non-Claude-Code clients)" — that were hand-maintained to
 * keep Claude and the LCD in sync. The single-source rewrite collapses
 * them into one section driven by the `{{SPAWN_AGENT_CALL}}` placeholder
 * so each runtime's YAML supplies the dispatch primitive that fits it.
 *
 * Ten assertions split between the rewritten source and the six
 * rendered variants guard against regressions:
 *
 *   Source invariants (3):
 *   - `DelegationSource_ContainsNoTaskTool_OnlyPlaceholder`
 *   - `DelegationSource_ContainsNoClaudeNativeSection_CollapsedIntoPlaceholder`
 *   - `DelegationSource_ContainsNoCrossPlatformSection_Unified`
 *
 *   Per-runtime variant behaviour (6):
 *   - `DelegationClaudeVariant_EquivalentBehaviorToPreMigration`
 *   - `DelegationOpenCodeVariant_UsesTaskTool`
 *   - `DelegationCodexVariant_UsesNativePrimitive`
 *   - `DelegationCopilotVariant_UsesDelegateSlashCommand`
 *   - `DelegationCursorVariant_UsesNativeTaskTool`
 *     + `DelegationCursorVariant_NoLongerEmitsSequentialFallback`
 *     (refreshed in Task 7d after Cursor 2.5 shipped native sub-agents).
 *   - `DelegationGenericVariant_SequentialFallback`
 *
 * Implements: DR-1, DR-5, DR-6, DR-8, OQ-2.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllSkills } from '../../src/build-skills.js';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'skills-src');
const RUNTIMES_DIR = join(REPO_ROOT, 'runtimes');

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
  return readFileSync(join(SRC_DIR, 'delegation', 'SKILL.md'), 'utf8');
}

function readVariant(runtime: string): string {
  const p = join(buildIntoTemp(), runtime, 'delegation', 'SKILL.md');
  expect(existsSync(p)).toBe(true);
  return readFileSync(p, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('task 017 — delegation skill refactor', () => {
  // -------------------------------------------------------------------------
  // Source invariants — the rewritten source must not carry Claude-native
  // primitives inline; everything runtime-specific flows through
  // {{SPAWN_AGENT_CALL}}.
  // -------------------------------------------------------------------------

  it('DelegationSource_ContainsNoTaskTool_OnlyPlaceholder', () => {
    const source = readSource();
    // The source must not contain `Task({` anywhere — the dispatch call
    // is driven by the {{SPAWN_AGENT_CALL}} placeholder so that non-Claude
    // runtimes can supply their own primitive (spawn_agent, /delegate,
    // sequential execution, etc.).
    expect(source).not.toContain('Task({');
  });

  it('DelegationSource_ContainsNoClaudeNativeSection_CollapsedIntoPlaceholder', () => {
    const source = readSource();
    // The "Claude Code Dispatch (native agents)" subheading must be gone
    // — its content is the default shape that {{SPAWN_AGENT_CALL}} fills
    // in for the claude runtime.
    expect(source).not.toContain('Claude Code Dispatch (native agents)');
  });

  it('DelegationSource_ContainsNoCrossPlatformSection_Unified', () => {
    const source = readSource();
    // The "Cross-platform Dispatch" subheading must be gone. The unified
    // section treats every runtime equally and lets the placeholder map
    // pick the dispatch primitive.
    expect(source).not.toContain('Cross-platform Dispatch');
  });

  // -------------------------------------------------------------------------
  // Per-runtime variant behaviour — every rendered variant must contain
  // the runtime-specific dispatch primitive that the runtime YAML provides.
  // -------------------------------------------------------------------------

  it('DelegationClaudeVariant_EquivalentBehaviorToPreMigration', () => {
    const rendered = readVariant('claude');
    // After placeholder substitution the claude variant must still have
    // the Task tool with background execution wired up.
    expect(rendered).toContain('Task({');
    expect(rendered).toContain('subagent_type');
    expect(rendered).toContain('run_in_background');
  });

  it('DelegationCursorVariant_UsesNativeTaskTool', () => {
    const rendered = readVariant('cursor');
    // Cursor 2.5+ ships native sub-agents (Task 7d, 2026-04-25): the
    // rendered variant must invoke `Task({ ... })`, not the prior
    // sequential-fallback prose.
    expect(rendered).toContain('Task({');
    expect(rendered).toContain('subagent_type');
  });

  it('DelegationCursorVariant_NoLongerEmitsSequentialFallback', () => {
    const rendered = readVariant('cursor');
    // Guard against regression to the pre-Cursor-2.5 prose-degradation
    // marker. The runtime map no longer claims "no in-session subagent
    // primitive" — that phrase must not leak into the rendered skill.
    expect(rendered).not.toContain('no in-session subagent primitive');
  });

  it('DelegationOpenCodeVariant_UsesTaskTool', () => {
    const rendered = readVariant('opencode');
    // OpenCode mirrors Claude's Task-tool shape minus hooks/memory —
    // the rendered variant must still invoke Task({ ... }).
    expect(rendered).toContain('Task({');
  });

  it('DelegationCodexVariant_UsesNativePrimitive', () => {
    const rendered = readVariant('codex');
    // Codex CLI exposes `spawn_agent` as its native multi-agent primitive
    // (documented in codex-rs/tools/src/agent_tool.rs). The rendered
    // variant must substitute in the literal token `spawn_agent`.
    expect(rendered).toContain('spawn_agent');
  });

  it('DelegationCopilotVariant_UsesDelegateSlashCommand', () => {
    const rendered = readVariant('copilot');
    // Copilot CLI uses `/delegate` as the documented async delegation
    // primitive. The rendered variant must contain the slash command.
    expect(rendered).toContain('/delegate');
  });

  it('DelegationGenericVariant_SequentialFallback', () => {
    const rendered = readVariant('generic');
    // The generic LCD variant has no spawn primitive — it must fall back
    // to a sequential execution directive.
    expect(rendered.toLowerCase()).toContain('sequentially');
  });
});
