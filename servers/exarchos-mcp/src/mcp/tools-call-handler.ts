/**
 * MCP `tools/call` handler shim (#1273 / C2 T30).
 *
 * Thin shared layer between the SDK's per-tool MCP handler (wired in
 * `adapters/mcp.ts`) and the transport-agnostic dispatch core. This
 * module owns ONE responsibility: take the inbound `tools/call` args
 * (which may include the SDK `task: { ttl? }` augmentation key per
 * #1273) and route them through `dispatch()` so the augmentation
 * branching documented in `core/dispatch.ts` (and implemented in
 * `dispatch/tasks-augmented.ts` from C1) takes effect.
 *
 * Why a separate module from `adapters/mcp.ts`:
 *
 *   1. The CLI `--follow` polling loop (C3) reuses the same primitive
 *      so a follow against an MCP-augmented dispatch shares one code
 *      path with the MCP adapter (INV-2 facade equivalence).
 *   2. Unit tests pin the contract without booting the MCP transport
 *      (see `tools-call-handler.test.ts`); the SDK round-trip stays
 *      covered by the `__tests__/integration/tools-call.test.ts`
 *      end-to-end probe.
 *
 * The `task` key is intentionally NOT stripped here — `dispatch()` is
 * the canonical detector + stripper (it must already handle direct
 * CLI callers that thread `task` for the CLI `--follow` path).
 */
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { toEnvelope } from '../format.js';
import type { Envelope, ErrorEnvelope } from '../format.js';

/**
 * Dispatch a `tools/call` request through the core dispatcher and
 * return the resulting envelope. Acts as the MCP-side entrypoint that
 * the adapter's per-tool handler delegates to; the SDK still wraps the
 * envelope into a `CallToolResult` carrier (see `toMcpResult` in
 * `adapters/mcp.ts`).
 */
export async function handleToolsCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<Envelope<unknown> | ErrorEnvelope> {
  const result = await dispatch(toolName, args, ctx);
  return toEnvelope(result);
}
