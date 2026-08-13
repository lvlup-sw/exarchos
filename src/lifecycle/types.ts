// ─── Shared handler result contract ─────────────────────────────────────────
//
// Hook handlers in this directory return a uniform shape that the hook adapter
// (`../adapters/hooks.ts`) forwards to stdout. Moved here from the deleted
// `../cli.ts` in task 3.8 so the contract outlives the dead entry point.

/** Result returned by hook-command handlers. */
export interface CommandResult {
  readonly error?: { readonly code: string; readonly message: string };
  readonly [key: string]: unknown;
}
