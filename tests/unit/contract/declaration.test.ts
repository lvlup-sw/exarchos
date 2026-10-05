// The declaration envelope, judged by two independent authorities.
//
// `declaration.ts` is the envelope: the records that the three lift helpers
// build at runtime, and the field list that it declares as data. `registry.ts`
// is the live registration corpus, written with no reference to the envelope.
// `declaration.ts` imports nothing, and `registry.ts` does not import it, so
// the two can disagree. If one lift helper adds a field that the others lack,
// or changes a registration, these tests fail.
//
// `src/events/schemas.ts` is not a third authority, because `registry.ts`
// reaches it through its imports.
//
// @oracle-sources: ../../../src/contract/declaration.ts, ../../../src/registry.ts

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
} from '../../../src/contract/declaration.js';
import { TOOL_REGISTRY, type ToolAction } from '../../../src/registry.js';
import { EVENT_EMISSION_REGISTRY } from '../../../src/events/schemas.js';

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

/**
 * The compile-time proofs are exported type aliases at the end of `declaration.ts`, and `npm run typecheck` is their gate.
 * `tsconfig.json` excludes test files, so `tsc` does not see a type assertion in this file.
 * The runtime proofs are here. They hold after a declaration crosses an untyped boundary, such as storage or a JSON round-trip.
 */
describe('Declaration', () => {
  /**
   * `npm run typecheck` proves the compile half, because vitest strips types and does not check them.
   * This test proves the runtime half over the real registries: a lift reads a registration and does not change it.
   * Each loop has a non-empty denominator, so no loop passes on an empty set.
   * `declareAction` carries the registration by reference. A lift that copies or wraps it breaks the identity assertion.
   */
  it('Declaration_ExistingRegistrations_CompileUnchanged', () => {
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

  /**
   * The compile half is `_DeclarationMissingAuthority_FailsCompile` in `declaration.ts`, and `npm run typecheck` is its gate.
   * This test proves the runtime half, because a compile-time rule does not hold for a declaration that arrives as `unknown`.
   * `isDeclaration` rejects a missing, empty or blank `authority`.
   * The constructor throws for a blank `authority` and does not supply a default, because a default owner is a false statement.
   * The error names the field `authority`.
   */
  it('Declaration_MissingAuthority_FailsCompile', () => {
    const missingAuthority = {
      kind: 'event',
      id: 'workflow.started',
      boundTo: [],
      subject: { source: 'auto' },
    };
    expect(isDeclaration(missingAuthority)).toBe(false);

    expect(isDeclaration({ ...missingAuthority, authority: '' })).toBe(false);
    expect(isDeclaration({ ...missingAuthority, authority: '   ' })).toBe(false);
    expect(isDeclaration({ ...missingAuthority, authority: 'tool-registry' })).toBe(true);

    const blank = (): unknown =>
      makeDeclaration({
        kind: 'event',
        id: 'workflow.started',
        authority: '  ',
        subject: undefined,
      });
    expect(blank).toThrow(DeclarationError);
    expect(blank).toThrow(/authority must be a non-empty string/);

    let field: string | undefined;
    try {
      blank();
    } catch (error) {
      field = error instanceof DeclarationError ? error.field : undefined;
    }
    expect(field).toBe('authority');
  });

  /**
   * Three separate lift helpers build the three kinds, so one helper can gain a field that the others lack.
   * Each key set must equal `DECLARATION_FIELDS`, which `declaration.ts` declares as data.
   * One consumer handles all three with no branch on kind, and the kinds are exactly `DECLARATION_KINDS`.
   */
  it('Declaration_EventActionCliVerb_ShareOneShape', () => {
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
    for (const shape of shapes) {
      expect(shape).toEqual([...DECLARATION_FIELDS]);
    }
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);

    const all: AnyDeclaration[] = [event, action, cliVerb];
    expect(all.every(isDeclaration)).toBe(true);
    expect(all.map(declarationKey)).toEqual([
      'event:workflow.started',
      'action:exarchos_workflow.get',
      'cli-verb:ps',
    ]);

    expect(all.map((d) => d.kind).sort()).toEqual([...DECLARATION_KINDS]);
  });

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

  /** A kind outside `DECLARATION_KINDS` can arrive from storage that an older or newer build wrote. */
  it('rejects an unknown kind rather than widening the declaration family', () => {
    const rogue = (): unknown =>
      makeDeclaration({
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
