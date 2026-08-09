/**
 * `invariants_amend` handler (task 068, DR-23).
 *
 * The catalog had no sanctioned amend path. `invariants_add` is append-only
 * (`appendEntryToCatalog` only ever calls `YAMLSeq.add`) and the
 * `/exarchos:invariants` skill forbids hand-writing catalog YAML — so every
 * sanctioned surface was closed and entries were effectively **immutable once
 * committed**. Correcting a shipped invariant was unreachable.
 *
 * This verb is the missing one. It is deliberately NOT re-scaffolding:
 *
 *   - **Id-targeted.** `id` names an entry that must already exist. The id is
 *     the catalog's primary key and is NOT amendable — identity survives.
 *   - **Field-scoped.** `patch` names the top-level fields to replace. Every
 *     field the patch does not name is carried through from the existing entry
 *     verbatim, so an amendment cannot silently drop `references`, `severity`
 *     or an affinity list the author never mentioned.
 *   - **`dryRun`-first** (INV-5c), like every other mutating verb here.
 *   - **Audited.** A commit emits `invariant.amended` carrying the id and the
 *     field names that changed.
 *
 * The merged entry is re-validated in full against `InvariantEntryV3Schema`,
 * so an amendment cannot produce an entry the schema would have rejected at
 * authoring time. The primary-key rule is then re-checked through the LOADER's
 * own predicate against the post-write id list (task 068 / DR-24): the write
 * path must never be able to author a document the reader refuses.
 *
 * Pure-by-default: fs side effects flow through injected `ScaffoldDeps`.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { z } from 'zod';
import { parseDocument, stringify as stringifyYaml, isSeq, isMap } from 'yaml';
import type { YAMLSeq } from 'yaml';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { EnvelopeSchema } from '../../schemas/envelope.js';
import { InvariantEntryV3Schema } from '../../architecture/invariant-schema.js';
// DR-6 — the catalog's primary-key rule has ONE authority, in the loader.
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
} from '../../architecture/invariants-loader.js';
import {
  splitCatalog,
  readCatalogIds,
  catalogUnreadableResult,
  isPlainRecord,
} from './catalog-file.js';
import { validationErrorResult } from './add.js';
import type { ScaffoldDeps } from './scaffold.js';
import { assertDevTierAllowed } from './reserved-tier-guard.js';

const NEXT_ACTIONS: readonly string[] = ['doctor', 'view invariants_effective'];

/**
 * The `data` payload `invariants_amend` advertises across the tool boundary.
 *
 * Declared substantively (DR-4): the verb is new, so it has no seeded
 * `vacuityWaiver` entry to inherit — and the waiver allowlist is shrink-only,
 * so acquiring one would be a ratchet violation. `withCappedShape` is the sole
 * substantive constructor, and this is the shape it caps.
 *
 * `renderedEntry`/`diff` are present only on the dry-run branch and `events`
 * only on the commit branch, so both are optional here while `committed` — the
 * discriminant a caller actually branches on — is required.
 */
export const AmendInvariantData = z.object({
  committed: z.boolean(),
  id: z.string().min(1),
  tier: z.enum(['dev', 'user']),
  catalog: z.string().min(1),
  /** Top-level entry fields the patch replaced. Never empty. */
  patchedFields: z.array(z.string().min(1)).min(1),
  /** Dry-run only: the amended entry rendered as a YAML list fragment. */
  renderedEntry: z.string().optional(),
  /** Dry-run only: a before/after diff of the single amended entry. */
  diff: z.string().optional(),
  /** Commit only: the event types actually appended. */
  events: z.array(z.string()).optional(),
  next_actions: z.array(z.string()),
});

export const AmendInvariantOutputSchema = EnvelopeSchema(AmendInvariantData);

const DEFAULT_PATH: Record<'dev' | 'user', string> = {
  user: '.exarchos/invariants.md',
  dev: '.exarchos/invariants.md',
};

export interface HandleAmendArgs {
  /** Repo root the catalog resolves against. */
  readonly repoRoot: string;
  /** Id of the entry to amend. Must already exist; never changed by the patch. */
  readonly id: string;
  /**
   * Top-level fields to replace. Fields absent from the patch survive
   * untouched. A named field is replaced WHOLESALE (patching `enforcement`
   * swaps the whole enforcement block, it does not deep-merge into it).
   */
  readonly patch: Record<string, unknown>;
  /** Repo-relative path of the target catalog. Defaults per tier. */
  readonly catalog?: string | undefined;
  /** Target tier. Default user. */
  readonly tier?: 'dev' | 'user' | undefined;
  /** Dry-run (default true, INV-5c): render + diff, write nothing. */
  readonly dryRun?: boolean;
  /** Opt-in to amend exarchos's reserved `dev` namespace (#1489). */
  readonly allowReservedTier?: boolean | undefined;
}

/**
 * Locate the entry with `id` inside a parsed frontmatter document, returning
 * both its index in the `invariants:` sequence and its current field map.
 *
 * Returns `undefined` when the sequence is missing or no entry matches — the
 * caller has already proven the id list RESOLVED and the id present, so an
 * `undefined` here means the document changed shape between the two reads and
 * is treated as an internal error rather than "not found".
 */
function findEntry(
  doc: ReturnType<typeof parseDocument>,
  id: string,
): { seq: YAMLSeq; index: number; current: Record<string, unknown> } | undefined {
  // `isSeq` / `isMap` / `isPlainRecord` are type PREDICATES, so every
  // narrowing below is checked by the compiler rather than asserted with a
  // cast. The sequence is returned alongside the index so the caller can
  // replace in place without re-resolving (and re-asserting) the node.
  const list: unknown = doc.get('invariants', true);
  if (!isSeq(list)) return undefined;
  const items = list.items;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isMap(item)) continue;
    const projected: unknown = item.toJSON();
    if (!isPlainRecord(projected)) continue;
    if (projected.id === id) return { seq: list, index, current: projected };
  }
  return undefined;
}

/**
 * Replace the entry at `index` of the `invariants:` sequence with `validated`,
 * preserving BOTH the markdown body AND the frontmatter's YAML comments.
 *
 * Mirrors `appendEntryToCatalog`'s two-shape handling (see catalog-file.ts):
 * the fenced dev catalog carries a prose body a whole-file round-trip would
 * destroy, so we mutate ONLY the frontmatter document and reassemble.
 */
export function replaceEntryInCatalog(
  contents: string,
  id: string,
  validated: unknown,
): string {
  const { frontmatter, body } = splitCatalog(contents);

  const doc = parseDocument(frontmatter);
  const found = findEntry(doc, id);
  if (found === undefined) {
    throw new Error(
      `invariants_amend: entry '${id}' vanished between the id scan and the write`,
    );
  }
  found.seq.set(found.index, validated);

  if (body !== undefined) {
    return `---\n${doc.toString()}---\n${body}`;
  }
  return doc.toString();
}

/**
 * Render a minimal replace diff for the dry-run preview: the entry's current
 * YAML as removed lines, the amended entry as added lines.
 */
function renderAmendDiff(
  relCatalog: string,
  id: string,
  before: string,
  after: string,
): string {
  const mark = (text: string, sign: string): string =>
    text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `${sign}${l}`)
      .join('\n');
  return (
    `--- a/${relCatalog}\n+++ b/${relCatalog}\n@@ invariants: (amend ${id}) @@\n` +
    `${mark(before, '-')}\n${mark(after, '+')}`
  );
}

/**
 * `invariants_amend` handler. See module header for the contract.
 */
export async function handleAmend(
  args: HandleAmendArgs,
  ctx: DispatchContext,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const tier = args.tier ?? 'user';

  // Reject amending exarchos's reserved `dev` namespace from a consumer repo
  // BEFORE reading anything, and regardless of dryRun (#1489) — mirrors add.
  const reserved = assertDevTierAllowed(
    {
      tier,
      repoRoot: args.repoRoot,
      allowReservedTier: args.allowReservedTier,
      action: 'invariants_amend',
    },
    deps,
  );
  if (reserved) return reserved;

  const relCatalog = args.catalog ?? DEFAULT_PATH[tier];
  const catalogAbs = toPosix(path.join(args.repoRoot, relCatalog));
  const dryRun = args.dryRun === undefined ? true : args.dryRun;

  if (!deps.exists(catalogAbs)) {
    return {
      success: false,
      error: {
        code: 'CATALOG_NOT_FOUND',
        message: `Target catalog '${relCatalog}' does not exist. There is nothing to amend.`,
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: { action: 'invariants_scaffold', path: relCatalog, tier },
        },
      },
    };
  }
  const catalogContents = deps.read(catalogAbs);

  // ── Denominator, proven RESOLVED before anything is concluded from it ──
  const scan = readCatalogIds(catalogContents);
  if (!scan.resolved) {
    return catalogUnreadableResult(relCatalog, tier, scan.reason);
  }
  const existingIds = scan.ids;

  // ── Non-empty denominator (task 068 / DR-24) ──
  // Unlike `invariants_add`, for which a resolvable-but-empty catalog is the
  // legitimate first-entry case, an amend against ZERO entries is vacuous:
  // "the id you asked for is not here" is trivially true of an empty list and
  // tells the caller nothing about whether they targeted the right catalog.
  // Refuse rather than report a clean not-found.
  if (existingIds.length === 0) {
    return {
      success: false,
      error: {
        code: 'CATALOG_EMPTY',
        message:
          `Catalog '${relCatalog}' resolved zero entries, so there is nothing to ` +
          `amend and no meaningful answer to whether '${args.id}' is present. ` +
          `Refusing rather than reporting a vacuous not-found — check that this ` +
          `is the catalog you meant.`,
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action: 'invariants_add',
            catalog: relCatalog,
            tier,
            note: 'An empty catalog needs an entry authored before one can be amended.',
          },
        },
      },
    };
  }

  // ── The target must exist. Amending is not authoring. ──
  if (!existingIds.includes(args.id)) {
    return {
      success: false,
      error: {
        code: 'ENTRY_NOT_FOUND',
        message:
          `No entry with id '${args.id}' in catalog '${relCatalog}' ` +
          `(${existingIds.length} entries resolved). invariants_amend edits an ` +
          `EXISTING entry; use invariants_add to author a new one.`,
        validTargets: [...existingIds],
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action: 'invariants_add',
            catalog: relCatalog,
            tier,
            note: `Pick one of the ids listed in validTargets to amend, or author a new entry with invariants_add.`,
          },
        },
      },
    };
  }

  // ── The patch must actually name something ──
  const patchedFields = Object.keys(args.patch);
  if (patchedFields.length === 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'patch names no fields — an amendment that changes nothing is not a ' +
          'valid amendment.',
        expectedShape: { patch: { summary: 'the new summary text' } },
      },
    };
  }

  // ── Identity is not amendable ──
  // Renaming an entry is a different operation with different consequences
  // (every `references:` pointer and audit record naming the old id silently
  // goes stale). Refuse it explicitly rather than let a patch smuggle it in.
  if (Object.prototype.hasOwnProperty.call(args.patch, 'id')) {
    return {
      success: false,
      error: {
        code: 'IMMUTABLE_FIELD',
        message:
          `'id' is the catalog's primary key and is not amendable — the entry's ` +
          `identity must survive an amendment. Amend the fields of '${args.id}' ` +
          `instead, and drop 'id' from the patch.`,
        expectedShape: {
          id: `'${args.id}'  # names the TARGET; it is not a patchable field`,
        },
      },
    };
  }

  // ── Merge: patch replaces named top-level fields, everything else survives ──
  const doc = parseDocument(splitCatalog(catalogContents).frontmatter);
  const found = findEntry(doc, args.id);
  if (found === undefined) {
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: `Entry '${args.id}' resolved in the id scan but could not be located in the catalog document.`,
      },
    };
  }
  const before = stringifyYaml([found.current]);
  const merged = { ...found.current, ...args.patch, id: args.id };

  let validated;
  try {
    validated = InvariantEntryV3Schema.parse(merged);
  } catch (err) {
    return validationErrorResult(err, 'invariants_amend');
  }

  // ── Write-time primary-key re-check, through the LOADER's own predicate ──
  // The patch cannot carry an `id` (refused above), so this cannot fail today.
  // It is asserted anyway because the guarantee we owe is about the DOCUMENT,
  // not about one input field: whatever this verb is about to write must be a
  // document the reader accepts.
  const postWriteIds = existingIds.map((existing) =>
    existing === args.id ? validated.id : existing,
  );
  const collision = findDuplicateInvariantId(postWriteIds);
  if (collision !== undefined) {
    return {
      success: false,
      error: {
        code: 'DUPLICATE_INVARIANT_ID',
        message:
          `${duplicateInvariantIdMessage(collision)}. The amended catalog would ` +
          `contain two entries with this id — a file the invariants loader ` +
          `refuses to read. Refusing to write.`,
      },
    };
  }

  const renderedEntry = stringifyYaml([validated]);

  if (dryRun) {
    return {
      success: true,
      data: {
        committed: false,
        id: args.id,
        tier,
        catalog: relCatalog,
        patchedFields,
        renderedEntry,
        diff: renderAmendDiff(relCatalog, args.id, before, renderedEntry),
        next_actions: [...NEXT_ACTIONS],
      },
    };
  }

  // ── Commit path ──
  deps.write(catalogAbs, replaceEntryInCatalog(catalogContents, args.id, validated));

  // Emit the audit record (best-effort telemetry — never fail the write that
  // already landed, mirroring `invariants_add`).
  const emitted: string[] = [];
  try {
    await ctx.eventStore.append(`invariants/${tier}`, {
      type: 'invariant.amended',
      data: {
        id: args.id,
        catalog: relCatalog,
        tier,
        fields: patchedFields,
      },
    });
    emitted.push('invariant.amended');
  } catch {
    /* best-effort: the amendment already landed */
  }

  return {
    success: true,
    data: {
      committed: true,
      id: args.id,
      tier,
      catalog: relCatalog,
      patchedFields,
      events: emitted,
      next_actions: [...NEXT_ACTIONS],
    },
  };
}
