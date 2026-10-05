/**
 * Tests for the native-baseline harness, over three captured `claude -p` transcripts in
 * `fixtures/`.
 *
 * - Parser: the harness extracts the model and the tokens of each subagent, and it computes the
 *   model distribution. Each delegation fixture holds three `general-purpose` subagents on
 *   `claude-sonnet-5`.
 * - Blocked outcome: a transcript with no delegation gives a `blocked` record. The record holds
 *   the reason and no `modelDistribution`, even when the transcript has a `result.modelUsage`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseStreamJson,
  extractSubagents,
  resolveSubagentModels,
  extractSessionModelUsage,
  computeModelDistribution,
  buildNativeBaselineRecord,
  finalizeRecord,
  toDistributionCsv,
  buildDelegationPrompt,
  buildClaudeArgs,
  runNativeBaseline,
  type NativeBaselineRecord,
  type SubagentObservation,
  type ClaudeRunner,
} from './harness.js';
import type { Provenance } from '../../../tools/evals/evals/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const DELEG_TRANSCRIPT = fs.readFileSync(
  path.join(FIXTURES, 'delegation-sonnet-3subagents.jsonl'),
  'utf-8',
);
/** The second captured shape: the subagents ran, but the transcript holds none of their `assistant` messages. */
const NOTIF_ONLY_TRANSCRIPT = fs.readFileSync(
  path.join(FIXTURES, 'delegation-sonnet-notification-only.jsonl'),
  'utf-8',
);
const NO_DELEG_TRANSCRIPT = fs.readFileSync(
  path.join(FIXTURES, 'no-delegation-direct-answer.jsonl'),
  'utf-8',
);

/** Build a SubagentObservation for synthetic distribution tests. */
function sub(model: string | null, source: SubagentObservation['modelSource']): SubagentObservation {
  return {
    toolUseId: `toolu_${Math.random().toString(36).slice(2, 8)}`,
    taskId: null,
    subagentType: 'general-purpose',
    description: null,
    model,
    modelSource: source,
    tokens: { total: 1, input: 1, output: 1 },
    toolUses: 0,
    toolNames: [],
    status: 'completed',
    finalSummary: null,
  };
}

const PROV: Provenance = {
  binaryTag: 'claude-code-2.1.206',
  gitSha: 'a240b4d8',
  modelIds: ['claude-sonnet-5'],
  date: '2026-07-09',
};

describe('extractSubagents — recorded `claude -p` delegation fixture (DR-3)', () => {
  it('parses the stream-json transcript with no malformed lines', () => {
    const { events, malformed } = parseStreamJson(DELEG_TRANSCRIPT);
    expect(malformed).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it('extracts exactly the three dispatched subagents', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const subs = extractSubagents(events);
    expect(subs).toHaveLength(3);
    for (const s of subs) {
      expect(s.subagentType).toBe('general-purpose');
      expect(s.status).toBe('completed');
      expect(s.toolUseId).toMatch(/^toolu_/);
      expect(s.finalSummary).toBeTruthy();
    }
  });

  it('attributes the model native assigned to EACH subagent DIRECTLY (all claude-sonnet-5 — inherited)', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const subs = extractSubagents(events);
    expect(subs.map((s) => s.model)).toEqual([
      'claude-sonnet-5',
      'claude-sonnet-5',
      'claude-sonnet-5',
    ]);
    expect(subs.every((s) => s.modelSource === 'assistant')).toBe(true);
  });

  /** The captured notifications hold the totals 42423, 42423 and 42438. */
  it('attributes per-subagent token spend from the task_notification totals', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const subs = extractSubagents(events);
    const totals = subs.map((s) => s.tokens.total);
    for (const t of totals) expect(t).toBeGreaterThan(40_000);
    expect(totals).toContain(42438);
    for (const s of subs) expect(s.tokens.input).toBeGreaterThan(0);
  });

  it('does NOT misattribute the main agent (parent_tool_use_id=null) as a subagent', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const subs = extractSubagents(events);
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s.toolUseId.length > 0)).toBe(true);
  });
});

describe('computeModelDistribution — the spike headline (DR-3)', () => {
  it('reports a single inherited model across all subagents', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const dist = computeModelDistribution(extractSubagents(events));
    expect(dist.perModel).toEqual({ 'claude-sonnet-5': 3 });
    expect(dist.distinctModelCount).toBe(1);
    expect(dist.inheritsSingleModel).toBe(true);
    expect(dist.unattributed).toBe(0);
    expect(dist.attributionMode).toBe('per-subagent');
  });

  it('flags a mix as NOT inherited (guards the boolean against a false positive)', () => {
    const mixed = computeModelDistribution([sub('claude-opus-4', 'assistant'), sub('claude-haiku-4-5', 'assistant')]);
    expect(mixed.distinctModelCount).toBe(2);
    expect(mixed.inheritsSingleModel).toBe(false);
  });

  it('does NOT claim inherited-single when a subagent is unattributed (partial capture)', () => {
    const partial = computeModelDistribution([sub('claude-sonnet-5', 'assistant'), sub(null, 'unresolved')]);
    expect(partial.unattributed).toBe(1);
    expect(partial.inheritsSingleModel).toBe(false);
    expect(partial.attributionMode).toBe('mixed');
  });
});

describe('resolveSubagentModels — session-single fallback (DR-3, robustness)', () => {
  it('detects the 3 subagents even when their assistant messages were not streamed', () => {
    const { events } = parseStreamJson(NOTIF_ONLY_TRANSCRIPT);
    const raw = extractSubagents(events);
    expect(raw).toHaveLength(3);
    expect(raw.every((s) => s.model === null && s.modelSource === 'unresolved')).toBe(true);
    expect(raw.every((s) => (s.tokens.total ?? 0) > 40_000)).toBe(true);
  });

  it('back-fills each subagent from the sole session model (measured inference, not a guess)', () => {
    const { events } = parseStreamJson(NOTIF_ONLY_TRANSCRIPT);
    const raw = extractSubagents(events);
    const resolved = resolveSubagentModels(raw, extractSessionModelUsage(events));
    expect(resolved.map((s) => s.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5']);
    expect(resolved.every((s) => s.modelSource === 'session-single')).toBe(true);
  });

  it('leaves a subagent UNRESOLVED when the session used more than one model (never guesses)', () => {
    const { events } = parseStreamJson(NOTIF_ONLY_TRANSCRIPT);
    const raw = extractSubagents(events);
    const resolved = resolveSubagentModels(raw, { 'claude-opus-4': {}, 'claude-sonnet-5': {} });
    expect(resolved.every((s) => s.model === null && s.modelSource === 'unresolved')).toBe(true);
  });

  it('the whole notification-only transcript still yields the inherited-single finding', () => {
    const record = buildNativeBaselineRecord({ events: parseStreamJson(NOTIF_ONLY_TRANSCRIPT).events, specRef: 'x' });
    expect(record.outcome).toBe('measured');
    if (record.outcome !== 'measured') throw new Error('unreachable');
    expect(record.subagents).toHaveLength(3);
    expect(record.modelDistribution.perModel).toEqual({ 'claude-sonnet-5': 3 });
    expect(record.modelDistribution.inheritsSingleModel).toBe(true);
    expect(record.modelDistribution.attributionMode).toBe('session-single');
  });
});

describe('extractSessionModelUsage', () => {
  it('lifts the terminal result.modelUsage aggregate (one model key)', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const usage = extractSessionModelUsage(events);
    expect(Object.keys(usage)).toEqual(['claude-sonnet-5']);
    expect(usage['claude-sonnet-5']?.outputTokens).toBeGreaterThan(0);
  });
});

describe('buildNativeBaselineRecord — measured branch (DR-3)', () => {
  it('produces a MEASURED record with the derived distribution when native delegated', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const record = buildNativeBaselineRecord({ events, specRef: 'docs/specs/example.md' });
    expect(record.outcome).toBe('measured');
    if (record.outcome !== 'measured') throw new Error('unreachable');
    expect(record.subagents).toHaveLength(3);
    expect(record.modelDistribution.perModel).toEqual({ 'claude-sonnet-5': 3 });
    expect(record.modelDistribution.inheritsSingleModel).toBe(true);
    expect(Object.keys(record.sessionModelUsage)).toEqual(['claude-sonnet-5']);
  });
});

describe('buildNativeBaselineRecord — fail-honest blocked branch (DR-7)', () => {
  it('emits a BLOCKED record when native never delegated', () => {
    const { events } = parseStreamJson(NO_DELEG_TRANSCRIPT);
    const record = buildNativeBaselineRecord({
      events,
      specRef: 'docs/specs/example.md',
      attempted: ['claude -p', 'claude agent SDK'],
    });
    expect(record.outcome).toBe('blocked');
    if (record.outcome !== 'blocked') throw new Error('unreachable');
    expect(record.reason).toMatch(/deleg/i);
    expect(record.attempted).toContain('claude agent SDK');
    expect(record.subagents).toHaveLength(0);
  });

  /**
   * The no-delegation fixture holds a `result.modelUsage` with one haiku entry. The record must
   * not turn that entry into a distribution, because the distribution counts subagents and the
   * transcript shows none.
   */
  it('NEVER fabricates a model distribution on the blocked path — even with a session modelUsage present', () => {
    const { events } = parseStreamJson(NO_DELEG_TRANSCRIPT);
    expect(extractSessionModelUsage(events)['claude-haiku-4-5-20251001']).toBeDefined();

    const record = buildNativeBaselineRecord({ events, specRef: 'x' });
    expect(record.outcome).toBe('blocked');
    expect('modelDistribution' in record).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'modelDistribution')).toBe(false);
  });

  it('is the ONLY outcome reachable without observed delegation (no measured-with-zero-subagents)', () => {
    const empty = buildNativeBaselineRecord({ events: [], specRef: 'x' });
    expect(empty.outcome).toBe('blocked');
    expect('modelDistribution' in empty).toBe(false);
  });
});

describe('finalizeRecord — pins provenance and rejects modeled substitutes (DR-7)', () => {
  it('stamps provenance onto a measured record', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const record = buildNativeBaselineRecord({ events, specRef: 'x' });
    const stamped = finalizeRecord(record, PROV);
    expect(stamped.provenance.gitSha).toBe('a240b4d8');
    expect(stamped.provenance.modelIds).toEqual(['claude-sonnet-5']);
  });

  it('stamps provenance onto a blocked record (an honest measured negative is admissible)', () => {
    const { events } = parseStreamJson(NO_DELEG_TRANSCRIPT);
    const record = buildNativeBaselineRecord({ events, specRef: 'x' });
    const stamped = finalizeRecord(record, PROV);
    expect(stamped.outcome).toBe('blocked');
    expect(stamped.provenance.date).toBe('2026-07-09');
  });

  it('rejects a record self-flagged `modeled` (the #1669 sin the guard exists to block)', () => {
    const modeled = {
      outcome: 'blocked',
      source: 'modeled',
      specRef: 'x',
      reason: 'fabricated',
      attempted: [],
      subagents: [],
    } as unknown as NativeBaselineRecord;
    expect(() => finalizeRecord(modeled, PROV)).toThrow(/measured/i);
  });
});

describe('toDistributionCsv', () => {
  it('emits per-(subagent_type,model) counts for a measured record', () => {
    const { events } = parseStreamJson(DELEG_TRANSCRIPT);
    const csv = toDistributionCsv(buildNativeBaselineRecord({ events, specRef: 'x' }));
    expect(csv).toContain('subagent_type,model,subagents');
    expect(csv).toContain('general-purpose,claude-sonnet-5,3');
  });

  it('emits only a BLOCKED marker row (no model rows) for a blocked record', () => {
    const { events } = parseStreamJson(NO_DELEG_TRANSCRIPT);
    const csv = toDistributionCsv(buildNativeBaselineRecord({ events, specRef: 'x' }));
    expect(csv).toContain('BLOCKED,,0');
    expect(csv).not.toMatch(/claude-/);
  });
});

describe('buildDelegationPrompt / buildClaudeArgs', () => {
  it('embeds the spec as the plan and instructs Task-tool delegation', () => {
    const prompt = buildDelegationPrompt('### Task 1\nDo the thing.');
    expect(prompt).toContain('Do the thing.');
    expect(prompt).toMatch(/Task tool/);
    expect(prompt).toMatch(/subagent/i);
  });

  it('builds the stream-json argv with model + allowed tools + skip-permissions', () => {
    const args = buildClaudeArgs({
      prompt: 'P',
      model: 'sonnet',
      maxTurns: 8,
      allowedTools: ['Task'],
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain('-p');
    expect(args.join(' ')).toContain('--output-format stream-json');
    expect(args).toContain('--verbose');
    expect(args.slice(args.indexOf('--model') + 1, args.indexOf('--model') + 2)).toEqual(['sonnet']);
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Task');
    expect(args).toContain('--dangerously-skip-permissions');
  });
});

/** Each test injects a runner, so no test starts the real `claude` CLI. */
describe('runNativeBaseline — driver over an injected runner (DR-3 / DR-7)', () => {
  it('returns a MEASURED record when the runner yields a delegation transcript', async () => {
    const runner: ClaudeRunner = async () => ({ stdout: DELEG_TRANSCRIPT, stderr: '', exitCode: 0 });
    const { record, malformedLines } = await runNativeBaseline({
      specText: 'plan', specRef: 'x', runner,
    });
    expect(malformedLines).toBe(0);
    expect(record.outcome).toBe('measured');
    if (record.outcome === 'measured') expect(record.subagents).toHaveLength(3);
  });

  it('returns a BLOCKED record when the runner yields a no-delegation transcript', async () => {
    const runner: ClaudeRunner = async () => ({ stdout: NO_DELEG_TRANSCRIPT, stderr: '', exitCode: 0 });
    const { record } = await runNativeBaseline({ specText: 'plan', specRef: 'x', runner });
    expect(record.outcome).toBe('blocked');
    expect('modelDistribution' in record).toBe(false);
  });

  it('returns a BLOCKED record when claude fails to launch (fail-honest)', async () => {
    const runner: ClaudeRunner = async () => {
      throw new Error('spawn claude ENOENT');
    };
    const { record } = await runNativeBaseline({ specText: 'plan', specRef: 'x', runner });
    expect(record.outcome).toBe('blocked');
    if (record.outcome === 'blocked') expect(record.reason).toMatch(/failed to launch/i);
  });

  it('returns a BLOCKED record when claude exits non-zero with no delegation', async () => {
    const runner: ClaudeRunner = async () => ({ stdout: '', stderr: 'api error', exitCode: 1 });
    const { record } = await runNativeBaseline({ specText: 'plan', specRef: 'x', runner });
    expect(record.outcome).toBe('blocked');
    if (record.outcome === 'blocked') expect(record.reason).toMatch(/exited 1/);
  });
});
