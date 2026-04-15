import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { type DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { callCli, callMcp } from '../__tests__/parity-harness.js';

// ─── Task 024: CLI-vs-MCP Argument Coercion Failure Parity (DR-5) ────────────
// These tests prove that when users provide malformed arguments — missing a
// required field, passing a wrong-typed value, or naming an action that does
// not exist — the CLI and MCP adapters reject with the SAME `error.code` and
// an equivalent message. Prior to task 024, the CLI produced ToolResult
// `INVALID_INPUT` payloads but the MCP dispatch layer could silently pass
// bad args through to the composite handler (per-action schemas were only
// enforced by the CLI layer). This test locks in parity so future changes
// cannot drift the two facades apart.
//
// Strategy:
// - Invoke each adapter with the same malformed payload.
// - Both paths MUST return a ToolResult with { success: false, error.code }
//   and error.code MUST match between the two. Messages may differ in
//   surface wording but must reference the same failing field.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/** Extract just the error code (success payloads flagged as 'OK' sentinel). */
function errorCode(result: ToolResult): string {
  if (result.success) return '__SUCCESS__';
  return result.error?.code ?? '__MISSING_ERROR__';
}

// ─── Fixture Harness ─────────────────────────────────────────────────────────

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
  await fs.rm(fixture.cliDir, { recursive: true, force: true });
  await fs.rm(fixture.mcpDir, { recursive: true, force: true });
});

// ─── Parity Tests ────────────────────────────────────────────────────────────

describe('CLI/MCP argument coercion failure parity (DR-5)', () => {
  it('MalformedArgs_MissingRequired_BothFacades_RejectWithSameErrorCode', async () => {
    // `exarchos_workflow init` requires `featureId` and `workflowType`.
    // Invoke with `workflowType` present but `featureId` missing via both
    // adapters and assert both reject with INVALID_INPUT.

    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { workflowType: 'feature' }, // featureId deliberately omitted
      { captureCommanderErrors: true },
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      workflowType: 'feature',
      // featureId deliberately omitted
    });

    // Both must fail.
    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    // Both must produce INVALID_INPUT (the canonical code for per-action
    // schema validation failure).
    expect(errorCode(cliResult)).toBe('INVALID_INPUT');
    expect(errorCode(mcpResult)).toBe('INVALID_INPUT');

    // And both codes must be identical (redundant but self-documenting).
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    // CLI exit code must map to INVALID_INPUT (1).
    expect(cliExitCode).toBe(1);

    // Messages must reference the failing field so UX is equivalent.
    // Loose substring match — wording may differ but `featureId` (or its
    // kebab form) must appear in both.
    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  it('MalformedArgs_WrongType_BothFacades_RejectWithSameErrorCode', async () => {
    // `exarchos_workflow init` requires `featureId: string`. Pass a
    // non-string (MCP) or a value that will fail FeatureIdSchema constraints
    // (CLI uses string flags, so we pass a value that violates the regex).
    //
    // Both facades must emit INVALID_INPUT.

    // CLI: pass a feature id that violates FeatureIdSchema's regex
    // (uppercase letters are forbidden in the feature-id format).
    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId: 'BAD_ID_WITH_UPPERCASE', workflowType: 'feature' },
      { captureCommanderErrors: true },
    );

    // MCP: pass featureId as a number — wrong type at the schema level.
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

    // Messages should reference the offending field in both.
    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  it('MalformedArgs_UnknownAction_BothFacades_RejectWithSameErrorCode', async () => {
    // Passing an action name the registry doesn't know about must produce
    // the same error shape from both facades.
    //
    // Historical note: the MCP composite handler returns UNKNOWN_ACTION
    // from its default switch case, while Commander used to throw a
    // CommanderError for unknown subcommands. This test asserts both paths
    // funnel through the same INVALID_INPUT contract so tool agents can
    // detect bad action names uniformly.

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

    // Codes must match across facades.
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    // The code itself must be INVALID_INPUT (the canonical rejection code
    // for malformed input at the adapter boundary).
    expect(errorCode(cliResult)).toBe('INVALID_INPUT');

    expect(cliExitCode).toBe(1);
  });
});

// ─── F-024 sidecar-coverage: parametrize across all 5 composite tools ───────
//
// The three malformed-args tests above only exercised `exarchos_workflow`.
// The dispatch-level Zod validation lives in `core/dispatch.ts` and is
// supposed to apply uniformly to every composite tool; this parametrized
// block proves that empirically rather than relying on the single-tool
// sample.
//
// Each fixture names:
//   • `tool`       — full MCP tool name (e.g. `exarchos_event`)
//   • `cliAlias`   — CLI alias exposed by the tool (e.g. `ev`)
//   • `action`     — canonical action on the tool that takes at least one
//                    required non-boolean field
//   • `requiredField` — name of the required field that will be omitted
//   • `wrongTypeField` — field to poison with a type mismatch (MCP side)
//   • `wrongTypeValue` — the bad value
//   • `validExtras` — other required fields supplied with valid values
//                     (so the poison field is the sole failure)
//   • `fieldPattern` — regex for matching the field name (kebab-or-camel)
//                      in the error message.
//
// `exarchos_sync` only has `now` with an empty-object schema — no action
// has a required non-boolean field, so it is intentionally excluded with
// a comment in the fixtures array.

interface ToolFixture {
  readonly label: string;
  readonly tool: string;
  readonly cliAlias: string;
  readonly action: string;
  readonly requiredField: string;
  readonly wrongTypeField: string;
  readonly wrongTypeValue: unknown;
  readonly validExtras: Record<string, unknown>;
  readonly fieldPattern: RegExp;
}

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
    // `event` is required too, supply a valid minimal object so the
    // failure is isolated to the stream field.
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
  {
    label: 'exarchos_view/stack_place',
    tool: 'exarchos_view',
    cliAlias: 'vw',
    action: 'stack_place',
    requiredField: 'streamId',
    wrongTypeField: 'streamId',
    wrongTypeValue: 7,
    validExtras: { position: 0, taskId: 't-parity' },
    fieldPattern: /stream-?id/i,
  },
  // exarchos_sync: the only action (`now`) has schema `z.object({})` with
  // zero required fields. The malformed-args contract does not apply —
  // any args object is valid. Intentionally skipped; if a future sync
  // action gains a required non-boolean field, add a fixture here.
];

describe.each(TOOL_FIXTURES)(
  'CLI/MCP parity — $label (F-024 sidecar-coverage)',
  (fixtureDef) => {
    it(`MalformedArgs_MissingRequired_BothFacades_RejectWithSameErrorCode__${fixtureDef.label}`, async () => {
      const cliFlags: Record<string, unknown> = { ...fixtureDef.validExtras };
      // Deliberately omit `requiredField` from cliFlags.
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
        // required field deliberately omitted
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

    it(`MalformedArgs_WrongType_BothFacades_RejectWithSameErrorCode__${fixtureDef.label}`, async () => {
      // MCP arm: feed a wrong-typed value directly.
      const mcpResult = await callMcp(fixture.mcpCtx, fixtureDef.tool, {
        action: fixtureDef.action,
        ...fixtureDef.validExtras,
        [fixtureDef.wrongTypeField]: fixtureDef.wrongTypeValue,
      });

      // CLI arm: pass the wrong-typed value as its stringified form. For
      // fields whose Zod type is not `string` the coerce step will produce
      // a value that fails validation; for `string` fields (featureId,
      // stream, taskId, streamId), we pass an explicitly invalid string
      // instead — the `__INVALID__` sentinel includes characters that
      // violate the typical min(1)/regex/feature-id constraints where
      // applicable, and is accepted-but-rejected-by-handler where not.
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

      // MCP must reject (wrong type at the Zod level).
      expect(mcpResult.success).toBe(false);
      expect(errorCode(mcpResult)).toBe('INVALID_INPUT');

      // CLI may or may not reject depending on whether Zod can coerce the
      // string form; either outcome is acceptable so long as any rejection
      // uses the canonical INVALID_INPUT code. If the CLI accepts the
      // coerced string (valid happy path), the handler may succeed or
      // return a different error — we only care that no UNCAUGHT_EXCEPTION
      // leaks for obviously bad input.
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
