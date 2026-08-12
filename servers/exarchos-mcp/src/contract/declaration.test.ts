// ─── DR-1 / task 005 — the IR-shaped declaration envelope ───────────────────
//
// Two independent authorities, per DR-30:
//   • `./declaration.ts` — the envelope: what the three lift helpers actually
//     construct at runtime, and the field list it declares as data; and
//   • `../registry.ts` — the LIVE registration corpus (the tool registry, and
//     transitively the event-emission registry it re-exports), authored with no
//     knowledge that this envelope exists.
//
// Neither is computed from the other — `declaration.ts` imports NOTHING, by
// design, and no registration site imports it — so they can genuinely disagree.
// That is the property being relied on: if a lift helper started adding a field
// the others lack, or stopped carrying a registration through unmodified, the
// two sources diverge and the assertions below go red. Verified by kill probe.
//
// `../event-store/schemas.ts` is deliberately NOT listed as a third authority:
// `registry.ts` imports it, so it is DERIVED from an already-named source
// rather than independent of it.
//
// @oracle-sources: ./declaration.ts, ../registry.ts
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  DECLARATION_FIELDS,
  DECLARATION_KINDS,
  DeclarationError,
  declareAction,
  declareCliVerb,
  declareEvent,
  declarationKey,
  isDeclaration,
  makeDeclaration,
  type AnyDeclaration,
} from './declaration.js';
import { TOOL_REGISTRY, type ToolAction } from '../registry.js';
import { EVENT_EMISSION_REGISTRY } from '../events/schemas.js';

// ─── DR-1, task 005 — the IR-shaped declaration envelope ────────────────────
//
// Where each half of each guarantee is enforced:
//
//   • The COMPILE-time proofs are exported type aliases at the bottom of
//     `declaration.ts`, NOT here. `tsconfig.json` excludes `**/*.test.ts`, so a
//     type-level assertion in this file would never be seen by `tsc` and would
//     be decorative. The idiom is the `_Pola*` block in
//     `capabilities/resolver.ts`. `npm run typecheck` is their gate.
//   • The RUNTIME halves are here. They are the ones that still hold after a
//     declaration crosses an untyped boundary — which is exactly what task
//     007's storage relocation makes every declaration do.

/** Every `<tool>.<action>` pair in the live registry, paired with its tool. */
function liveActions(): { tool: string; action: ToolAction }[] {
  return TOOL_REGISTRY.flatMap((tool) =>
    tool.actions.map((action) => ({ tool: tool.name, action })),
  );
}

/** The live registry's real CLI verbs: actions hoisted to a top-level command. */
function liveCliVerbs(): { verb: string; tool: string; action: ToolAction }[] {
  return liveActions()
    .filter(({ action }) => typeof action.cli?.topLevel === 'string')
    .map(({ tool, action }) => ({ verb: action.cli?.topLevel ?? '', tool, action }));
}

describe('Declaration', () => {
  it('Declaration_ExistingRegistrations_CompileUnchanged', () => {
    // ── The compile half ──────────────────────────────────────────────────
    // "Existing registrations compile untouched" is proven by `tsc` passing
    // over the whole `src/**` tree with ZERO edits to any registration site —
    // `registry.ts`, `events/schemas.ts` and the CLI hints are byte-
    // identical on this branch. That is a real, gate-enforced proof
    // (`npm run typecheck`), but it is not one vitest can make, because vitest
    // strips types without checking them. Stating it plainly rather than
    // dressing a type assertion up as a runtime one.
    //
    // ── The runtime half, which vitest CAN prove ───────────────────────────
    // Additivity means lifting is a pure PROJECTION out of existing values: it
    // reads registrations, never rewrites them, and never requires them to grow
    // a field. Asserted below over the REAL registries, totally (not over one
    // cherry-picked entry), with a non-empty denominator so the loops cannot
    // pass vacuously.

    const eventsBefore = { ...EVENT_EMISSION_REGISTRY };
    const eventEntries = Object.entries(EVENT_EMISSION_REGISTRY);
    expect(eventEntries.length).toBeGreaterThan(100);

    for (const [name, source] of eventEntries) {
      const declaration = declareEvent({
        id: name,
        authority: 'event-emission-registry',
        boundTo: ['event-data-schemas'],
        subject: { source },
      });
      expect(declaration.kind).toBe('event');
      expect(declaration.id).toBe(name);
    }

    // The registration store is untouched by having been read.
    expect({ ...EVENT_EMISSION_REGISTRY }).toEqual(eventsBefore);

    const actions = liveActions();
    expect(actions.length).toBeGreaterThan(20);

    for (const { tool, action } of actions) {
      const keysBefore = Object.keys(action).sort();
      const declaration = declareAction({
        id: `${tool}.${action.name}`,
        authority: 'tool-registry',
        boundTo: ['cli', 'mcp'],
        subject: action,
      });

      // The registration IS the payload, carried by reference. A lift that
      // copied, normalized or re-wrapped the registration would break identity
      // here — and would mean the envelope had opinions about registration
      // shape, which is what "additive" forbids.
      expect(declaration.subject).toBe(action);
      expect(Object.keys(action).sort()).toEqual(keysBefore);
    }

    const cliVerbs = liveCliVerbs();
    expect(cliVerbs.length).toBeGreaterThanOrEqual(4);

    for (const { verb, tool, action } of cliVerbs) {
      const declaration = declareCliVerb({
        id: verb,
        authority: 'tool-registry',
        boundTo: ['cli'],
        subject: { tool, action: action.name },
      });
      expect(declaration.kind).toBe('cli-verb');
      expect(declaration.id).toBe(verb);
    }
  });

  it('Declaration_MissingAuthority_FailsCompile', () => {
    // ── The compile half (the real gate) ──────────────────────────────────
    // `_DeclarationMissingAuthority_FailsCompile` in `declaration.ts` asserts
    // that a record carrying every field EXCEPT `authority` is not assignable
    // to `Declaration`. Making `authority` optional turns that alias into
    // `Expect<false>` and fails `npm run typecheck` — verified by flipping it.
    //
    // ── The runtime half, asserted here ───────────────────────────────────
    // A compile-time-only guarantee evaporates the instant a declaration
    // arrives as `unknown`: from relocated storage, a JSON round-trip, or a
    // stand-in IR. Both halves have to hold, so the constructor and the guard
    // enforce the same rule the type does.

    const missingAuthority = {
      kind: 'event',
      id: 'workflow.started',
      boundTo: [],
      subject: { source: 'auto' },
    };
    expect(isDeclaration(missingAuthority)).toBe(false);

    // Present-but-empty is the same defect wearing a disguise: the record
    // typechecks, and asserts nothing about who owns the declaration.
    expect(isDeclaration({ ...missingAuthority, authority: '' })).toBe(false);
    expect(isDeclaration({ ...missingAuthority, authority: '   ' })).toBe(false);
    expect(isDeclaration({ ...missingAuthority, authority: 'tool-registry' })).toBe(true);

    // The constructor fails closed rather than defaulting an authority — a
    // synthesized owner is a false statement about the topology.
    const blank = (): unknown =>
      makeDeclaration({
        kind: 'event',
        id: 'workflow.started',
        authority: '  ',
        subject: undefined,
      });
    expect(blank).toThrow(DeclarationError);
    expect(blank).toThrow(/authority must be a non-empty string/);

    // The error names the offending field, so a caller can report WHICH
    // declaration invariant was violated rather than "something was wrong".
    let field: string | undefined;
    try {
      blank();
    } catch (error) {
      field = error instanceof DeclarationError ? error.field : undefined;
    }
    expect(field).toBe('authority');
  });

  it('Declaration_EventActionCliVerb_ShareOneShape', () => {
    // The three kinds are built through three SEPARATE lift helpers — the
    // natural place a fourth field would creep into one kind and not the
    // others. Comparing their outputs is therefore falsifiable in a way that
    // comparing the type to itself would not be.
    const event = declareEvent({
      id: 'workflow.started',
      authority: 'event-emission-registry',
      boundTo: ['event-data-schemas'],
      subject: { source: 'auto' },
    });
    const action = declareAction({
      id: 'exarchos_workflow.get',
      authority: 'tool-registry',
      boundTo: ['cli', 'mcp'],
      subject: { name: 'get' },
    });
    const cliVerb = declareCliVerb({
      id: 'ps',
      authority: 'tool-registry',
      boundTo: ['cli'],
      subject: { tool: 'exarchos_view' },
    });

    const shapes = [event, action, cliVerb].map((d) => Object.keys(d).sort());
    // One shape: identical key sets, and that set is exactly the declared
    // field list — which lives in `declaration.ts` as DATA, not as a literal
    // repeated in this test body.
    for (const shape of shapes) {
      expect(shape).toEqual([...DECLARATION_FIELDS]);
    }
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);

    // Instances of one type, not three parallel types: a single consumer
    // written against the envelope handles all three with no per-kind branch.
    const all: AnyDeclaration[] = [event, action, cliVerb];
    expect(all.every(isDeclaration)).toBe(true);
    expect(all.map(declarationKey)).toEqual([
      'event:workflow.started',
      'action:exarchos_workflow.get',
      'cli-verb:ps',
    ]);

    // The kinds present are exactly the declared kinds — a fourth declaration
    // family cannot appear without being registered in `DECLARATION_KINDS`.
    expect(all.map((d) => d.kind).sort()).toEqual([...DECLARATION_KINDS]);
  });

  // ── Supporting guarantees that relocation (task 007) rests on ────────────

  it('normalizes boundTo deterministically so two builds are byte-identical', () => {
    const forward = declareAction({
      id: 'exarchos_workflow.get',
      authority: 'tool-registry',
      boundTo: ['mcp', 'cli', 'docs', 'cli'],
      subject: null,
    });
    const reversed = declareAction({
      id: 'exarchos_workflow.get',
      authority: 'tool-registry',
      boundTo: ['docs', 'cli', 'mcp'],
      subject: null,
    });

    expect(forward.boundTo).toEqual(['cli', 'docs', 'mcp']);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('is immutable, so the seam can hand a declaration out without copying', () => {
    const declaration = declareEvent({
      id: 'workflow.started',
      authority: 'event-emission-registry',
      subject: { source: 'auto' },
    });

    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.boundTo)).toBe(true);
    expect(declaration.boundTo).toEqual([]);
  });

  it('rejects an unknown kind rather than widening the declaration family', () => {
    const rogue = (): unknown =>
      makeDeclaration({
        // A kind outside `DECLARATION_KINDS`, as it would arrive from
        // relocated storage that predates or postdates this build.
        kind: 'capability' as never,
        id: 'fs:write',
        authority: 'handshake',
        subject: undefined,
      });
    expect(rogue).toThrow(DeclarationError);
    expect(isDeclaration({ kind: 'capability', id: 'x', authority: 'y', boundTo: [], subject: 1 }))
      .toBe(false);
  });
});
