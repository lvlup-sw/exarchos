/**
 * Reads complete task pages from authenticated historical custody without current checkout observations.
 * RESERVED(issue: #1927, owner: exarchos, expires: 2026-12-14)
 * The public read action will register this staged handler after its contract checks pass.
 */
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../workflow/capsule/prepared-custody.js';
import { PreparedDetailOutputSchema, ReadPreparedCapsuleArguments } from './schemas.js';
import { estimateOutputTokens } from '../../dispatch/core/economy.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS, preparedDetailCarrier, preparedDetailItems, type PreparedDetailMetadata } from './economy.js';

/** Returns a typed refusal without publishing any workflow fact. */
function refusal(code: string, message: string): ToolResult { return { success: false, error: { code, message } }; }

/** Authenticates the exact named row before reading the longest fitting task prefix. */
export async function handleReadPreparedCapsule(raw: Record<string, unknown>, _stateDir: string, ctx: DispatchContext, warnings: readonly string[] = []): Promise<ToolResult> {
  const parsed = ReadPreparedCapsuleArguments.safeParse(raw);
  if (!parsed.success) return refusal('INVALID_INPUT', parsed.error.message);
  const { streamId, capsuleVersion, offset = 0, limit = 10 } = parsed.data;
  const ambient = getDispatchContext();
  const correlation = ambient === undefined ? {} : { operationId: ambient.operationId, correlationId: ambient.correlationId,
    ...(ambient.causationId === undefined ? {} : { causationId: ambient.causationId }) };
  try {
    const rows = await ctx.eventStore.query(streamId);
    const named = rows.filter(row => row.type === 'workflow.prepared' && row.data?.capsuleVersion === capsuleVersion);
    const row = named[0];
    if (named.length !== 1 || row === undefined) return refusal('PREPARED_DETAIL_UNAVAILABLE', 'The named prepared record is missing or ambiguous.');
    const selection = selectPreparedAuthority(rows.filter(item => item.sequence <= row.sequence), streamId);
    if (selection === undefined || selection.sequence !== row.sequence || selection.record.capsuleVersion !== capsuleVersion) {
      return refusal('PREPARED_DETAIL_UNAVAILABLE', 'The named prepared record does not match its historical authority.');
    }
    const authority = await loadPreparedCustody(selection, ctx.eventStore.bundleStore);
    if (authority.capsule.provenance.compilerVersion !== 'exarchos-prepare-8') {
      return refusal('PREPARED_DETAIL_UNAVAILABLE', 'This historical compiler did not store complete task contexts.');
    }
    const items = preparedDetailItems(authority.capsule);
    if (offset > items.length) return refusal('INVALID_INPUT', 'The offset exceeds the number of prepared tasks.');
    const ref = selection.record.bundleRefs[0];
    if (ref === undefined || selection.record.bundleRefs.length !== 1) throw new Error('The prepared record must name exactly one custody bundle');
    const metadata: PreparedDetailMetadata = { operationId: selection.record.operationId, capsule: authority.capsule.identity,
      capsuleDigest: selection.record.capsuleDigest, bundleRefs: [ref], total: items.length };
    let page = preparedDetailCarrier(metadata, [], offset, limit, correlation, warnings);
    for (let count = 1; count <= Math.min(limit, items.length - offset); count++) {
      const candidate = preparedDetailCarrier(metadata, items.slice(offset, offset + count), offset, limit, correlation, warnings);
      if (estimateOutputTokens(candidate) > PREPARE_ECONOMY_BUDGET_TOKENS) continue;
      page = candidate;
    }
    if ((offset < items.length && page.data.count === 0) || estimateOutputTokens(page) > PREPARE_ECONOMY_BUDGET_TOKENS) {
      return refusal('PREPARED_DETAIL_UNAVAILABLE', 'A complete task cannot fit the bounded detail response.');
    }
    const checked = PreparedDetailOutputSchema.safeParse(page);
    if (!checked.success) return refusal('PREPARED_DETAIL_UNAVAILABLE', 'The stored detail metadata exceeds its declared envelope.');
    return page;
  } catch (error) {
    return refusal('PREPARED_DETAIL_UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }
}
