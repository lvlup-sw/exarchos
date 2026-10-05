/**
 * CLI and MCP parity for malformed arguments: a missing required field, a wrong-typed value and
 * an unknown action. Both adapters must return a failed `ToolResult` with the same `error.code`.
 * The message wording can differ, but each message must name the field that failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { callCli, callMcp } from '../../parity-harness.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/** Returns the error code of a result. A success and a failure with no code each return a sentinel. */
function errorCode(result: ToolResult): string {
  if (result.success) return '__SUCCESS__';
  return result.error?.code ?? '__MISSING_ERROR__';
}

interface ParityFixture {
  readonly cliDir: string;
  readonly mcpDir: string;
  readonly cliCtx: DispatchContext;
  readonly mcpCtx: DispatchContext;
}

let fixture: ParityFixture;

beforeEach(async () => {
  const cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-coerce-cli-'));
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-coerce-mcp-'));
  fixture = {
    cliDir,
    mcpDir,
    cliCtx: makeCtx(cliDir),
    mcpCtx: makeCtx(mcpDir),
  };
});

afterEach(async () => {
  await rmrfAsync(fixture.cliDir);
  await rmrfAsync(fixture.mcpDir);
});

describe('CLI/MCP argument coercion failure parity (DR-5)', () => {
  /**
   * `init` requires `featureId` and `workflowType`, and both calls omit `featureId`.
   * Each message must name the field, in camel case or in kebab case.
   */
  it('MalformedArgs_MissingRequired_BothFacades_RejectWithSameErrorCode', async () => {
    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { workflowType: 'feature' },
      { captureCommanderErrors: true },
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      workflowType: 'feature',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    expect(errorCode(cliResult)).toBe('INVALID_INPUT');
    expect(errorCode(mcpResult)).toBe('INVALID_INPUT');

    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    expect(cliExitCode).toBe(1);

    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  /**
   * The MCP call passes a number as `featureId`. A CLI flag is always a string, so the CLI call
   * passes an uppercase id, which the pattern of `FeatureIdSchema` rejects.
   */
  it('MalformedArgs_WrongType_BothFacades_RejectWithSameErrorCode', async () => {
    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId: 'BAD_ID_WITH_UPPERCASE', workflowType: 'feature' },
      { captureCommanderErrors: true },
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      featureId: 12345,
      workflowType: 'feature',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    expect(errorCode(cliResult)).toBe('INVALID_INPUT');
    expect(errorCode(mcpResult)).toBe('INVALID_INPUT');
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    expect(cliExitCode).toBe(1);

    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  /** Both adapters report an unknown action as `INVALID_INPUT`, so an agent detects a bad action name in one way. */
  it('MalformedArgs_UnknownAction_BothFacades_RejectWithSameErrorCode', async () => {
    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'nonexistent_action_xyz',
      {},
      { captureCommanderErrors: true },
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'nonexistent_action_xyz',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    expect(errorCode(cliResult)).toBe('INVALID_INPUT');

    expect(cliExitCode).toBe(1);
  });
});

/**
 * One malformed-argument case for an action of a composite tool. `dispatch/core/dispatch.ts`
 * validates the arguments of every tool, and the fixtures test that on more than one tool.
 */
interface ToolFixture {
  readonly label: string;
  readonly tool: string;
  readonly cliAlias: string;
  /** An action with at least one required field that is not a boolean. */
  readonly action: string;
  /** The field that the missing-field test omits. */
  readonly requiredField: string;
  /** The field that gets `wrongTypeValue` in the wrong-type test. */
  readonly wrongTypeField: string;
  readonly wrongTypeValue: unknown;
  /** The other required fields, with valid values, so that one field is the only failure. */
  readonly validExtras: Record<string, unknown>;
  /** Matches the field name in an error message, in camel case or in kebab case. */
  readonly fieldPattern: RegExp;
}

/**
 * `exarchos_sync` has no fixture. Its one action, `now`, takes an empty object, so no argument
 * is malformed. Add a fixture when a sync action gets a required field that is not a boolean.
 */
const TOOL_FIXTURES: ReadonlyArray<ToolFixture> = [
  {
    label: 'exarchos_workflow/init',
    tool: 'exarchos_workflow',
    cliAlias: 'wf',
    action: 'init',
    requiredField: 'featureId',
    wrongTypeField: 'featureId',
    wrongTypeValue: 12345,
    validExtras: { workflowType: 'feature' },
    fieldPattern: /feature-?id/i,
  },
  {
    label: 'exarchos_event/append',
    tool: 'exarchos_event',
    cliAlias: 'ev',
    action: 'append',
    requiredField: 'stream',
    wrongTypeField: 'stream',
    wrongTypeValue: 42,
    /** `event` is also required. A valid event keeps `stream` as the only failure. */
    validExtras: { event: { type: 'task.completed', data: { taskId: 't-1' } } },
    fieldPattern: /stream/i,
  },
  {
    label: 'exarchos_orchestrate/task_claim',
    tool: 'exarchos_orchestrate',
    cliAlias: 'orch',
    action: 'task_claim',
    requiredField: 'taskId',
    wrongTypeField: 'taskId',
    wrongTypeValue: 99,
    validExtras: { agentId: 'agent-parity', streamId: 'stream-parity' },
    fieldPattern: /task-?id/i,
  },
  /** `stack_place` appends `stack.position-filled`, so the orchestrate tool carries it. */
  {
    label: 'exarchos_orchestrate/stack_place',
    tool: 'exarchos_orchestrate',
    cliAlias: 'orch',
    action: 'stack_place',
    requiredField: 'streamId',
    wrongTypeField: 'streamId',
    wrongTypeValue: 7,
    validExtras: { position: 0, taskId: 't-parity' },
    fieldPattern: /stream-?id/i,
  },
];

describe.each(TOOL_FIXTURES)(
  'CLI/MCP parity — $label (F-024 sidecar-coverage)',
  (fixtureDef) => {
    it(`MalformedArgs_MissingRequired_BothFacades_RejectWithSameErrorCode__${fixtureDef.label}`, async () => {
      const cliFlags: Record<string, unknown> = { ...fixtureDef.validExtras };
      const { result: cliResult, exitCode: cliExitCode } = await callCli(
        fixture.cliCtx,
        fixtureDef.cliAlias,
        fixtureDef.action,
        cliFlags,
        { captureCommanderErrors: true },
      );

      const mcpResult = await callMcp(fixture.mcpCtx, fixtureDef.tool, {
        action: fixtureDef.action,
        ...fixtureDef.validExtras,
      });

      expect(cliResult.success).toBe(false);
      expect(mcpResult.success).toBe(false);
      expect(errorCode(cliResult)).toBe('INVALID_INPUT');
      expect(errorCode(mcpResult)).toBe('INVALID_INPUT');
      expect(cliExitCode).toBe(1);

      const cliMsg = cliResult.error?.message ?? '';
      const mcpMsg = mcpResult.error?.message ?? '';
      expect(cliMsg).toMatch(fixtureDef.fieldPattern);
      expect(mcpMsg).toMatch(fixtureDef.fieldPattern);
    });

    /**
     * The MCP call passes the wrong-typed value and must reject with `INVALID_INPUT`.
     * The CLI call passes the string form of that value, and the CLI can accept a string.
     * Thus the test lets the CLI call pass, and a CLI rejection can carry `HANDLER_ERROR`.
     */
    it(`MalformedArgs_WrongType_BothFacades_RejectWithSameErrorCode__${fixtureDef.label}`, async () => {
      const mcpResult = await callMcp(fixture.mcpCtx, fixtureDef.tool, {
        action: fixtureDef.action,
        ...fixtureDef.validExtras,
        [fixtureDef.wrongTypeField]: fixtureDef.wrongTypeValue,
      });

      const cliFlags: Record<string, unknown> = {
        ...fixtureDef.validExtras,
        [fixtureDef.wrongTypeField]:
          typeof fixtureDef.wrongTypeValue === 'string'
            ? fixtureDef.wrongTypeValue
            : String(fixtureDef.wrongTypeValue),
      };
      const { result: cliResult } = await callCli(
        fixture.cliCtx,
        fixtureDef.cliAlias,
        fixtureDef.action,
        cliFlags,
        { captureCommanderErrors: true },
      );

      expect(mcpResult.success).toBe(false);
      expect(errorCode(mcpResult)).toBe('INVALID_INPUT');

      if (!cliResult.success) {
        expect(['INVALID_INPUT', 'HANDLER_ERROR']).toContain(
          cliResult.error?.code,
        );
      }
    });

    it(`MalformedArgs_UnknownAction_BothFacades_RejectWithSameErrorCode__${fixtureDef.label}`, async () => {
      const { result: cliResult, exitCode: cliExitCode } = await callCli(
        fixture.cliCtx,
        fixtureDef.cliAlias,
        'nonexistent_action_xyz',
        {},
        { captureCommanderErrors: true },
      );

      const mcpResult = await callMcp(fixture.mcpCtx, fixtureDef.tool, {
        action: 'nonexistent_action_xyz',
      });

      expect(cliResult.success).toBe(false);
      expect(mcpResult.success).toBe(false);
      expect(errorCode(cliResult)).toBe(errorCode(mcpResult));
      expect(errorCode(cliResult)).toBe('INVALID_INPUT');
      expect(cliExitCode).toBe(1);
    });
  },
);
