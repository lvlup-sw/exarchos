import { describe, it, expect } from 'vitest';
import {
  SurfaceSchema,
  PlanStepSchema,
  DesiredStateSchema,
  ReconcilePlanSchema,
  ReconcileResultSchema,
  AdvisorySchema,
  ResolvedCommandsSchema,
  type Surface,
  type PlanStep,
  type DesiredState,
  type ReconcilePlan,
  type ReconcileResult,
  type Advisory,
  type ResolvedCommands,
} from './types.js';

// A valid PlanStep reused by several cases below.
const validStep: PlanStep = {
  kind: 'install',
  surface: 'cli-only',
  key: 'install-skills',
  description: 'Install the Exarchos skills bundle',
  target: 'skills/',
};

describe('ReconcileTypes_PlanStepSurface_TaggedCliOnly', () => {
  it('SurfaceSchema accepts the two known surfaces and rejects others', () => {
    expect(SurfaceSchema.parse('any')).toBe('any');
    expect(SurfaceSchema.parse('cli-only')).toBe('cli-only');

    // Reject anything outside the closed set.
    expect(SurfaceSchema.safeParse('mcp-only').success).toBe(false);
    expect(SurfaceSchema.safeParse('').success).toBe(false);
    expect(SurfaceSchema.safeParse(42).success).toBe(false);

    // Type-level: Surface is exactly the union.
    const s: Surface = 'cli-only';
    expect(s).toBe('cli-only');
  });

  it('PlanStep enforces the kind enum and the surface tag (cli-only gates install)', () => {
    const parsed = PlanStepSchema.parse(validStep);
    expect(parsed.kind).toBe('install');
    expect(parsed.surface).toBe('cli-only');
    expect(parsed.key).toBe('install-skills');
    expect(parsed.description).toBe('Install the Exarchos skills bundle');
    expect(parsed.target).toBe('skills/');

    // target is optional.
    const noTarget = PlanStepSchema.parse({
      kind: 'config',
      surface: 'any',
      key: 'write-exarchos-yml',
      description: 'Reconcile .exarchos.yml',
    });
    expect(noTarget.target).toBeUndefined();

    // Each declared kind is accepted.
    for (const kind of ['config', 'generate', 'install', 'hook'] as const) {
      expect(
        PlanStepSchema.safeParse({
          kind,
          surface: 'any',
          key: `k-${kind}`,
          description: `step ${kind}`,
        }).success,
      ).toBe(true);
    }

    // Reject an unknown kind.
    expect(
      PlanStepSchema.safeParse({
        kind: 'delete',
        surface: 'any',
        key: 'k',
        description: 'd',
      }).success,
    ).toBe(false);

    // Reject an unknown surface on a PlanStep.
    expect(
      PlanStepSchema.safeParse({
        kind: 'install',
        surface: 'mcp-only',
        key: 'k',
        description: 'd',
      }).success,
    ).toBe(false);

    // Reject a step missing required fields.
    expect(PlanStepSchema.safeParse({ kind: 'install', surface: 'cli-only' }).success).toBe(false);
  });

  it('DesiredState parses detected runtimes/vcs + resolver-derived commands and rejects malformed', () => {
    const desired: DesiredState = {
      runtimes: ['claude-code', 'codex'],
      vcs: 'git',
      commands: { test: 'npm run test:run', typecheck: 'tsc --noEmit', install: 'npm install' },
    };
    const parsed = DesiredStateSchema.parse(desired);
    expect(parsed.runtimes).toEqual(['claude-code', 'codex']);
    expect(parsed.vcs).toBe('git');
    expect(parsed.commands.test).toBe('npm run test:run');

    // Commands are all optional (resolver may not derive every field).
    const partial = DesiredStateSchema.parse({
      runtimes: [],
      vcs: 'none',
      commands: {},
    });
    expect(partial.commands.test).toBeUndefined();

    // Malformed: runtimes must be string[].
    expect(
      DesiredStateSchema.safeParse({ runtimes: [1, 2], vcs: 'git', commands: {} }).success,
    ).toBe(false);

    // Malformed: a command must be a string when present.
    expect(
      DesiredStateSchema.safeParse({
        runtimes: [],
        vcs: 'git',
        commands: { test: 123 },
      }).success,
    ).toBe(false);
  });

  it('ResolvedCommandsSchema_MutationAndLint_Optional', () => {
    // Task 007 (design §4.5-detect): the schema widens to the verification-ladder
    // field set so onboard/doctor surface `mutation` and `lint`. Both new fields
    // carry the SAME optionality semantics as the legacy three.

    // Accepts BOTH new fields alongside the legacy three, round-tripping unchanged.
    const both = ResolvedCommandsSchema.safeParse({
      test: 'npm run test:run',
      typecheck: 'tsc --noEmit',
      install: 'npm install',
      mutation: 'npx stryker run',
      lint: 'eslint .',
    });
    expect(both.success).toBe(true);
    if (both.success) {
      expect(both.data).toEqual({
        test: 'npm run test:run',
        typecheck: 'tsc --noEmit',
        install: 'npm install',
        mutation: 'npx stryker run',
        lint: 'eslint .',
      });
    }

    // Accepts NEITHER new field — both are optional, so the legacy-only object
    // (and the empty object) remain valid with the new fields simply absent.
    const neither = ResolvedCommandsSchema.safeParse({ test: 'npm run test:run' });
    expect(neither.success).toBe(true);
    if (neither.success) {
      expect('mutation' in neither.data).toBe(false);
      expect('lint' in neither.data).toBe(false);
      expect(neither.data).toEqual({ test: 'npm run test:run' });
    }

    // Accepts mutation alone (one new field present, the other absent).
    const mutationOnly = ResolvedCommandsSchema.parse({ mutation: 'npx stryker run' });
    expect(mutationOnly.mutation).toBe('npx stryker run');
    expect('lint' in mutationOnly).toBe(false);

    // Malformed: a new field must be a string when present (same as legacy).
    expect(ResolvedCommandsSchema.safeParse({ mutation: 123 }).success).toBe(false);
    expect(ResolvedCommandsSchema.safeParse({ lint: false }).success).toBe(false);

    // Type-level: the inferred type carries optional mutation/lint of type string.
    const typed: ResolvedCommands = { mutation: 'npx stryker run', lint: 'eslint .' };
    expect(typed.mutation).toBe('npx stryker run');
    expect(typed.lint).toBe('eslint .');
  });

  it('Advisory parses the cli-only install advisory and rejects malformed', () => {
    const advisory: Advisory = {
      surface: 'cli-only',
      message: 'Install the Exarchos MCP server via the CLI',
      commands: ['exarchos onboard'],
    };
    const parsed = AdvisorySchema.parse(advisory);
    expect(parsed.surface).toBe('cli-only');
    expect(parsed.message).toBe('Install the Exarchos MCP server via the CLI');
    expect(parsed.commands).toEqual(['exarchos onboard']);

    // commands is optional.
    const noCommands = AdvisorySchema.parse({ surface: 'any', message: 'fyi' });
    expect(noCommands.commands).toBeUndefined();

    // Malformed: message is required.
    expect(AdvisorySchema.safeParse({ surface: 'any' }).success).toBe(false);
  });

  it('ReconcilePlan parses valid steps, the empty plan, and rejects malformed', () => {
    const plan: ReconcilePlan = { steps: [validStep] };
    const parsed = ReconcilePlanSchema.parse(plan);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]?.surface).toBe('cli-only');

    // The empty plan is valid (idempotence: apply over it is a no-op).
    const empty = ReconcilePlanSchema.parse({ steps: [] });
    expect(empty.steps).toHaveLength(0);

    // Malformed: a non-array steps field.
    expect(ReconcilePlanSchema.safeParse({ steps: validStep }).success).toBe(false);

    // Malformed: a step inside the plan that is itself invalid.
    expect(
      ReconcilePlanSchema.safeParse({ steps: [{ kind: 'install', surface: 'cli-only' }] }).success,
    ).toBe(false);
  });

  it('ReconcileResult parses the four step buckets + advisories and rejects malformed', () => {
    const result: ReconcileResult = {
      applied: [validStep],
      skipped: [],
      residual: [],
      advisories: [{ surface: 'cli-only', message: 'install via CLI', commands: ['exarchos onboard'] }],
    };
    const parsed = ReconcileResultSchema.parse(result);
    expect(parsed.applied).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(0);
    expect(parsed.residual).toHaveLength(0);
    expect(parsed.advisories).toHaveLength(1);
    expect(parsed.advisories[0]?.surface).toBe('cli-only');

    // The empty result is valid.
    expect(
      ReconcileResultSchema.parse({ applied: [], skipped: [], residual: [], advisories: [] })
        .advisories,
    ).toHaveLength(0);

    // Malformed: missing a required bucket.
    expect(
      ReconcileResultSchema.safeParse({ applied: [], skipped: [], residual: [] }).success,
    ).toBe(false);

    // Malformed: an advisory that is itself invalid.
    expect(
      ReconcileResultSchema.safeParse({
        applied: [],
        skipped: [],
        residual: [],
        advisories: [{ surface: 'cli-only' }],
      }).success,
    ).toBe(false);
  });
});
