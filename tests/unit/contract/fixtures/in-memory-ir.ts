// The in-memory IR store and the probe corpus for the compile-time relocation proof.
//
// The proof swaps the module `STORE_MODULE` from `STORE_BEFORE_RELOCATION` to
// `STORE_AFTER_RELOCATION`. The seam consumers must compile against both stores with no edit.
// `DIRECT_STORAGE_CONSUMER` imports the storage module, so it must fail to compile after the swap.
//
// The probe sources are strings. An in-memory compiler host compiles them, and no probe is on disk.
// The TypeScript checker and the declaration-seam census both judge the seeded violation.
//
// This module imports the declaration contract only. It imports no registry and no event store.

import { makeDeclaration, type AnyDeclaration, type DeclarationKind } from '../../../../src/contract/declaration.js';
import type { DeclarationSource } from '../../../../src/contract/declaration-seam.js';

/**
 * The registration payload that a declaration carries as its `subject`.
 * Both store variants use this shape, so a consumer that narrows the subject with its own guard
 * reads the same payload from both.
 */
export interface EventRow {
  readonly name: string;
  readonly source: string;
}

/**
 * A node of the relocated IR: addressable by `(kind, id)`, with cross-references as plain ids and
 * the payload as data. It stands in for the Workflow Builder IR and does not model it.
 * The proof needs only a store that is not the registry.
 */
export interface IrNode {
  readonly kind: DeclarationKind;
  readonly id: string;
  readonly authority: string;
  readonly boundTo: readonly string[];
  readonly payload: EventRow;
}

/**
 * The contents of the IR. They hold the same keys and authorities as
 * {@link STORE_BEFORE_RELOCATION}, so the seam reads the same data from both stores.
 * No test compares the data of the two stores, so make each data edit in both.
 */
export const IR_NODES: readonly IrNode[] = Object.freeze([
  Object.freeze({
    kind: 'event',
    id: 'worktree.acquired',
    authority: 'registry',
    boundTo: Object.freeze(['cli', 'mcp']),
    payload: Object.freeze({ name: 'worktree.acquired', source: 'auto' }),
  }),
  Object.freeze({
    kind: 'event',
    id: 'task.assigned',
    authority: 'registry',
    boundTo: Object.freeze(['cli']),
    payload: Object.freeze({ name: 'task.assigned', source: 'manual' }),
  }),
]);

/**
 * Lowers one IR node into the declaration envelope.
 *
 * Each `case` passes a literal kind. With `node.kind`, `makeDeclaration` infers
 * `K = DeclarationKind`, and the result is not assignable to `AnyDeclaration` without a type
 * assertion. The `default` branch binds `node.kind` to `never`, so a new declaration kind is a
 * compile error here.
 */
function lowerToDeclaration(node: IrNode): AnyDeclaration {
  const { id, authority, boundTo, payload } = node;
  switch (node.kind) {
    case 'action':
      return makeDeclaration({ kind: 'action', id, authority, boundTo, subject: payload });
    case 'cli-verb':
      return makeDeclaration({ kind: 'cli-verb', id, authority, boundTo, subject: payload });
    case 'event':
      return makeDeclaration({ kind: 'event', id, authority, boundTo, subject: payload });
    default: {
      const unhandled: never = node.kind;
      throw new Error(`in-memory IR: unhandled declaration kind ${String(unhandled)}`);
    }
  }
}

/**
 * Opens the relocated store: the IR read as a {@link DeclarationSource}.
 * `STORE_AFTER_RELOCATION` imports this function, so the proof compiles against its real signature.
 */
export function openInMemoryIr(nodes: readonly IrNode[] = IR_NODES): DeclarationSource {
  return Object.freeze({
    read(): Iterable<AnyDeclaration> {
      return nodes.map(lowerToDeclaration);
    },
  });
}

/**
 * The probe directory, relative to the `src/` scan root. The probe module names are relative to it.
 * The test resolves each name to an absolute path for the compiler host.
 * For the declaration-seam census, it resolves each name to a path relative to the scan root.
 */
export const PROBE_DIR = 'contract/__tests__/fixtures';

/** The one module the substitution swaps. Consumers must never name it. */
export const STORE_MODULE = '__declaration-store__.ts';

/** Wires the store to the accessor. The legitimate double-importer. */
export const COMPOSITION_ROOT_MODULE = '__composition-root__.ts';

/** The seeded consumer that imports storage directly. The module is virtual and never on disk. */
export const DIRECT_STORAGE_CONSUMER_MODULE = '__consumer-direct-storage__.ts';

/**
 * The store BEFORE relocation: declarations held in a registry-shaped table,
 * with that table exported as a storage-internal binding. `REGISTRY_TABLE`
 * stands in for `TOOL_REGISTRY` / `EVENT_EMISSION_REGISTRY` — the thing a
 * storage-coupled consumer reaches for today.
 */
export const STORE_BEFORE_RELOCATION = `
import { declareEvent, type AnyDeclaration } from '../../declaration.js';
import type { DeclarationSource } from '../../declaration-seam.js';

export interface RegistryRow {
  readonly name: string;
  readonly source: string;
}

/** Storage-internal table. Exists ONLY before relocation. */
export const REGISTRY_TABLE: readonly RegistryRow[] = [
  { name: 'worktree.acquired', source: 'auto' },
  { name: 'task.assigned', source: 'manual' },
];

const BOUND_TO: Record<string, readonly string[]> = {
  'worktree.acquired': ['cli', 'mcp'],
  'task.assigned': ['cli'],
};

export function openStore(): DeclarationSource {
  return {
    read(): Iterable<AnyDeclaration> {
      return REGISTRY_TABLE.map((row) =>
        declareEvent({
          id: row.name,
          authority: 'registry',
          boundTo: BOUND_TO[row.name] ?? [],
          subject: row,
        }),
      );
    },
  };
}
`;

/**
 * The store after relocation: the same `openStore()` port, which now reads the IR.
 * This variant does not export `REGISTRY_TABLE`.
 *
 * It imports the real `in-memory-ir.js` from disk, so the substitution compiles against the
 * exported signatures of this module. The probes are rooted at a virtual `src/` address and this
 * file is under `tests/`, so this one specifier leaves the `src/` tree.
 */
export const STORE_AFTER_RELOCATION = `
import type { DeclarationSource } from '../../declaration-seam.js';
import { openInMemoryIr, IR_NODES } from '../../../../tests/unit/contract/fixtures/in-memory-ir.js';

export function openStore(): DeclarationSource {
  return openInMemoryIr(IR_NODES);
}
`;

/**
 * The composition root: the ONE module that legitimately names both the store
 * and the accessor. Its source is identical across the substitution — it calls
 * `openStore()`, not the table — which is why relocation does not edit it
 * either. Under the declaration-seam census this is a declared source adapter.
 */
export const COMPOSITION_ROOT = `
import { openDeclarationSeam, type DeclarationSeam } from '../../declaration-seam.js';
import { openStore } from './__declaration-store__.js';

export function openSeam(): DeclarationSeam {
  return openDeclarationSeam(openStore());
}
`;

/**
 * The consumers that obey the seam. The substitution compiles each one against both stores.
 *
 * Each consumer imports only the accessor and the envelope. Together they use each member of
 * `DeclarationSeam`: `list`, `get`, `has`, `keys` and `size`.
 * The `withSubject` consumer narrows the payload to an exact type and imports no storage.
 */
export const SEAM_CONSUMERS: ReadonlyMap<string, string> = new Map([
  [
    '__consumer-list__.ts',
    `
import type { Declaration, DeclarationKind } from '../../declaration.js';
import type { DeclarationSeam } from '../../declaration-seam.js';

export function listIds<K extends DeclarationKind>(
  seam: DeclarationSeam,
  kind: K,
): readonly string[] {
  return seam.list(kind).map((declaration: Declaration<K>) => declaration.id);
}
`,
  ],
  [
    '__consumer-lookup__.ts',
    `
import type { DeclarationSeam } from '../../declaration-seam.js';

export function authorityOf(seam: DeclarationSeam, id: string): string | undefined {
  return seam.has('event', id) ? seam.get('event', id)?.authority : undefined;
}
`,
  ],
  [
    '__consumer-census__.ts',
    `
import type { DeclarationSeam } from '../../declaration-seam.js';

export function addressableSurface(seam: DeclarationSeam): {
  readonly keys: readonly string[];
  readonly size: number;
} {
  return { keys: seam.keys(), size: seam.size };
}
`,
  ],
  [
    '__consumer-narrow__.ts',
    `
import { withSubject, type DeclarationSeam } from '../../declaration-seam.js';

interface EventRow {
  readonly name: string;
  readonly source: string;
}

function isEventRow(value: unknown): value is EventRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

export function emissionSourceOf(seam: DeclarationSeam, id: string): string | undefined {
  const declaration = seam.get('event', id);
  if (declaration === undefined) return undefined;
  return withSubject(declaration, isEventRow)?.subject.source;
}
`,
  ],
]);

/**
 * The falsifier: a consumer that reads the seam and also imports storage.
 *
 * It compiles against {@link STORE_BEFORE_RELOCATION}. It must fail to compile against
 * {@link STORE_AFTER_RELOCATION}, because that store does not export `REGISTRY_TABLE`.
 * The seam consumers do not name storage, so only this module lets the substitution fail.
 */
export const DIRECT_STORAGE_CONSUMER = `
import type { DeclarationSeam } from '../../declaration-seam.js';
import { REGISTRY_TABLE } from './__declaration-store__.js';

export function rowCount(seam: DeclarationSeam): number {
  return REGISTRY_TABLE.length + seam.size;
}
`;

/** The symbol whose disappearance IS the relocation, named once for the assertion. */
export const RELOCATED_STORAGE_SYMBOL = 'REGISTRY_TABLE';
