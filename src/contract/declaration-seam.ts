/**
 * The declaration seam: the one read path for event, action and CLI-verb declarations.
 * The declaration-seam census in `architecture/layer-boundaries-seam.ts` fails a module that
 * imports the declaration contract and a declaration-storage module together.
 * {@link openDeclarationSeam} takes the store through {@link DeclarationSource}, so a new store
 * replaces the source with no consumer edit. This module imports no registry or storage module.
 *
 * `subject` stays a defaulted type parameter, not a kind-indexed map. A map in
 * `contract/declaration.ts` must import subject types from registry storage, which the census
 * rejects. A consumer that needs an exact subject type narrows it with {@link withSubject}.
 */

import {
  declarationKey,
  type AnyDeclaration,
  type Declaration,
  type DeclarationId,
  type DeclarationKind,
} from './declaration.js';

/**
 * The source of declarations, and the one substitution point for a new store.
 * Consumers name {@link DeclarationSeam}, not this interface. `read` is a method, so a source can be lazy.
 */
export interface DeclarationSource {
  /** Every declaration this source holds, in any order. */
  read(): Iterable<AnyDeclaration>;
}

/**
 * Declarations partitioned by kind. It is a mapped type, not a `Map`, so an index by `K` gives
 * `readonly Declaration<K>[]` with no type assertion.
 */
export type DeclarationsByKind = {
  readonly [K in DeclarationKind]: readonly Declaration<K>[];
};

/** The read-only surface for declarations. It has no write method and no handle on the source. */
export interface DeclarationSeam {
  /**
   * Every declaration of one kind, ordered by {@link Declaration.id}.
   * Duplicates stay in the list, so the authority census can report two authorities for one address.
   */
  list<K extends DeclarationKind>(kind: K): readonly Declaration<K>[];

  /**
   * One declaration by its `(kind, id)` address, or `undefined`. For a duplicate address it returns
   * the first match in {@link list} order and does not fail.
   */
  get<K extends DeclarationKind>(kind: K, id: DeclarationId): Declaration<K> | undefined;

  /** Whether any declaration occupies this `(kind, id)` address. */
  has(kind: DeclarationKind, id: DeclarationId): boolean;

  /** Every declaration's `kind:id` key, sorted. A census enumerates these instead of the storage. */
  keys(): readonly string[];

  /** Total declarations held, duplicates included. */
  readonly size: number;
}

/**
 * Partitions a declaration stream by kind, with each bucket sorted by id.
 * The `switch` uses literal cases, so each case narrows with no type assertion.
 * A kind that the switch omits gets an empty bucket, so a test pins the buckets to `DECLARATION_KINDS`.
 * The sort is stable, so declarations with the same id keep their source order.
 */
function partitionByKind(source: DeclarationSource): DeclarationsByKind {
  const action: Declaration<'action'>[] = [];
  const cliVerb: Declaration<'cli-verb'>[] = [];
  const event: Declaration<'event'>[] = [];

  for (const declaration of source.read()) {
    switch (declaration.kind) {
      case 'action':
        action.push(declaration);
        break;
      case 'cli-verb':
        cliVerb.push(declaration);
        break;
      case 'event':
        event.push(declaration);
        break;
    }
  }

  const byId = <K extends DeclarationKind>(
    declarations: Declaration<K>[],
  ): readonly Declaration<K>[] =>
    Object.freeze([...declarations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  return Object.freeze({
    action: byId(action),
    'cli-verb': byId(cliVerb),
    event: byId(event),
  });
}

/**
 * Opens a read-only seam over a declaration source. It reads the source once and keeps a snapshot,
 * so the seam does not change after it opens. Open a new seam to see new declarations.
 *
 * @param source - the store to read through.
 */
export function openDeclarationSeam(source: DeclarationSource): DeclarationSeam {
  const byKind = partitionByKind(source);
  const size = byKind.action.length + byKind['cli-verb'].length + byKind.event.length;

  const keys = Object.freeze(
    [...byKind.action, ...byKind['cli-verb'], ...byKind.event].map(declarationKey).sort(),
  );

  return Object.freeze({
    list<K extends DeclarationKind>(kind: K): readonly Declaration<K>[] {
      return byKind[kind];
    },
    get<K extends DeclarationKind>(kind: K, id: DeclarationId): Declaration<K> | undefined {
      return byKind[kind].find((declaration) => declaration.id === id);
    },
    has(kind: DeclarationKind, id: DeclarationId): boolean {
      return byKind[kind].some((declaration) => declaration.id === id);
    },
    keys(): readonly string[] {
      return keys;
    },
    size,
  });
}

/**
 * Narrows a declaration's subject through a type guard that the caller supplies.
 * The consumer that knows the subject type owns the guard, so the envelope stays free of storage types.
 * It returns `undefined` when the guard rejects the subject.
 *
 * @param declaration - a declaration from a {@link DeclarationSeam}.
 * @param isSubject - the consumer's guard over the subject payload.
 */
export function withSubject<K extends DeclarationKind, S>(
  declaration: Declaration<K>,
  isSubject: (value: unknown) => value is S,
): Declaration<K, S> | undefined {
  const subject = declaration.subject;
  if (!isSubject(subject)) return undefined;
  return Object.freeze({
    kind: declaration.kind,
    id: declaration.id,
    authority: declaration.authority,
    boundTo: declaration.boundTo,
    subject,
  });
}
