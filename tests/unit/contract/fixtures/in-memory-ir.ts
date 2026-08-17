// ─── The relocated declaration store, and the substitution corpus (DR-1, 007) ─
//
// Task 007 proves DR-1's relocation claim: *declaration storage can move into
// the #1258 Workflow Builder IR without editing any consumer*. This file holds
// the two things that proof needs — a REAL in-memory IR that can back the seam,
// and the probe corpus the compile-time substitution is run over.
//
// ## What is being proven, and by what mechanism
//
// The mechanism is **rung 2, compile-time**, and it is deliberately NOT the
// runtime fixture an earlier revision of this task specified. That revision
// asserted "zero consumer diff across the 10 consumers" from inside a fixture
// that never edits source — a claim true BY CONSTRUCTION, which therefore could
// not fail. A proof that cannot fail is the exact defect class this program
// exists to remove, so it is not rebuilt here.
//
// What replaces it:
//
//   1. Consumers import ONLY the accessor's types (`DeclarationSeam`,
//      `Declaration`) — never a storage module.
//   2. Relocation is performed as a **compile-time substitution**: the module at
//      {@link STORE_MODULE} is swapped from {@link STORE_BEFORE_RELOCATION} to
//      {@link STORE_AFTER_RELOCATION}, and `tsc` must still pass over the
//      byte-identical consumer sources.
//   3. **The falsifier** — the part the old version lacked —
//      {@link DIRECT_STORAGE_CONSUMER} imports the storage module directly. The
//      same substitution MUST fail to compile for it. That asymmetry is what
//      gives the proof discriminating power: if the substitution compiled clean
//      for a storage-coupled consumer too, the check would prove nothing.
//
// ## Why the two store variants differ the way they do
//
// Relocation is not "the same table behind a new name" — it is the table
// ceasing to exist at its old address. So {@link STORE_BEFORE_RELOCATION}
// exports a storage-internal binding (`REGISTRY_TABLE`, standing in for
// `registry.ts`'s `TOOL_REGISTRY` / `events/schemas.ts`'s
// `EVENT_EMISSION_REGISTRY`), and {@link STORE_AFTER_RELOCATION} does NOT: the
// declarations now live in the IR, reached through {@link openInMemoryIr}.
// Both variants export the same `openStore(): DeclarationSource`, which is the
// one thing the seam is wired to. That is the whole substitution.
//
// A consumer that named only the seam cannot tell the difference. A consumer
// that named `REGISTRY_TABLE` cannot compile. Those are the two outcomes the
// test asserts, and they are asserted against the SPECIFIC diagnostic, not
// against "some error happened".
//
// ## Why the probe sources are text, and never land on disk
//
// The probe modules are compiled from these strings through an in-memory
// compiler host; nothing is written to the tree. That is load-bearing in one
// direction: {@link DIRECT_STORAGE_CONSUMER} is a deliberate DR-1 violation, and
// committing it as a real file would redden the live declaration-seam census in
// `architecture/layer-boundaries-seam.ts`. Keeping it virtual lets the same
// seeded violation be judged by two independent authorities — the TypeScript
// checker and that static census — without poisoning the shipped tree.
//
// Everything else here IS real, on-disk, type-checked code: the substitution
// compiles {@link STORE_AFTER_RELOCATION} against this module's actual
// `openInMemoryIr` signature, so if the IR stopped being a valid
// `DeclarationSource` the relocation half of the proof would go red.
//
// ## Zero storage imports
//
// This module imports the declaration contract and nothing else — no registry,
// no event store. It is a declaration CONSUMER under the census's definition and
// abides by the same rule it helps enforce. (It sits under `__tests__/`, which
// `architecture/effect-ledger.ts` excludes from the scan, so it does not enter
// the live consumer denominator — see the test's note on that number.)

import { makeDeclaration, type AnyDeclaration, type DeclarationKind } from '../../../../src/contract/declaration.js';
import type { DeclarationSource } from '../../../../src/contract/declaration-seam.js';

// ─── The IR ─────────────────────────────────────────────────────────────────

/**
 * The registration payload carried as a declaration's `subject`.
 *
 * Deliberately the SAME shape in both store variants: relocation moves where a
 * declaration is stored, not what it declares. A consumer narrowing the subject
 * with its own guard (see {@link SEAM_CONSUMERS}) therefore keeps working across
 * the substitution — which is the practical content of "no consumer edit".
 */
export interface EventRow {
  readonly name: string;
  readonly source: string;
}

/**
 * A node in the relocated IR. IR-shaped in the sense `contract/declaration.ts`
 * defines: addressable by `(kind, id)`, cross-references carried as plain ids,
 * payload as data rather than a live object graph. It is a stand-in for the
 * #1258 Workflow Builder IR, not a model of it — the proof only needs a store
 * that is genuinely NOT the registry.
 */
export interface IrNode {
  readonly kind: DeclarationKind;
  readonly id: string;
  readonly authority: string;
  readonly boundTo: readonly string[];
  readonly payload: EventRow;
}

/**
 * The IR's contents. Chosen to mirror what {@link STORE_BEFORE_RELOCATION}
 * holds, so the substitution is observationally equivalent at the seam: same
 * keys, same authorities. If the two stores disagreed, a green compile would be
 * proving the consumers ignore their data rather than that relocation is
 * transparent.
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
 * Lower one IR node into the declaration envelope.
 *
 * The `switch` cases carry LITERAL kinds rather than passing `node.kind`
 * through, because `makeDeclaration` would otherwise infer `K = DeclarationKind`
 * and produce a record with `kind: 'action' | 'cli-verb' | 'event'`, which is
 * not assignable to the `AnyDeclaration` union. The usual repair is a type
 * assertion; narrowing on a literal needs none, and this module spends nothing
 * from the cast budget.
 *
 * The `default` branch binds `node.kind` at `never`, so adding a fourth
 * declaration kind is a COMPILE error here rather than a node silently dropped
 * from the relocated store.
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
 * Open the relocated store — the IR read as a {@link DeclarationSource}.
 *
 * This is the substitution's destination. It is a real implementation, not a
 * stub: `STORE_AFTER_RELOCATION` imports this exact function, so the
 * compile-time proof only passes while the IR genuinely satisfies the port the
 * accessor takes.
 */
export function openInMemoryIr(nodes: readonly IrNode[] = IR_NODES): DeclarationSource {
  return Object.freeze({
    read(): Iterable<AnyDeclaration> {
      return nodes.map(lowerToDeclaration);
    },
  });
}

// ─── The probe corpus ───────────────────────────────────────────────────────
//
// Module names are relative to {@link PROBE_DIR}. The test resolves them to
// absolute paths for the compiler host and to scan-root-relative paths for the
// declaration-seam census, so both authorities judge the same seeded modules.

/** The probe directory, relative to the MCP `src/` scan root. */
export const PROBE_DIR = 'contract/__tests__/fixtures';

/** The one module the substitution swaps. Consumers must never name it. */
export const STORE_MODULE = '__declaration-store__.ts';

/** Wires the store to the accessor. The legitimate double-importer. */
export const COMPOSITION_ROOT_MODULE = '__composition-root__.ts';

/** The seeded DR-1 violation — the falsifier. Virtual; never written to disk. */
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
 * The store AFTER relocation: the same `openStore()` port, now reading the IR.
 *
 * `REGISTRY_TABLE` is GONE — that is what relocation means. Note this variant
 * imports the real `in-memory-ir.js` from disk, so the substitution is checked
 * against this module's actual exported signatures. It is the ONE probe whose
 * specifier is not relative to `PROBE_DIR`: the probes are rooted at their
 * virtual `src/` address, and task 030 moved this file out to `tests/`, so
 * reaching the real module means crossing back over explicitly.
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
 * The seam-abiding consumers — the substitution's denominator.
 *
 * Each imports ONLY the accessor and the envelope, and each exercises a
 * different part of the read surface (`list`, `get`/`has`, `keys`/`size`, and
 * subject narrowing through `withSubject`). Between them they cover every method
 * on `DeclarationSeam`, so a relocation that broke any part of the read surface
 * would surface here rather than being missed by a one-method probe.
 *
 * The `withSubject` consumer matters most: it recovers per-consumer exactness on
 * the payload WITHOUT importing storage — which is the posture the accessor's
 * header argues for, and the one #1258 forces once a subject has crossed a
 * deserialization boundary.
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
 * **The falsifier.** A consumer that reads the seam AND reaches into storage.
 *
 * It compiles against {@link STORE_BEFORE_RELOCATION} — so it is a realistic
 * module somebody could write today, not a syntactically broken one — and must
 * FAIL to compile against {@link STORE_AFTER_RELOCATION}, because
 * `REGISTRY_TABLE` no longer exists once declarations move into the IR.
 *
 * Without this module the substitution would be unfalsifiable: compiling
 * consumers that could not possibly reference storage proves only that they
 * do not. This one CAN, and the compiler is what says so.
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
