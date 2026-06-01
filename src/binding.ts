/**
 * Binding-directive renderer (#1485).
 *
 * The cross-harness "use Exarchos for SDLC" orientation directive has a single
 * source of truth — `binding-src/binding.md` — rendered into every runtime's
 * always-loaded instructions surface (`AGENTS.md` / `CLAUDE.md`) as a
 * marker-fenced block, and (for injection-capable hosts) into the SessionStart
 * hook's `additionalContext`. This module owns the block rendering; the
 * per-runtime artifact placement lives in `build-hooks.ts`.
 *
 * The markers make the block idempotently re-renderable and, later (v2.10.2
 * `onboard`), mergeable into a consumer's existing instructions file without
 * clobbering surrounding content.
 */

import { render } from './build-skills.js';

/** Source-of-truth directive filename under `binding-src/`. */
export const BINDING_SOURCE_FILE = 'binding.md';

/** Fence opening the generated binding region. */
export const BINDING_MARKER_START = '<!-- exarchos:binding:start -->';

/** Fence closing the generated binding region. */
export const BINDING_MARKER_END = '<!-- exarchos:binding:end -->';

/**
 * Render the binding directive `body` with a runtime's placeholders and wrap it
 * in the idempotent marker fence. `{{MCP_PREFIX}}` / `{{COMMAND_PREFIX}}` are
 * substituted via the shared skills `render()` engine (throws on an unknown
 * token in the body — the directive vocabulary is deliberately tiny).
 */
export function renderBindingBlock(
  body: string,
  placeholders: Record<string, string>,
  context: { sourcePath?: string; runtimeName?: string } = {},
): string {
  const rendered = render(body, placeholders, context).trim();
  return `${BINDING_MARKER_START}\n${rendered}\n${BINDING_MARKER_END}\n`;
}
