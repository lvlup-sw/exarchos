// ─── A gate cannot write down an outcome it did not compute ──────────────────
//
// `emitGateEvent` used to take `passed: boolean`. Two consequences followed
// from that one parameter. A gate that could not DECIDE had to pick a side, and
// whichever it picked was a lie a reader could act on. And because `passed` was
// supplied rather than derived, a caller could hand over a boolean that
// disagreed with the verdict its own evidence carried — nothing in the type
// system, and nothing at the append, could tell.
//
// The fix is structural rather than advisory: the parameter is the VERDICT, and
// `passed` is computed at the single place a row is minted. A bare boolean stops
// type-checking, so the migration is exhaustive by construction rather than by
// anyone having remembered every site.
//
// @oracle-sources: ../../src/verbs/gates/gate-utils.ts, the src/ tree walked at test time for call sites
//
// Two authorities: the module that DECLARES the emitter, and the live source
// tree walked for callers of it. A hand-listed call-site set would keep passing
// after someone added the twenty-first.
// ────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { emitGateEvent } from '../../src/verbs/gates/gate-utils.js';
import { GateExecutedData, GateVerdictSchema } from '../../src/events/schemas.js';
import type { EventStore } from '../../src/events/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const EMITTER_MODULE = path.join(SRC_DIR, 'verbs', 'gates', 'gate-utils.ts');

/** Every `.ts` under `src/`, walked rather than globbed so it cannot go stale. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') sourceFiles(full, out);
    } else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly verdictArg: string;
}

/** Every `emitGateEvent(...)` CALL in `src/`, with its verdict argument's text. */
function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('emitGateEvent(')) continue;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'emitGateEvent' &&
        node.arguments.length >= 5
      ) {
        found.push({
          file: path.relative(REPO_ROOT, file),
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          verdictArg: node.arguments[4]!.getText(parsed),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsed, visit);
  }
  return found;
}

/** Records what was appended without touching a real store. */
function recordingStore(): { store: EventStore; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const store = {
    append: async (_streamId: string, event: { data?: Record<string, unknown> }) => {
      rows.push(event.data ?? {});
    },
  } as unknown as EventStore;
  return { store, rows };
}

describe('gate verdicts reach the wire whole', () => {
  it('NoCallSite_PassesABareBoolean', () => {
    const sites = callSites();

    // Denominator: a scan that resolved no calls would satisfy every claim
    // below by having nothing to check.
    expect(sites.length, 'no emitGateEvent call site was found — the scan is inert').toBeGreaterThan(
      15,
    );

    const bare = sites.filter(({ verdictArg }) => verdictArg === 'true' || verdictArg === 'false');
    expect(
      bare.map((s) => `${s.file}:${s.line} passes \`${s.verdictArg}\``),
      'a call site still hands the emitter a bare boolean',
    ).toEqual([]);

    // The stronger half, and the reason the list above stays empty without
    // anyone policing it: the PARAMETER is the verdict union, so a boolean does
    // not type-check. Read off the declaration rather than asserted from
    // memory — a signature that quietly went back to `boolean` would leave the
    // check above passing over call sites that had all been rewritten.
    const declaration = readFileSync(EMITTER_MODULE, 'utf8');
    expect(
      declaration.includes('verdict: GateVerdict,'),
      'emitGateEvent no longer declares its verdict parameter as GateVerdict',
    ).toBe(true);
    expect(
      /export async function emitGateEvent\([^)]*passed: boolean/s.test(declaration),
      'emitGateEvent takes a boolean again',
    ).toBe(false);
  });

  it('SelfEmitter_CannotExpressAnUncomputedVerdict', async () => {
    // There is no longer a parameter for `passed`, so a caller has nothing to
    // disagree with. Driven over the WHOLE vocabulary so a member added later
    // inherits the case instead of slipping past a sampled three.
    const vocabulary = GateVerdictSchema.options;
    expect(vocabulary.length, 'the verdict vocabulary is empty').toBeGreaterThan(3);

    const wrong: string[] = [];
    for (const verdict of vocabulary) {
      const { store, rows } = recordingStore();
      await emitGateEvent(store, 'stream', 'a-gate', 'review', verdict);

      const row = rows[0];
      if (row === undefined) {
        wrong.push(`${verdict}: nothing was appended`);
        continue;
      }
      if (row.verdict !== verdict) wrong.push(`${verdict}: row carried ${String(row.verdict)}`);
      if (row.passed !== (verdict === 'pass')) {
        wrong.push(`${verdict}: passed was ${String(row.passed)}`);
      }
      // And the row the emitter mints must satisfy the schema's derivation
      // refinement, so the two halves of this cannot drift apart.
      if (!GateExecutedData.safeParse(row).success) wrong.push(`${verdict}: row failed the schema`);
    }

    expect(wrong, 'the emitter did not derive `passed` from the verdict').toEqual([]);
  });

  it('IndeterminateEmission_IsNotWrittenDownAsAFailure', async () => {
    // The outcome the boolean could not express at all. It must reach the row
    // as itself — distinguishable from a gate that ran and failed, which is the
    // whole point of the widening.
    const { store, rows } = recordingStore();
    await emitGateEvent(store, 'stream', 'a-gate', 'review', 'indeterminate', { why: 'no runner' });
    await emitGateEvent(store, 'stream', 'a-gate', 'review', 'fail', { why: 'it ran and failed' });

    const [undecided, failed] = rows;
    expect(undecided?.verdict).toBe('indeterminate');
    expect(failed?.verdict).toBe('fail');
    // Identical on the old surface...
    expect(undecided?.passed).toBe(failed?.passed);
    // ...and distinguishable on the new one, which is the finding.
    expect(undecided?.verdict).not.toBe(failed?.verdict);
  });
});
