// ─── Compile-time proof: a serializable stand-in is not a binding (P03-04) ───
//
// A `*.type-test.ts` entrypoint (tsc-gated, no runtime). It asserts the TYPE-
// SYSTEM half of "non-serializable implementation binding": a string name or a
// plain object cannot be minted as / assigned to an `ImplementationBinding`.
// If any `@ts-expect-error` below stops erroring, `tsc --noEmit` fails.
// ────────────────────────────────────────────────────────────────────────────

import {
  implementationBinding,
  type CompositeHandlerLoader,
  type ImplementationBinding,
} from './binding-table.js';
import { it, expect } from 'vitest';

const realLoader: CompositeHandlerLoader = async () => async () => ({ success: true });

// A real function loader is accepted (positive control — must compile).
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
