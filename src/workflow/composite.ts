/**
 * The composite `exarchos_workflow` handler. It routes each `action` to its
 * workflow handler and wraps a success in the HATEOAS `Envelope<T>` through
 * `envelopeWrap`. An error passes through unchanged. Internal callers of the
 * handlers still get the raw `ToolResult`.
 *
 * `get` needs no degraded gate, because it folds `workflow-state` to the durable
 * tail through `projections/fold-at-tail.ts` before it answers. `toViewFailure`
 * reports a fold that cannot prove tail coverage. Only `rehydrate` applies
 * cache hints, because only it has a stable serialized prefix to cache.
 */
import { handleInit, handleGet, handleTransition, handleReconcileState, handleCheckpoint, handleUpdate } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import { handleRehydrate } from './rehydrate.js';
import { handleFeedback } from './feedback.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { envelopeWrap } from '../envelope-wrap.js';
import { deriveRepoKey } from '../utils/paths.js';
import { workflowLogger } from '../logger.js';
import { toViewFailure } from '../projections/degraded-result.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

/**
 * Route `action` to its workflow handler.
 *
 * `init` gets the memoized repo key of the serving directory, so
 * `workflow.started` records `repoRoot`. `transition` gets the project-config
 * options that the pure guards read. A NoCoverage budget that is negative or
 * not an integer becomes the strict default of 0. The budget goes to the guard
 * only when a review config resolves. `checkpoint` loads `.exarchos.yml` from
 * `process.cwd()`, because `stateDir` is the global state directory. A config
 * load failure logs a warning, and the checkpoint continues as soft-fail.
 */
export async function handleWorkflow(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'init': {
      const repoKey = deriveRepoKey(ctx.cwd ?? process.cwd());
      return envelopeWrap(
        await handleInit(rest as Parameters<typeof handleInit>[0], stateDir, eventStore, repoKey),
        startedAt,
      );
    }
    case 'get':
      try {
        return envelopeWrap(
          await handleGet(rest as Parameters<typeof handleGet>[0], stateDir, eventStore),
          startedAt,
        );
      } catch (err) {
        const failure = toViewFailure(err, { tool: 'exarchos_workflow', action });
        if (failure.error?.code !== 'VIEW_ERROR') return failure;
        throw err;
      }
    case 'transition': {
      const skipPhases = ctx.projectConfig?.workflow.skipPhases;
      const requiredReviews = ctx.projectConfig?.workflow.requiredReviews;
      const checkpoint = ctx.projectConfig?.checkpoint;
      const maxPlanRevisions = ctx.projectConfig?.workflow.maxPlanRevisions;
      const mutationEnforcement = ctx.projectConfig?.review.mutationEnforcement;
      const mutationThreshold = ctx.projectConfig?.review.gates['mutation-adequacy']?.params
        ?.threshold as number | undefined;
      const maxNoCoverageRaw = ctx.projectConfig?.review.gates['mutation-adequacy']?.params
        ?.maxNoCoverage;
      const maxNoCoverage =
        typeof maxNoCoverageRaw === 'number' &&
        Number.isInteger(maxNoCoverageRaw) &&
        maxNoCoverageRaw >= 0
          ? maxNoCoverageRaw
          : 0;
      const transitionOptions: Record<string, unknown> = {};
      if (skipPhases?.length) transitionOptions.skipPhases = skipPhases;
      if (requiredReviews?.length) transitionOptions.requiredReviews = requiredReviews;
      if (checkpoint) transitionOptions.checkpoint = checkpoint;
      if (typeof maxPlanRevisions === 'number') transitionOptions.maxPlanRevisions = maxPlanRevisions;
      if (mutationEnforcement !== undefined) transitionOptions.mutationEnforcement = mutationEnforcement;
      if (typeof mutationThreshold === 'number') transitionOptions.mutationThreshold = mutationThreshold;
      if (mutationEnforcement !== undefined) transitionOptions.maxNoCoverage = maxNoCoverage;
      return envelopeWrap(
        await handleTransition(
          rest as unknown as Parameters<typeof handleTransition>[0],
          stateDir,
          eventStore,
          Object.keys(transitionOptions).length > 0
            ? transitionOptions as Parameters<typeof handleTransition>[3]
            : undefined,
        ),
        startedAt,
      );
    }
    case 'update': {
      return envelopeWrap(
        await handleUpdate(
          rest as unknown as Parameters<typeof handleUpdate>[0],
          stateDir,
          eventStore,
        ),
        startedAt,
      );
    }
    case 'cancel':
      return envelopeWrap(await handleCancel(rest as Parameters<typeof handleCancel>[0], stateDir, eventStore), startedAt);
    case 'cleanup':
      return envelopeWrap(await handleCleanup(rest as Parameters<typeof handleCleanup>[0], stateDir, eventStore), startedAt);
    case 'reconcile':
      return envelopeWrap(await handleReconcileState(rest as Parameters<typeof handleReconcileState>[0], stateDir, eventStore), startedAt);
    case 'feedback':
      return envelopeWrap(await handleFeedback(rest as Parameters<typeof handleFeedback>[0], stateDir, eventStore), startedAt);
    case 'checkpoint': {
      const { loadExarchosConfig } = await import('../config/load-exarchos-config.js');
      const worktreePath = process.cwd();
      let checkpointOptions: { handoffLint?: { hardFail: boolean } } | undefined;
      try {
        const result = loadExarchosConfig(worktreePath);
        const hardFail = result?.config.handoffLint?.hardFail;
        if (typeof hardFail === 'boolean') {
          checkpointOptions = { handoffLint: { hardFail } };
        }
      } catch (err) {
        workflowLogger.warn(
          {
            stateDir,
            worktreePath,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to load .exarchos.yml for checkpoint handoffLint; defaulting to soft-fail',
        );
      }
      return envelopeWrap(
        await handleCheckpoint(
          rest as Parameters<typeof handleCheckpoint>[0],
          stateDir,
          eventStore,
          checkpointOptions,
        ),
        startedAt,
      );
    }
    case 'rehydrate':
      return envelopeWrap(
        await handleRehydrate(
          rest as unknown as Parameters<typeof handleRehydrate>[0],
          { stateDir, eventStore, artifactDirs: ctx.projectConfig?.artifacts },
        ),
        startedAt,
        { cacheHintsResolver: ctx.capabilityResolver },
      );
    case 'describe':
      return envelopeWrap(
        await handleDescribe(
          rest as { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
          workflowActions,
          { includeStateSchema: true, projectConfig: ctx.projectConfig },
        ),
        startedAt,
      );
    default: {
      const validActions = workflowActions.map((a) => a.name);
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${String(action)}. Valid actions: ${validActions.join(', ')}`,
          validActions,
        },
      };
    }
  }
}
