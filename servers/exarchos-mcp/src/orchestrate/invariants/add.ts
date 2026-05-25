/**
 * `invariants_add` handler (P2, T8/T9/T11). Skeleton — implemented in T8.
 */
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { ScaffoldDeps } from './scaffold.js';

export interface HandleAddArgs {
  readonly repoRoot: string;
  readonly entry: Record<string, unknown>;
  readonly catalog?: string;
  readonly tier?: 'dev' | 'user';
  readonly id?: string;
  readonly dryRun?: boolean;
}

export async function handleAdd(
  _args: HandleAddArgs,
  _ctx: DispatchContext,
  _deps: ScaffoldDeps,
): Promise<ToolResult> {
  return {
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'invariants_add is not yet implemented' },
  };
}
