/**
 * Binding-directive renderer (#1485; neutralized in the harness conform-and-shrink
 * bundle, DR-5).
 *
 * The cross-harness "use Exarchos for SDLC" orientation directive has a single
 * source of truth — `content/harness/binding/binding.md` — rendered into a single,
 * runtime-neutral marker-fenced block. The directive prose now uses the logical
 * `exarchos:exarchos_*` tool form (Anthropic's harness-neutral `Server:tool`
 * convention) instead of a per-harness `{{MCP_PREFIX}}` token, so ONE block
 * serves every runtime's always-loaded instructions surface (`AGENTS.md` /
 * `CLAUDE.md`) and every injection-capable host's SessionStart directive. This
 * module owns the block rendering; the artifact placement lives in
 * `build-hooks.ts` (one `binding/standard/block.md`).
 *
 * The markers make the block idempotently re-renderable and, later (v2.10.2
 * `onboard`), mergeable into a consumer's existing instructions file without
 * clobbering surrounding content.
 */

import { render } from './build-skills.js';

/** Source-of-truth directive filename under `content/harness/binding/`. */
export const BINDING_SOURCE_FILE = 'binding.md';

/** Fence opening the generated binding region. */
export const BINDING_MARKER_START = '<!-- exarchos:binding:start -->';

/** Fence closing the generated binding region. */
export const BINDING_MARKER_END = '<!-- exarchos:binding:end -->';

/**
 * Wrap the runtime-neutral binding directive `body` in the idempotent marker
 * fence. The directive is now placeholder-free logical prose (one block for
 * every harness), so there is no runtime/placeholder argument — the collapse
 * is DR-5. `body` is still passed through the shared skills `render()` engine
 * with an empty placeholder map purely as a guard: any stray `{{TOKEN}}`
 * re-introduced into the directive throws `unknown placeholder` at build time
 * rather than silently shipping a literal token in the block.
 */
export function renderBindingBlock(body: string): string {
  const rendered = render(body, {}).trim();
  return `${BINDING_MARKER_START}\n${rendered}\n${BINDING_MARKER_END}\n`;
}
