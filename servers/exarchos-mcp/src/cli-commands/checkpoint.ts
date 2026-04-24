// ─── T035 — `/exarchos:checkpoint` CLI adapter ─────────────────────────────
//
// Thin shim over the shared `dispatch()` layer (same layer the MCP adapter
// uses) that invokes `exarchos_workflow.checkpoint` and renders the returned
// envelope to stdout. Keeping the CLI and MCP arms on the same dispatch path
// is the DR-3 parity guarantee — any new handler field is visible to both
// surfaces at the same time.
//
// Envelope shape returned by the workflow composite (DR-6/DR-7/DR-8):
//   {
//     success: boolean,
//     data: { phase, projectionSequence?, sidecarPending? },
//     next_actions: NextAction[],   // may be empty
//     _meta: { checkpointAdvised, … },
//     _perf: { ms, bytes, tokens },
//   }
//
// Output convention matches the rest of the adapter (see `version.ts`,
// `cli.ts`):
//   - success → single JSON line on stdout, exit 0.
//   - missing featureId → stderr message, non-zero exit, no stdout noise.
//   - handler-reported failure → envelope/error JSON on stdout, exit 1.
// stdout stays machine-parseable so an orchestrator can `JSON.parse` the
// output without grepping through mixed streams.

import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';

// ─── Options ────────────────────────────────────────────────────────────────

export interface CheckpointCliOptions {
  /** Workflow feature identifier; required by CheckpointInputSchema. */
  readonly featureId?: string;
  /** Optional human-readable summary persisted into the checkpoint state. */
  readonly summary?: string;
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Entry point for `/exarchos:checkpoint` (and `exarchos wf checkpoint` via
 * the auto-generated registry route in `adapters/cli.ts`).
 *
 * Returns the exit code rather than calling `process.exit()` so tests can
 * assert the code without terminating the vitest worker — the same pattern
 * used by `handleVersionCheck`.
 *
 * Validation is intentionally minimal here: the dispatch layer applies
 * per-action Zod validation (DR-5) so a missing/malformed `summary` is
 * caught downstream with the same `INVALID_INPUT` code the MCP adapter
 * emits. The only pre-dispatch gate is `featureId` presence — the CLI
 * ought to fail fast with a human-friendly stderr message rather than
 * ship an empty string to the handler only to get back a Zod error.
 */
export async function handleCheckpointCli(
  opts: CheckpointCliOptions,
  ctx: DispatchContext,
): Promise<number> {
  // ─── Pre-dispatch: required featureId ─────────────────────────────────
  if (typeof opts.featureId !== 'string' || opts.featureId.length === 0) {
    process.stderr.write(
      'exarchos checkpoint: missing required argument: featureId\n',
    );
    return 1;
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────
  const args: Record<string, unknown> = {
    action: 'checkpoint',
    featureId: opts.featureId,
  };
  if (typeof opts.summary === 'string' && opts.summary.length > 0) {
    args.summary = opts.summary;
  }

  const result = await dispatch('exarchos_workflow', args, ctx);

  // ─── Render envelope (success) / error payload ────────────────────────
  // Single JSON line: matches the `--json` output convention in
  // `adapters/cli.ts` so orchestrators can uniformly `JSON.parse` stdout.
  process.stdout.write(JSON.stringify(result) + '\n');

  return result.success ? 0 : 1;
}
