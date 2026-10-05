/**
 * Renders the binding directive. The directive source is
 * `content/harness/binding/binding.md`. It uses the logical
 * `exarchos:exarchos_*` tool form, so one marker-fenced block serves every runtime.
 * The markers let a later render replace the block without a change to the text around it.
 * `build-hooks.ts` writes the block to `binding/standard/block.md`.
 */

import { render } from './build-skills.js';

/** Source-of-truth directive filename under `content/harness/binding/`. */
export const BINDING_SOURCE_FILE = 'binding.md';

/** Fence opening the generated binding region. */
export const BINDING_MARKER_START = '<!-- exarchos:binding:start -->';

/** Fence closing the generated binding region. */
export const BINDING_MARKER_END = '<!-- exarchos:binding:end -->';

/**
 * Wrap the binding directive `body` in the marker fence.
 * The empty placeholder map is a guard: a stray `{{TOKEN}}` in the directive
 * throws `unknown placeholder` at build time.
 */
export function renderBindingBlock(body: string): string {
  const rendered = render(body, {}).trim();
  return `${BINDING_MARKER_START}\n${rendered}\n${BINDING_MARKER_END}\n`;
}
