import { countBy, estimateOutputTokens, narrowAffordance, PIPELINE_DEFAULT_ITEM_CAP, resolveOutputTokenThreshold, SUMMARY_FIRST_PAGE_ITEMS } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { isFeatureStream } from '../../../dispatch/core/infra-streams.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { deriveRepoKey } from '../../../utils/paths.js';
import type { QualityHintsConfig } from '../../../workflow/capabilities/resolver.js';
import { TERMINAL_PHASES } from '../../../workflow/terminal-phases.js';
import { PROJECTION_LAG_THRESHOLD_MS } from '../../index.js';
import { PIPELINE_VIEW, type PipelineViewState } from '../pipeline-view.js';
import { isSnapshotSafeId } from '../snapshot-store.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';
import { discoverStreams } from './streams.js';

// ─── View Pipeline Handler ─────────────────────────────────────────────────

// DR-1 — compact pipeline entry. Default pipeline rows omit the unbounded
// per-task `tasksById` map (redundant with the counters beside it) and carry
// only summary fields. The per-entry `hasMore` here is the stack-position
// EVICTION flag (unrelated to page-level paging) and is deliberately retained.
// `detail: true` restores the full {@link PipelineViewState} row. The type is
// declared locally in `projections/views/tools.ts` on purpose — the exported
// `PipelineViewState`/`PipelineSummary` declarations stay in
// `projections/views/pipeline-view.ts` (chain-A territory).
interface CompactPipelineEntry {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: string;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly stackPositions: PipelineViewState['stackPositions'];
  readonly hasMore: boolean;
  readonly _asOf: string;
  readonly repoRoot?: string;
}

/**
 * Compacted counterpart of `PipelineSummary`: identical group-count rollups,
 * but its `firstPage` rows are compacted the same way the detail branch
 * compacts entries (DR-1). Local so chain A's exported `PipelineSummary` shape
 * is untouched.
 */
interface CompactPipelineSummary {
  readonly total: number;
  readonly byPhase: Record<string, number>;
  readonly byWorkflowType: Record<string, number>;
  readonly firstPage: CompactPipelineEntry[];
}

/**
 * Strip a full projection row down to the DR-1 compact entry. `repoRoot` is
 * read defensively (`w as { repoRoot? }`) so this stays forward-compatible with
 * chain A adding `repoRoot` to `PipelineViewState` (task 003) — the field flows
 * through with no merge conflict on this helper once it exists.
 */
function toCompactEntry(w: PipelineViewState): CompactPipelineEntry {
  const repoRoot = (w as { repoRoot?: string }).repoRoot;
  return {
    featureId: w.featureId,
    workflowType: w.workflowType,
    phase: w.phase,
    taskCount: w.taskCount,
    completedCount: w.completedCount,
    failedCount: w.failedCount,
    stackPositions: w.stackPositions,
    hasMore: w.hasMore,
    _asOf: w._asOf,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

/** Paging metadata shared by the detail and summary-fallback branches (DR-3). */
interface PipelinePage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * Build the DR-3 `page` envelope. Both branches derive `hasMore` from the same
 * offset-aware invariant — `offset + shownRows < total` — so a caller paged to
 * the last window never sees a spurious "more rows" signal (the summary branch
 * previously compared `total > firstPage.length`, ignoring `offset`).
 */
export function buildPage(total: number, offset: number, limit: number, shownRows: number): PipelinePage {
  return { total, offset, limit, hasMore: offset + shownRows < total };
}

/**
 * DR-3 deterministic pipeline order: `_asOf` DESCENDING (most-recent activity
 * first), ties broken by `featureId` ASCENDING. A total order (no equal-rank
 * ambiguity for distinct featureIds) so two consecutive offset windows always
 * partition ONE stable sequence. `_asOf` is an ISO-8601 string, so lexical
 * comparison is chronological.
 */
function comparePipelineRows(a: PipelineViewState, b: PipelineViewState): number {
  if (a._asOf !== b._asOf) return a._asOf < b._asOf ? 1 : -1;
  if (a.featureId !== b.featureId) return a.featureId < b.featureId ? -1 : 1;
  return 0;
}

/**
 * DR-7 always-on perceivability: the scope-all escape-hatch affordance. Surfaced
 * on `next_actions` whenever repo scoping hid rows (`unscopedTotal > page.total`)
 * — scoped-empty AND mixed steady state alike. Carries the exact `hiddenCount`
 * (`unscopedTotal - page.total`) so the agent can perceive precisely how many
 * workflows the default repo scope elided, and the `--scope all` CLI hint that
 * reveals them. In `scope: "all"` mode nothing is hidden (`unscopedTotal ===
 * page.total`), so this never fires there. Verb is the view's own name so it
 * validates against the catch-all `NextActionSchema`.
 */
function scopeAllAffordance(hiddenCount: number): NextAction {
  return {
    verb: 'pipeline',
    reason: `${hiddenCount} workflow${hiddenCount === 1 ? '' : 's'} in other repos ${hiddenCount === 1 ? 'is' : 'are'} hidden by the default repo scope — use scope: "all" to include ${hiddenCount === 1 ? 'it' : 'them'}.`,
    hint: 'exarchos vw ls --scope all',
  };
}

export async function handleViewPipeline(
  args: {
    limit?: number;
    offset?: number;
    includeCompleted?: boolean;
    detail?: boolean;
    // DR-6 — explicit scope inputs (schema-declared in `registry.ts` so the CLI
    // flags auto-emit). `repoRoot` scopes to an arbitrary repo (normalized before
    // compare); `scope` forces `"all"` (unfiltered) or `"repo"` (requires a key).
    repoRoot?: string;
    // The shared `scopeField` (lifecycle `schema-fields.ts`) was widened to the
    // 4-member union so `pipeline` and `ps` declare ONE `scope` definition on
    // `exarchos_view` (a divergent enum value set would make
    // `buildRegistrationSchema` THROW). `pipeline` acts ONLY on the `{repo, all}`
    // subset; the `ps`-only members (`workflow`/`worktree`) can reach this
    // handler through the widened registration and are REJECTED below.
    scope?: 'repo' | 'all' | 'workflow' | 'worktree';
  },
  stateDir: string,
  eventStore: EventStore,
  // DR-3 — the resolved `.exarchos.yml` slice threaded from `projections/views/composite.ts`
  // so `qualityHints.outputTokenThreshold` drives the measured-size summary.
  // Optional so existing internal callers (and tests) that omit it keep the
  // item-cap-only behavior (fail-open: no config ⇒ default threshold).
  config?: QualityHintsConfig,
  // DR-6 — the memoized CALLER repo key, computed once per server process and
  // threaded by `projections/views/composite.ts` (`deriveRepoKey(ctx.cwd ?? process.cwd())`).
  // Absent for direct handler calls (tests/internal), which therefore stay
  // UNSCOPED by construction — preserving today's semantics without a per-suite
  // edit. See the pinned scope-resolution precedence below.
  callerRepoKey?: string,
): Promise<ToolResult> {
  try {
    // Subset guard — `pipeline` acts only on the `{repo, all}` axis. The shared
    // `scopeField` union (widened by task 007 so `pipeline` and `ps` share one
    // `scope` definition without a flattener collision) can surface a `ps`-only
    // member (`workflow`/`worktree`) here. GA rejected out-of-subset scopes; the
    // widening must not silently coerce them to unscoped. Reject with a
    // structured, self-correcting `INVALID_INPUT` (mirroring how `ps` rejects the
    // pipeline-only `repo` member — see `projections/views/lifecycle/ps.ts`) rather than a
    // silent fall-through to the default caller-key / unscoped branch.
    if (args.scope !== undefined && args.scope !== 'repo' && args.scope !== 'all') {
      const outOfSubset = args.scope;
      const isPsScope = outOfSubset === 'workflow' || outOfSubset === 'worktree';
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            `pipeline: scope '${outOfSubset}' is not a pipeline axis — pipeline scopes are 'repo' | 'all'.` +
            (isPsScope
              ? ` ('workflow' | 'worktree' are ps-only scopes — use ps for those.)`
              : ''),
          validTargets: ['repo', 'all'],
          ...(isPsScope
            ? {
                suggestedFix: {
                  tool: 'exarchos_view',
                  params: { action: 'ps', scope: outOfSubset },
                },
              }
            : {}),
        },
      };
    }

    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);

    // Materialize all streams to get phase info for filtering. Infrastructure
    // streams (exarchos-init, exarchos-doctor, telemetry) are excluded — they
    // never emit workflow.started so they would surface as phantom rows with
    // empty featureId/workflowType/phase (#1187).
    //
    // Enumeration tolerance (RCA 2026-05-30-state-source-integrity): the event
    // store legitimately contains streams whose ids are not snapshot-safe —
    // `__`-prefixed sentinels (`__migration__`) and two-segment slash ids
    // (`elicitation/<uuid>`, `workflow-state/<id>`) that the write-side
    // `validateStreamId` accepts but `SnapshotStore.getSnapshotPath` rejects.
    // Exclude them at discovery so iterating the store never forwards an
    // unprojectable id into `materialize` and crashes the view. Explicit
    // single-id queries are unaffected — they still validate their `workflowId`
    // argument via the `materialize`/`getSnapshotPath` throw (closing #1434
    // generically: that fix only skipped `__`-prefixed ids).
    const streamIds = (await discoverStreams(stateDir, store))
      .filter(isFeatureStream)
      .filter(isSnapshotSafeId);
    const allWorkflows: PipelineViewState[] = [];

    for (const streamId of streamIds) {
      const { view } = await foldToTail<PipelineViewState>(store, materializer, streamId, PIPELINE_VIEW);
      allWorkflows.push(view);
    }

    // DR-4 — phantom exclusion. A discovered feature stream that folded no
    // `workflow.started` event yields a degenerate row (empty featureId, no
    // phase, no timestamp). Exclude these BEFORE the terminal filter and BEFORE
    // any total is computed, so a phantom never appears in the page and never
    // inflates `page.total`/`unscopedTotal` — in any scope mode. Infra streams
    // are already dropped at discovery (isFeatureStream); this closes the gap
    // for feature-named streams that carry events but never a `workflow.started`
    // foundation (#1187 covered only the reserved infra ids).
    const real = allWorkflows.filter((w) => w.featureId !== '');

    // Filter out terminal-state workflows unless explicitly requested
    const filtered = args.includeCompleted
      ? real
      : real.filter((w) => !(TERMINAL_PHASES as readonly string[]).includes(w.phase));

    // DR-7 seam — `unscopedTotal` is the post-phantom, post-terminal-filter,
    // PRE-scope-filter count. Pinned here so the scope escape hatch (chain A /
    // task 007) can never mis-attribute `includeCompleted`-hidden rows to repo
    // scoping.
    const unscopedTotal = filtered.length;

    // DR-6 — repo-scope resolution seam (between `unscopedTotal` and
    // `page.total`). PINNED precedence:
    //   1. explicit scope:'all'            → unfiltered              (effective 'all')
    //   2. explicit repoRoot arg           → filter to deriveRepoKey(repoRoot),
    //                                         normalized before compare (effective 'repo')
    //   3. composite-supplied caller key   → filter to it            (effective 'repo')
    //   4. explicit scope:'repo' w/ no key → STRUCTURED ERROR (never silent unscoped)
    //   5. else (direct call, no key)      → unscoped                (effective 'all')
    // Legacy rows (`repoRoot === undefined`) match ONLY the unscoped/'all' modes,
    // because an explicit/caller key is always a defined string and `undefined`
    // never equals it.
    let scoped: PipelineViewState[];
    let effectiveScope: 'repo' | 'all';
    if (args.scope === 'all') {
      scoped = filtered;
      effectiveScope = 'all';
    } else if (args.repoRoot !== undefined) {
      // Normalize the caller-supplied path through the SAME derivation as the
      // recorded key so worktree- and Windows-form inputs match by construction.
      const key = deriveRepoKey(args.repoRoot);
      scoped = filtered.filter((w) => w.repoRoot === key);
      effectiveScope = 'repo';
    } else if (callerRepoKey !== undefined) {
      scoped = filtered.filter((w) => w.repoRoot === callerRepoKey);
      effectiveScope = 'repo';
    } else if (args.scope === 'repo') {
      // scope:'repo' explicitly requested but no repoRoot arg and no caller key —
      // there is no repo identity to filter against. Fail with a structured,
      // self-correcting error rather than silently returning an unscoped result.
      return {
        success: false,
        error: {
          code: 'SCOPE_UNRESOLVABLE',
          message:
            'scope: "repo" requested but no repo identity is resolvable ' +
            '(no explicit repoRoot argument and no caller repo key). Pass an ' +
            'explicit repoRoot, or use scope: "all" to view the full ' +
            'cross-repo inventory.',
          suggestedFix: {
            tool: 'exarchos_view',
            params: { action: 'pipeline', scope: 'all' },
          },
        },
      };
    } else {
      // Direct handler call with no key and no explicit scope — UNSCOPED by
      // construction so existing direct-call suites keep today's semantics.
      scoped = filtered;
      effectiveScope = 'all';
    }

    // DR-3 — deterministic order so consecutive offset windows partition ONE
    // stable sequence: `_asOf` descending, ties broken by `featureId` ascending.
    const sorted = [...scoped].sort(comparePipelineRows);

    // DR-3 — `page.total` reflects the filtered, scoped set.
    const total = sorted.length;

    // DR-2 — pipeline-specific SMALL default window. When the caller omits
    // `limit`, cap at PIPELINE_DEFAULT_ITEM_CAP (10) — deliberately NOT the
    // shared DEFAULT_VIEW_ITEM_CAP (50), which the worktrees view keeps. An
    // explicit `limit` is honored verbatim.
    const start = args.offset ?? 0;
    const explicitLimit = args.limit !== undefined;
    const effectiveLimit = explicitLimit ? (args.limit as number) : PIPELINE_DEFAULT_ITEM_CAP;
    const end = start + effectiveLimit;
    const windowed = sorted.slice(start, end);
    // DR-1 — default rows are compacted (unbounded `tasksById` stripped);
    // `detail: true` returns the full projection rows verbatim.
    const workflows: Array<PipelineViewState | CompactPipelineEntry> = args.detail
      ? windowed
      : windowed.map(toCompactEntry);

    // DR-3 — explicit paging metadata, namespaced under `page` so `page.hasMore`
    // never collides with the per-entry stack-eviction `hasMore` on each row.
    // Detail-branch semantics: more rows exist beyond this window.
    const page = buildPage(total, start, effectiveLimit, windowed.length);

    // #1359 / PR4 T14 + T15 — derive `projectionAsOf` from the maximum
    // `_asOf` timestamp across the materialized workflows (the most
    // recent event observed across the union of streams). Surface
    // `_meta.projectionLag` when the projection is stale beyond
    // PROJECTION_LAG_THRESHOLD_MS. The field is sparse: a fresh
    // projection omits it entirely so agents have a clear "no lag"
    // signal vs. an explicit numeric delta.
    let projectionAsOf: string | undefined;
    for (const w of allWorkflows) {
      if (w._asOf && (!projectionAsOf || w._asOf > projectionAsOf)) {
        projectionAsOf = w._asOf;
      }
    }
    let meta: Record<string, unknown> | undefined;
    if (projectionAsOf !== undefined) {
      meta = { projectionAsOf };
      const asOfMs = Date.parse(projectionAsOf);
      if (Number.isFinite(asOfMs)) {
        const lag = Date.now() - asOfMs;
        if (lag > PROJECTION_LAG_THRESHOLD_MS) {
          meta = { ...meta, projectionLag: lag };
        }
      }
    }

    // DR-3 measured-size summary guard. If the capped per-item payload would
    // STILL exceed the resolved output-token threshold, return a counts-by-group
    // summary + a small first page INSTEAD of per-item detail. Fail-open: an
    // unresolvable threshold (`null`) degrades to the plain capped detail — never
    // an unbounded dump nor an inventory-hiding error.
    // DR-3 — `data.total` is retained as a LEGACY ALIAS of `page.total` for one
    // release; new consumers should read `data.page`.
    // DR-7 — `data.scope` reports the EFFECTIVE mode ('repo' | 'all') and
    // `data.unscopedTotal` the pre-scope count, on EVERY response, so hidden
    // rows are always perceivable.
    const detailData = { workflows, total, unscopedTotal, page, scope: effectiveScope };
    const threshold = resolveOutputTokenThreshold(config);
    const narrowHint = 'exarchos vw ls --limit 20 --offset 0';
    if (threshold !== null && estimateOutputTokens(detailData) > threshold) {
      // DR-1 — the summary's `firstPage` rows are compacted identically to the
      // detail branch, regardless of `detail:true` (a summary fallback exists
      // precisely because the payload was too large — never re-inline tasksById).
      const firstPage = windowed.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map(toCompactEntry);
      const summary: CompactPipelineSummary = {
        total,
        byPhase: countBy(sorted, (w) => w.phase),
        byWorkflowType: countBy(sorted, (w) => w.workflowType),
        firstPage,
      };
      // DR-3 — the SUMMARY branch carries the SAME `page` shape as the detail
      // branch, so `hasMore` is derived from the full offset/limit `windowed`
      // slice — NOT the capped `firstPage` preview. `page.offset`/`page.limit`
      // describe the window; `firstPage` is only a display truncation of it, so
      // keying `hasMore` off `firstPage.length` would spuriously report more
      // pages whenever the window holds more rows than the preview cap (e.g. 15
      // rows, limit 25 → window covers all 15 but firstPage caps at 10).
      // Using `windowed.length` makes summary and detail `page.hasMore` identical
      // for the same query. Namespaced so it never collides with the per-entry
      // eviction `hasMore`.
      const summaryPage = buildPage(total, start, effectiveLimit, windowed.length);
      // DR-7 — the scope-all escape hatch rides alongside the narrow affordance
      // whenever repo scoping hid rows, so the summary branch is perceivable too.
      const summaryNextActions: NextAction[] = [
        narrowAffordance('pipeline', firstPage.length, total, narrowHint),
      ];
      if (unscopedTotal > total) {
        summaryNextActions.push(scopeAllAffordance(unscopedTotal - total));
      }
      return {
        success: true,
        data: { summary, total, unscopedTotal, page: summaryPage, scope: effectiveScope, truncated: true },
        next_actions: summaryNextActions,
        ...(meta ? { _meta: meta } : {}),
      };
    }

    // Per-item detail. Two independent affordances ride `next_actions`:
    //   • the narrow paging affordance whenever `page.hasMore` (more rows exist
    //     beyond the current window — default small cap OR explicit limit/offset
    //     short of the tail);
    //   • DR-7 — the scope-all escape hatch whenever repo scoping hid rows
    //     (`unscopedTotal > total`), independent of paging, so a single-page
    //     scoped result with hidden other-repo rows is still perceivable.
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(narrowAffordance('pipeline', windowed.length, total, narrowHint));
    }
    if (unscopedTotal > total) {
      nextActions.push(scopeAllAffordance(unscopedTotal - total));
    }
    return {
      success: true,
      data: detailData,
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'pipeline' });
  }
}
