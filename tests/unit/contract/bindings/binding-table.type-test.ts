// Type-level proof that a serializable stand-in is not an implementation binding.
//
// A string name or a plain object cannot become an `ImplementationBinding`.
// Each `@ts-expect-error` line marks a statement that the compiler must reject.
// The proof holds only in a `tsc` program that includes this file.
// `tests/tsconfig.json` excludes `unit/**`, so `npm run typecheck` does not compile this file.

import {
  implementationBinding,
  type CompositeHandlerLoader,
  type ImplementationBinding,
} from '../../../../src/contract/bindings/binding-table.js';
import { it, expect } from 'vitest';

const realLoader: CompositeHandlerLoader = async () => async () => ({ success: true });

/** Positive control: the compiler accepts a real function loader. */
const ok: ImplementationBinding = implementationBinding('exarchos_workflow', realLoader);
void ok;

// @ts-expect-error — a string name is not a handler-loader function.
implementationBinding('exarchos_workflow', 'handleWorkflow');

// @ts-expect-error — a serializable descriptor object is not a handler-loader.
implementationBinding('exarchos_workflow', { module: './workflow/composite.js' });

// @ts-expect-error — a plain object cannot satisfy the opaque branded holder.
const forged: ImplementationBinding = { tool: 'exarchos_workflow', load: realLoader };
void forged;

it('binding-table type-test anchor', () => {
  expect(true).toBe(true);
});
