/**
 * Result contract for the hook handlers in this directory. The CLI hook adapter
 * (`../adapters/cli/hooks.ts`) writes this result to stdout.
 */

/** Result returned by hook-command handlers. */
export interface CommandResult {
  readonly error?: { readonly code: string; readonly message: string };
  readonly [key: string]: unknown;
}
