// The call-shape extractor and census over hand-built fixtures.
//
// The live census can only show that today's skills resolve. These cases show
// the instrument can fail: an unregistered action is refused rather than
// counted, a removed call stops resolving rather than counting as zero, a new
// call nobody placed is reported, and a path with nothing to count is refused.

import { describe, it, expect } from 'vitest';
import { extractSites, type RegistrySnapshot, type RunbookLike } from '../../tools/audit/core/call-shape/extract.js';
import {
  buildCallShapeCensus,
  serializeCallShapeCensus,
  type CensusInputs,
  type CensusModel,
  type IntentModel,
} from '../../tools/audit/core/call-shape/census.js';

const REGISTRY: RegistrySnapshot = {
  counts: { tools: 2, visibleTools: 2, actions: 7 },
  tools: [
    { name: 'exarchos_orchestrate', hidden: false, actions: ['check_gate', 'describe', 'finish', 'runbook'] },
    { name: 'exarchos_workflow', hidden: false, actions: ['describe', 'transition', 'update'] },
  ],
};

const RUNBOOK: RunbookLike = {
  id: 'fixture-chain',
  phase: 'fixture',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'finish' },
    { tool: 'native:Task', action: 'spawn' },
    { tool: 'none', action: 'decide' },
  ],
};

const SKILL_PATH = 'fixture/SKILL.md';

const FIXTURE = [
  '# Fixture skill',
  '',
  'Fetch the chain: `exarchos_orchestrate({ action: "runbook", id: "fixture-chain" })`',
  '',
  '```typescript',
  'mcp__plugin_exarchos_exarchos__exarchos_orchestrate({',
  '  action: "check_gate",',
  '  target: "one"',
  '})',
  '```',
  '',
  'For each task, spawn: {{SPAWN_AGENT_CALL agent="implementer" prompt="x"}}',
  '',
  'Record it via `exarchos_workflow update` with the result.',
  '',
  '```text',
  'action: "transition", target: "done"',
  '```',
  '',
  'On failure, re-run: `exarchos_orchestrate({ action: "check_gate", target: "two" })`',
  '',
].join('\n');

const INTENT: IntentModel = {
  id: 'fixture',
  source: 'fx',
  boundary: { label: 'transition to done', cite: { source: 'fx', needle: 'target: "done"' } },
  normal: [
    { kind: 'site', ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "one"' } },
    { kind: 'site', ref: { source: 'fx', call: 'native:SPAWN_AGENT_CALL', at: 'agent="implementer"' }, per: 'perTask' },
    {
      kind: 'runbook',
      id: 'fixture-chain',
      via: { source: 'fx', call: 'exarchos_orchestrate.runbook', at: 'id: "fixture-chain"' },
      per: 'perTask',
      why: 'the chain runs for each task',
    },
    { kind: 'site', ref: { source: 'fx', call: 'exarchos_workflow.update', at: '`exarchos_workflow update`' } },
    { kind: 'site', ref: { source: 'fx', call: 'exarchos_workflow.transition', at: 'action: "transition"' } },
  ],
  exceptions: [
    {
      id: 'gate-fails',
      label: 'the gate fails and is re-run',
      trigger: { source: 'fx', needle: 'On failure, re-run:' },
      through: 'exarchos_orchestrate.check_gate',
      extra: [{ kind: 'site', ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "two"' } }],
      reentersNormalPath: false,
      why: 'one re-run',
    },
  ],
  conditional: [],
  excluded: [],
};

function modelWith(intent: IntentModel): CensusModel {
  return { sources: { fx: SKILL_PATH }, intents: [intent] };
}

function inputsFor(text: string): CensusInputs {
  return {
    pinnedFiles: { [SKILL_PATH]: text },
    runbooks: [RUNBOOK],
    runbookSource: 'fixture/runbooks.ts',
    registry: REGISTRY,
    registrySource: 'fixture/registry.json',
    contractLockSource: 'fixture/lock.json',
    actionIdRegistryDigest: null,
  };
}

describe('call-shape extractor', () => {
  it('CallShapeExtractor_EachSpelling_IsLocatedWithItsToolAndAction', () => {
    const sites = extractSites(FIXTURE, REGISTRY).map(({ line, endLine, call, pattern, status, runbookId }) => ({
      line,
      endLine,
      call,
      pattern,
      status,
      runbookId,
    }));
    expect(sites).toEqual([
      { line: 3, endLine: 3, call: 'exarchos_orchestrate.runbook', pattern: 'call-expression', status: 'registered', runbookId: 'fixture-chain' },
      { line: 6, endLine: 9, call: 'exarchos_orchestrate.check_gate', pattern: 'call-expression', status: 'registered', runbookId: null },
      { line: 12, endLine: 12, call: 'native:SPAWN_AGENT_CALL', pattern: 'harness-placeholder', status: 'harness', runbookId: null },
      { line: 14, endLine: 14, call: 'exarchos_workflow.update', pattern: 'tool-verb-span', status: 'registered', runbookId: null },
      { line: 17, endLine: 17, call: 'exarchos_workflow.transition', pattern: 'bare-action-key', status: 'registered', runbookId: null },
      { line: 20, endLine: 20, call: 'exarchos_orchestrate.check_gate', pattern: 'call-expression', status: 'registered', runbookId: null },
    ]);
  });

  it('CallShapeExtractor_ProseSpellings_ResolveOrFlagWithoutCountingMentions', () => {
    const text = [
      '`exarchos:exarchos_workflow` `action: "transition"` after review.',
      'Then `exarchos_workflow` `set` the phase.',
      'A bare `action: "describe"` names no single tool.',
      'Manual `exarchos_workflow` calls are not needed.',
      '```bash',
      'git push',
      '```',
      '{{TASK_TOOL}} is prose; {{SUBAGENT_RESULT_API}} is a call.',
    ].join('\n');
    expect(extractSites(text, REGISTRY).map(({ line, endLine, call, status }) => ({ line, endLine, call, status }))).toEqual([
      { line: 1, endLine: 1, call: 'exarchos_workflow.transition', status: 'registered' },
      { line: 2, endLine: 2, call: 'exarchos_workflow.set', status: 'unregistered' },
      { line: 3, endLine: 3, call: '?.describe', status: 'ambiguous' },
      { line: 5, endLine: 7, call: 'native:Bash', status: 'harness' },
      { line: 8, endLine: 8, call: 'native:SUBAGENT_RESULT_API', status: 'harness' },
    ]);
  });
});

describe('call-shape extractor inside fences', () => {
  it('CallShapeExtractor_TokensInsideAShellFence_AreOneHarnessCallNotSeveral', () => {
    const text = [
      '```bash',
      'echo \'exarchos_orchestrate({ action: "finish" })\'',
      'echo \'action: "update"\' {{SPAWN_AGENT_CALL agent="x"}}',
      '```',
      '',
      '```typescript',
      'exarchos_orchestrate({ action: "finish" })',
      '```',
    ].join('\n');
    expect(
      extractSites(text, REGISTRY).map(({ line, endLine, call, pattern }) => ({ line, endLine, call, pattern })),
    ).toEqual([
      { line: 1, endLine: 4, call: 'native:Bash', pattern: 'shell-fence' },
      { line: 7, endLine: 7, call: 'exarchos_orchestrate.finish', pattern: 'call-expression' },
    ]);
  });
});

describe('call-shape census', () => {
  it('CallShapeCensus_FixtureModel_CountsLoopsAsFormulas', () => {
    const { census, errors } = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(INTENT));
    expect(errors).toEqual([]);
    const [intent] = census.intents;
    expect(intent?.normal.calls.map((call) => `${call.call}/${call.role}/${call.per}`)).toEqual([
      'exarchos_orchestrate.check_gate/work/once',
      'native:SPAWN_AGENT_CALL/native/perTask',
      'exarchos_orchestrate.runbook/runbook-fetch/perTask',
      'exarchos_orchestrate.finish/work/perTask',
      'native:Task.spawn/native/perTask',
      'exarchos_workflow.update/work/once',
      'exarchos_workflow.transition/work/once',
    ]);
    expect(intent?.normal.counts.exarchos).toEqual({ fixed: 3, perTask: 1, perPr: 0, formula: '3 + 1*tasks', atUnit: 4 });
    expect(intent?.normal.counts.runbookFetch.formula).toBe('1*tasks');
    expect(intent?.normal.counts.native.formula).toBe('2*tasks');
    expect(intent?.normal.counts.exarchosWithDiscovery.formula).toBe('3 + 2*tasks');
    expect(intent?.exceptions[0]?.counts.exarchos.formula).toBe('2');
    expect(census.sites[SKILL_PATH]?.every((site) => site.dispositions.length > 0)).toBe(true);
  });

  it('CallShapeCensus_CountedUnknownAction_IsRefusedNotCounted', () => {
    const seeded = FIXTURE.replace('action: "check_gate",\n  target: "one"', 'action: "check_gatee",\n  target: "one"');
    const intent: IntentModel = {
      ...INTENT,
      normal: [
        { kind: 'site', ref: { source: 'fx', call: 'exarchos_orchestrate.check_gatee', at: 'target: "one"' } },
        ...INTENT.normal.slice(1),
      ],
      exceptions: [],
      excluded: [
        {
          ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "two"' },
          kind: 'restatement',
          why: 'fixture',
        },
      ],
    };
    const { errors } = buildCallShapeCensus(inputsFor(seeded), modelWith(intent));
    expect(errors.filter((error) => error.startsWith('UNREGISTERED_STEP'))).toHaveLength(1);
  });

  it('CallShapeCensus_StaleSpellingExcludedByName_IsReportedAsAFinding', () => {
    const text = `${FIXTURE}Old spelling: \`exarchos_workflow\` \`set\`.\n`;
    const intent: IntentModel = {
      ...INTENT,
      excluded: [
        {
          ref: { source: 'fx', call: 'exarchos_workflow.set', at: 'Old spelling' },
          kind: 'stale-unregistered',
          why: 'fixture',
        },
      ],
    };
    const { census, errors } = buildCallShapeCensus(inputsFor(text), modelWith(intent));
    expect(errors).toEqual([]);
    expect(census.findings.unregisteredSites.map((site) => `${site.call}@${site.line}`)).toEqual(['exarchos_workflow.set@21']);
  });

  it('CallShapeCensus_RemovedCall_FailsToResolveRatherThanCountingZero', () => {
    const removed = FIXTURE.replace(
      '```typescript\nmcp__plugin_exarchos_exarchos__exarchos_orchestrate({\n  action: "check_gate",\n  target: "one"\n})\n```\n',
      '',
    );
    const { errors } = buildCallShapeCensus(inputsFor(removed), modelWith(INTENT));
    expect(errors.some((error) => error.startsWith('UNRESOLVED_SITE_REF'))).toBe(true);
  });

  it('CallShapeCensus_NewCallNobodyPlaced_IsReportedUndispositioned', () => {
    const added = `${FIXTURE}Also run \`exarchos_orchestrate({ action: "finish" })\`.\n`;
    const { errors } = buildCallShapeCensus(inputsFor(added), modelWith(INTENT));
    expect(errors).toEqual([
      'UNDISPOSITIONED_SITE fixture/SKILL.md:21 exarchos_orchestrate.finish is on no path and excluded by no judgement',
    ]);
  });

  it('CallShapeCensus_NormalPathWithNoExarchosCall_IsRefusedAsVacuous', () => {
    const intent: IntentModel = {
      ...INTENT,
      normal: [INTENT.normal[1] ?? INTENT.normal[0]!],
      exceptions: [],
      excluded: [
        { ref: { source: 'fx', call: 'exarchos_orchestrate.runbook', at: 'id: "fixture-chain"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "one"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "two"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_workflow.update', at: '`exarchos_workflow update`' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_workflow.transition', at: 'action: "transition"' }, kind: 'restatement', why: 'fixture' },
      ],
    };
    const { errors } = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(intent));
    expect(errors.some((error) => error.startsWith('EMPTY_NORMAL_PATH fixture'))).toBe(true);
  });

  it('CallShapeCensus_PathCountedOnlyFromMentions_IsRefusedAsUnlocated', () => {
    const intent: IntentModel = {
      ...INTENT,
      normal: [
        {
          kind: 'mention',
          call: 'exarchos_orchestrate.finish',
          cite: { source: 'fx', needle: 'On failure, re-run:' },
          why: 'counted without the extractor locating anything',
        },
      ],
      exceptions: [],
      excluded: [
        { ref: { source: 'fx', call: 'exarchos_orchestrate.runbook', at: 'id: "fixture-chain"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "one"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'native:SPAWN_AGENT_CALL', at: 'agent="implementer"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_workflow.update', at: '`exarchos_workflow update`' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_workflow.transition', at: 'action: "transition"' }, kind: 'restatement', why: 'fixture' },
        { ref: { source: 'fx', call: 'exarchos_orchestrate.check_gate', at: 'target: "two"' }, kind: 'restatement', why: 'fixture' },
      ],
    };
    const { census, errors } = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(intent));
    expect(census.intents[0]?.normal.counts.exarchos.atUnit).toBe(1);
    expect(errors).toEqual([
      'NORMAL_PATH_UNLOCATED fixture: no call on the normal path was located in its source, so the count does not depend on the extractor reading it',
    ]);
  });

  it('CallShapeCensus_UnexpandedRunbookFetch_ReportsCallsOnOnlyOneSide', () => {
    const intent: IntentModel = {
      ...INTENT,
      normal: [
        { kind: 'site', ref: { source: 'fx', call: 'exarchos_orchestrate.runbook', at: 'id: "fixture-chain"' } },
        ...INTENT.normal.filter((step) => step.kind !== 'runbook'),
      ],
    };
    const { census, errors } = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(intent));
    expect(errors).toEqual([]);
    expect(census.findings.runbookDivergence).toEqual([
      {
        intent: 'fixture',
        runbook: 'fixture-chain',
        fetchedAt: { source: SKILL_PATH, line: 3 },
        onlyInRunbook: ['exarchos_orchestrate.finish', 'native:Task.spawn'],
        onlyInProse: [
          'exarchos_orchestrate.check_gate',
          'exarchos_workflow.transition',
          'exarchos_workflow.update',
          'native:SPAWN_AGENT_CALL',
        ],
      },
    ]);
  });

  it('CallShapeCensus_RosterDisagreeingWithTheContractLock_IsRefused', () => {
    const matching = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(INTENT)).census.pins.registry.actionIdsSha256;
    const agreeing = buildCallShapeCensus(
      { ...inputsFor(FIXTURE), actionIdRegistryDigest: `sha256:${matching}` },
      modelWith(INTENT),
    );
    expect(agreeing.errors).toEqual([]);
    const diverging = buildCallShapeCensus(
      { ...inputsFor(FIXTURE), actionIdRegistryDigest: `sha256:${'0'.repeat(64)}` },
      modelWith(INTENT),
    );
    expect(diverging.errors.some((error) => error.startsWith('REGISTRY_DIVERGES_FROM_CONTRACT_LOCK'))).toBe(true);
  });

  it('CallShapeCensus_Serialization_SortsKeysAndIsStable', () => {
    const { census } = buildCallShapeCensus(inputsFor(FIXTURE), modelWith(INTENT));
    const first = serializeCallShapeCensus(census);
    expect(serializeCallShapeCensus(buildCallShapeCensus(inputsFor(FIXTURE), modelWith(INTENT)).census)).toBe(first);
    const keys = Object.keys(JSON.parse(first) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(first.endsWith('}\n')).toBe(true);
  });
});
