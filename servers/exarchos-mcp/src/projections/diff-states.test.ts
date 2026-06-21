import { describe, it, expect } from 'vitest';
import { diffStates } from './diff-states.js';

describe('diffStates (T4) — pure structural delta of two projected States', () => {
  describe('diffStates_identicalStates_returnsEmptyDelta', () => {
    it('returns an empty delta when both sides are the same value', () => {
      const s = { phase: 'plan', tasks: [{ id: 't1', status: 'open' }] };
      expect(diffStates(s, s)).toEqual({ added: {}, removed: {}, changed: {} });
    });

    it('returns an empty delta for structurally-equal but distinct objects', () => {
      const a = { phase: 'plan', count: 3, nested: { k: 1 } };
      const b = { phase: 'plan', count: 3, nested: { k: 1 } };
      expect(diffStates(a, b)).toEqual({ added: {}, removed: {}, changed: {} });
    });
  });

  describe('diffStates_addedKey_appearsInAdded', () => {
    it('records a top-level key present only in b under added, keyed by path', () => {
      const a = { phase: 'plan' };
      const b = { phase: 'plan', owner: 'reed' };
      const delta = diffStates(a, b);
      expect(delta.added).toEqual({ owner: 'reed' });
      expect(delta.removed).toEqual({});
      expect(delta.changed).toEqual({});
    });

    it('records a nested key present only in b under its dot-path', () => {
      const a = { meta: { phase: 'plan' } };
      const b = { meta: { phase: 'plan', sealed: true } };
      const delta = diffStates(a, b);
      expect(delta.added).toEqual({ 'meta.sealed': true });
      expect(delta.removed).toEqual({});
      expect(delta.changed).toEqual({});
    });
  });

  describe('diffStates_removedKey_appearsInRemoved', () => {
    it('records a top-level key present only in a under removed, keyed by path', () => {
      const a = { phase: 'plan', owner: 'reed' };
      const b = { phase: 'plan' };
      const delta = diffStates(a, b);
      expect(delta.removed).toEqual({ owner: 'reed' });
      expect(delta.added).toEqual({});
      expect(delta.changed).toEqual({});
    });

    it('records a nested key present only in a under its dot-path', () => {
      const a = { meta: { phase: 'plan', sealed: true } };
      const b = { meta: { phase: 'plan' } };
      const delta = diffStates(a, b);
      expect(delta.removed).toEqual({ 'meta.sealed': true });
      expect(delta.added).toEqual({});
      expect(delta.changed).toEqual({});
    });
  });

  describe('diffStates_changedValue_appearsInChangedKeyedByPath', () => {
    it('records a primitive value change as { from, to } keyed by path', () => {
      const a = { phase: 'plan' };
      const b = { phase: 'delegate' };
      const delta = diffStates(a, b);
      expect(delta.changed).toEqual({ phase: { from: 'plan', to: 'delegate' } });
      expect(delta.added).toEqual({});
      expect(delta.removed).toEqual({});
    });

    it('treats a type change at a path as a single changed entry', () => {
      const a = { value: 1 };
      const b = { value: '1' };
      const delta = diffStates(a, b);
      expect(delta.changed).toEqual({ value: { from: 1, to: '1' } });
    });
  });

  describe('diffStates_nestedObjects_keyedByDotPath', () => {
    it('descends into nested objects and arrays, keying leaves by dot-path', () => {
      const a = {
        phase: 'plan',
        tasks: [
          { id: 't1', status: 'open' },
          { id: 't2', status: 'open' },
        ],
      };
      const b = {
        phase: 'delegate',
        tasks: [
          { id: 't1', status: 'done' },
          { id: 't2', status: 'open' },
        ],
      };
      const delta = diffStates(a, b);
      expect(delta.changed).toEqual({
        phase: { from: 'plan', to: 'delegate' },
        'tasks.0.status': { from: 'open', to: 'done' },
      });
      expect(delta.added).toEqual({});
      expect(delta.removed).toEqual({});
    });

    it('reports an appended array element as an added dot-path leaf', () => {
      const a = { tasks: [{ id: 't1' }] };
      const b = { tasks: [{ id: 't1' }, { id: 't2' }] };
      const delta = diffStates(a, b);
      expect(delta.added).toEqual({ 'tasks.1.id': 't2' });
      expect(delta.removed).toEqual({});
      expect(delta.changed).toEqual({});
    });
  });

  describe('diffStates_roundTrip_applyingDeltaToAReconcilesToB', () => {
    // Applies the structural delta back onto `a` and asserts the result deep-equals `b`.
    // This is the load-bearing property: the delta must be lossless.
    function applyDelta(
      a: unknown,
      delta: ReturnType<typeof diffStates>,
    ): unknown {
      const root = structuredClone(a);

      const setPath = (target: unknown, path: string, value: unknown): unknown => {
        const segments = path.split('.');
        let cursor: Record<string, unknown> | unknown[];
        if (typeof target !== 'object' || target === null) {
          // The first segment dictates whether the container is an array or object.
          cursor = /^\d+$/.test(segments[0]) ? [] : {};
        } else {
          cursor = target as Record<string, unknown> | unknown[];
        }
        const head = cursor;
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          const next = (cursor as Record<string, unknown>)[seg];
          if (typeof next !== 'object' || next === null) {
            const child: Record<string, unknown> | unknown[] = /^\d+$/.test(
              segments[i + 1],
            )
              ? []
              : {};
            (cursor as Record<string, unknown>)[seg] = child;
            cursor = child;
          } else {
            cursor = next as Record<string, unknown> | unknown[];
          }
        }
        (cursor as Record<string, unknown>)[segments[segments.length - 1]] = value;
        return head;
      };

      // Oracle limitation (documented, not exercised): this applies `removed`
      // paths leaf-by-leaf. Removing a *multi-leaf array object element* (e.g.
      // both `tasks.1.id` and `tasks.1.status`) deletes the leaves but leaves a
      // hollow `{}` at that index rather than splicing the element out, and two
      // sibling primitive-array removals would splice shifting indices. The
      // fixtures below never remove a multi-leaf/array element, so the round-trip
      // holds. Production `diffStates` is unaffected — it only emits leaf deltas
      // and makes no apply/reconcile claim; this helper is a test oracle only.
      const deletePath = (target: unknown, path: string): void => {
        const segments = path.split('.');
        let cursor = target as Record<string, unknown> | unknown[];
        for (let i = 0; i < segments.length - 1; i++) {
          const next = (cursor as Record<string, unknown>)[segments[i]];
          if (typeof next !== 'object' || next === null) return;
          cursor = next as Record<string, unknown> | unknown[];
        }
        const leaf = segments[segments.length - 1];
        if (Array.isArray(cursor)) {
          (cursor as unknown[]).splice(Number(leaf), 1);
        } else {
          delete (cursor as Record<string, unknown>)[leaf];
        }
      };

      let result = root;
      for (const [path, value] of Object.entries(delta.added)) {
        result = setPath(result, path, value);
      }
      for (const [path, { to }] of Object.entries(delta.changed)) {
        result = setPath(result, path, to);
      }
      for (const path of Object.keys(delta.removed)) {
        deletePath(result, path);
      }
      return result;
    }

    it('reconciles a to b for a representative workflow-state pair', () => {
      const a = {
        phase: 'plan',
        owner: 'reed',
        tasks: [{ id: 't1', status: 'open' }],
        meta: { sealed: false },
      };
      const b = {
        phase: 'delegate',
        tasks: [
          { id: 't1', status: 'done' },
          { id: 't2', status: 'open' },
        ],
        meta: { sealed: false, gate: 'tdd' },
      };
      const delta = diffStates(a, b);
      expect(applyDelta(a, delta)).toEqual(b);
    });

    it('reconciles a to b when the only change is a removed nested key', () => {
      const a = { meta: { sealed: true, gate: 'tdd' } };
      const b = { meta: { sealed: true } };
      const delta = diffStates(a, b);
      expect(applyDelta(a, delta)).toEqual(b);
    });
  });

  describe('determinism', () => {
    it('produces byte-identical output across repeated calls (stable key ordering)', () => {
      const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
      const b = { b: 9, a: 2, c: { z: 1, y: 8 }, d: 3 };
      const first = JSON.stringify(diffStates(a, b));
      const second = JSON.stringify(diffStates(a, b));
      expect(first).toBe(second);
    });
  });
});
