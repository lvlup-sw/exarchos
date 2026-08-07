import { describe, it, expect } from 'vitest';

import {
  openDeclarationSeam,
  withSubject,
  type DeclarationSource,
} from './declaration-seam.js';
import {
  DECLARATION_KINDS,
  declareAction,
  declareCliVerb,
  declareEvent,
  type AnyDeclaration,
  type DeclarationKind,
} from './declaration.js';

/** A source over a fixed declaration list — the shape task 007 substitutes. */
const sourceOf = (declarations: readonly AnyDeclaration[]): DeclarationSource => ({
  read: () => declarations,
});

const anEvent = (id: string, subject: unknown = { source: 'auto' }): AnyDeclaration =>
  declareEvent({ id, authority: 'registry', boundTo: ['skill-prose'], subject });
const anAction = (id: string): AnyDeclaration =>
  declareAction({ id, authority: 'registry', boundTo: [], subject: { name: id } });
const aCliVerb = (id: string): AnyDeclaration =>
  declareCliVerb({ id, authority: 'registry', boundTo: [], subject: { verb: id } });

describe('openDeclarationSeam — the read surface', () => {
  it('openDeclarationSeam_MixedKinds_ListsOnlyTheRequestedKind', () => {
    const seam = openDeclarationSeam(
      sourceOf([anEvent('worktree.acquired'), anAction('acquire_worktree'), aCliVerb('acquire')]),
    );

    expect(seam.list('event').map((d) => d.id)).toEqual(['worktree.acquired']);
    expect(seam.list('action').map((d) => d.id)).toEqual(['acquire_worktree']);
    expect(seam.list('cli-verb').map((d) => d.id)).toEqual(['acquire']);
  });

  it('openDeclarationSeam_EveryDeclaredKind_HasItsOwnBucket', () => {
    // Pins the partition against the kind tuple: a fourth kind added to
    // DECLARATION_KINDS but not to the partition switch would silently land in
    // no bucket, and `list` would report an empty set instead of failing.
    const declarations = DECLARATION_KINDS.map((kind): AnyDeclaration => {
      if (kind === 'event') return anEvent('e');
      if (kind === 'action') return anAction('a');
      return aCliVerb('c');
    });
    const seam = openDeclarationSeam(sourceOf(declarations));

    for (const kind of DECLARATION_KINDS) {
      expect(seam.list(kind), `kind "${kind}" has no bucket`).toHaveLength(1);
    }
    expect(seam.size).toBe(DECLARATION_KINDS.length);
  });

  it('openDeclarationSeam_KnownKindAndId_ReturnsThatDeclaration', () => {
    const seam = openDeclarationSeam(sourceOf([anEvent('task.completed')]));

    const found = seam.get('event', 'task.completed');
    expect(found?.kind).toBe('event');
    expect(found?.authority).toBe('registry');
  });

  it('openDeclarationSeam_UnknownId_ReturnsUndefinedWithoutThrowing', () => {
    const seam = openDeclarationSeam(sourceOf([anEvent('task.completed')]));

    expect(seam.get('event', 'never.registered')).toBeUndefined();
    expect(seam.has('event', 'never.registered')).toBe(false);
  });

  it('openDeclarationSeam_SameIdInTwoKinds_ResolvesPerKindNotGlobally', () => {
    // Ids are unique WITHIN a kind, never globally (declaration.ts). A seam that
    // keyed on the bare id would return whichever landed last.
    const seam = openDeclarationSeam(sourceOf([anEvent('export'), aCliVerb('export')]));

    expect(seam.get('event', 'export')?.kind).toBe('event');
    expect(seam.get('cli-verb', 'export')?.kind).toBe('cli-verb');
    expect(seam.keys()).toEqual(['cli-verb:export', 'event:export']);
  });

  it('openDeclarationSeam_UnorderedSource_ProducesIdenticalKeyOrderAcrossOpens', () => {
    // @oracle-sources: (1) the shuffled input list, whose membership is fixed by
    // the test author independently of the seam; (2) a second open over a
    // DIFFERENT input permutation. Agreement across permutations is the property
    // — not a value re-derived from the module under test.
    const forward = [anEvent('b.two'), anEvent('a.one'), anEvent('c.three')];
    const reversed = [...forward].reverse();

    const first = openDeclarationSeam(sourceOf(forward)).keys();
    const second = openDeclarationSeam(sourceOf(reversed)).keys();

    expect(first).toEqual(second);
    expect(first).toEqual(['event:a.one', 'event:b.two', 'event:c.three']);
  });

  it('openDeclarationSeam_UnorderedSource_ListsEachKindOrderedById', () => {
    // `keys()` sorts independently, so it cannot witness the per-kind ordering
    // contract `list` states. This pins `list` itself: two opens over different
    // permutations of the same declarations must hand out the same sequence.
    // @oracle-sources: (1) the two input permutations, fixed by the test author
    // and not derived from the module; (2) the declared contract "ordered by
    // Declaration.id", spelled out here as a literal expectation.
    const forward = [anEvent('b.two'), anEvent('a.one'), anEvent('c.three')];
    const reversed = [...forward].reverse();

    const first = openDeclarationSeam(sourceOf(forward)).list('event').map((d) => d.id);
    const second = openDeclarationSeam(sourceOf(reversed)).list('event').map((d) => d.id);

    expect(first).toEqual(['a.one', 'b.two', 'c.three']);
    expect(second).toEqual(first);
  });

  it('openDeclarationSeam_DuplicateKindAndId_PreservesBothForTheAuthorityCensus', () => {
    // Two declarations claiming one subject IS the G1/G5 finding. The seam must
    // not collapse it, or the census that reports it would never see it.
    const first = declareEvent({ id: 'dup', authority: 'registry', boundTo: [], subject: 1 });
    const second = declareEvent({ id: 'dup', authority: 'handshake', boundTo: [], subject: 2 });
    const seam = openDeclarationSeam(sourceOf([first, second]));

    expect(seam.list('event')).toHaveLength(2);
    expect(seam.list('event').map((d) => d.authority)).toEqual(['registry', 'handshake']);
    expect(seam.get('event', 'dup')?.authority).toBe('registry');
    expect(seam.size).toBe(2);
  });

  it('openDeclarationSeam_EmptySource_ReturnsAnEmptySeamRatherThanThrowing', () => {
    const seam = openDeclarationSeam(sourceOf([]));

    expect(seam.size).toBe(0);
    expect(seam.keys()).toEqual([]);
    expect(seam.list('event')).toEqual([]);
    expect(seam.get('action', 'anything')).toBeUndefined();
  });

  it('openDeclarationSeam_SourceMutatedAfterOpen_SeamKeepsItsSnapshot', () => {
    const backing: AnyDeclaration[] = [anEvent('first')];
    const seam = openDeclarationSeam(sourceOf(backing));

    backing.push(anEvent('second'));

    expect(seam.size).toBe(1);
    expect(seam.get('event', 'second')).toBeUndefined();
  });

  it('openDeclarationSeam_ReturnedList_IsFrozenAgainstConsumerMutation', () => {
    // A consumer cannot write back through the read surface into the store.
    // `defineProperty` rather than `push` so the attempt needs no type cast.
    const appendTo = (array: readonly unknown[]): void => {
      Object.defineProperty(array, array.length, { value: 'injected', enumerable: true });
    };
    const seam = openDeclarationSeam(sourceOf([anEvent('only')]));
    const listed = seam.list('event');

    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => appendTo(listed)).toThrow(TypeError);
    expect(seam.list('event')).toHaveLength(1);
  });

  it('openDeclarationSeam_LazySource_IsDrainedExactlyOnce', () => {
    // The source is a substitution point, so it may be a generator over relocated
    // storage. Draining it twice would yield an empty second read.
    let reads = 0;
    const lazy: DeclarationSource = {
      *read() {
        reads += 1;
        yield anEvent('lazy');
      },
    };

    const seam = openDeclarationSeam(lazy);
    seam.list('event');
    seam.get('event', 'lazy');
    seam.keys();

    expect(reads).toBe(1);
    expect(seam.size).toBe(1);
  });
});

describe('withSubject — the recovered exactness of the rejected kind-indexed map', () => {
  interface EventSubject {
    readonly source: 'auto' | 'model';
  }
  const isEventSubject = (value: unknown): value is EventSubject =>
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    (value.source === 'auto' || value.source === 'model');

  it('withSubject_SubjectMatchingGuard_ReturnsANarrowedDeclaration', () => {
    const seam = openDeclarationSeam(sourceOf([anEvent('typed', { source: 'model' })]));
    const declaration = seam.get('event', 'typed');
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;

    const narrowed = withSubject(declaration, isEventSubject);

    expect(narrowed?.subject.source).toBe('model');
  });

  it('withSubject_SubjectFailingGuard_ReturnsUndefinedRatherThanAnUncheckedSubject', () => {
    const seam = openDeclarationSeam(sourceOf([anEvent('untyped', { nothing: true })]));
    const declaration = seam.get('event', 'untyped');
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;

    expect(withSubject(declaration, isEventSubject)).toBeUndefined();
  });

  it('withSubject_NarrowedDeclaration_CarriesTheIdentityAndTopologyFieldsUnchanged', () => {
    const seam = openDeclarationSeam(sourceOf([anEvent('same', { source: 'auto' })]));
    const declaration = seam.get('event', 'same');
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;

    const narrowed = withSubject(declaration, isEventSubject);

    expect(narrowed).toEqual(declaration);
    expect(Object.isFrozen(narrowed)).toBe(true);
  });

  it('withSubject_NarrowedDeclaration_StillFlowsBackThroughTheWidenedSeamType', () => {
    // The variance the defaulted type parameter buys and a kind-indexed subject
    // map would have cost: a narrowed declaration remains usable everywhere the
    // seam's widened form is expected.
    const seam = openDeclarationSeam(sourceOf([anEvent('widen', { source: 'auto' })]));
    const declaration = seam.get('event', 'widen');
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;

    const narrowed = withSubject(declaration, isEventSubject);
    expect(narrowed).toBeDefined();
    if (narrowed === undefined) return;

    const roundTripped = openDeclarationSeam(sourceOf([narrowed]));
    const kind: DeclarationKind = 'event';
    expect(roundTripped.get(kind, 'widen')?.id).toBe('widen');
  });
});
