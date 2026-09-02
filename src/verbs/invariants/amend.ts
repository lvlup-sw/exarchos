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
 *   - **Field-scoped IN THE FILE TOO** (DR-3). The write is a SPLICE of the
 *     amended entry's lines into the original text, not a re-serialization of
 *     the document — see `locateCatalogEntry`. Sibling entries keep their
 *     bytes, so the catalog's raw-text digest moves for the amendment and for
 *     nothing else.
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
 *
 * TOTAL in its envelope (#1706 DR-1): every failure this handler can reach —
 * an unlocatable entry, and the commit path's filesystem write, which throws —
 * leaves through a coded `ToolResult.error`. Nothing escapes to
 * dispatch's safety net, which would flatten it to a generic INTERNAL_ERROR
 * and discard the code the caller branches on.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { InvariantEntryV3Schema } from '../../architecture/invariant-schema.js';
// DR-6 — the catalog's primary-key rule has ONE authority, in the loader.
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
} from '../../architecture/invariants-loader.js';
import {
  readCatalogIds,
  catalogUnreadableResult,
  locateCatalogEntry,
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
  /**
   * Dry-run only: the exact lines the commit would replace, and replace them
   * with. Rendered from the same splice the commit writes, so the preview is
   * the write rather than an approximation of it.
   */
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
 * Render a minimal replace diff for the dry-run preview: the entry's lines as
 * they stand on disk as removed lines, the spliced replacement as added lines.
 *
 * Both sides come from the splice, so the preview names exactly the lines the
 * commit touches — which is the point of DR-3 on the review side: a reviewer
 * must be able to see that an amendment is an amendment without re-parsing the
 * file to separate it from collateral reflow.
 */
function renderAmendDiff(
  relCatalog: string,
  id: string,
  before: string,
  after: string,
): string {
  const mark = (text: string, sign: string): string => {
    const lines = text.split('\n');
    // `split('\n')` on text ending in a newline yields ONE trailing '' that is an
    // artifact of the terminator, not a line. Drop exactly that. Filtering every
    // empty line (as this did) also erased blank lines INSIDE an entry, so a
    // preview whose entire job is showing what changes quietly hid part of it —
    // and a blank line is a real edit in a YAML block scalar.
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((l) => `${sign}${l}`).join('\n');
  };
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
  // `exists` and `read` are two syscalls, and the header promises a TOTAL
  // envelope — every failure a coded result. Between the check above and this
  // read the path can be removed, replaced by a directory, or lose read
  // permission, and the ENOENT / EISDIR / EACCES would escape to dispatch and
  // flatten to a generic INTERNAL_ERROR: exactly the outcome the claim says is
  // unrepresentable. The existence check cannot be made atomic, so the read
  // carries its own arm instead.
  let catalogContents: string;
  try {
    catalogContents = deps.read(catalogAbs);
  } catch (cause) {
    return catalogUnreadableResult(
      relCatalog,
      tier,
      `the catalog could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

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

  // ── Locate the entry's LINES, not just its values (DR-3) ──
  // One locator serves both halves of the amendment: the merge base (what the
  // entry currently says) and the splice (which bytes of the file it owns).
  // Locating is strictly narrower than the id scan above — an aliased entry has
  // a readable id but no node of its own to rewrite — so a resolved id is not
  // by itself proof that there is anything to splice.
  const location = locateCatalogEntry(catalogContents, args.id);
  if (!location.located) {
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message:
          `Entry '${args.id}' resolved in the id scan but its lines could not be ` +
          `located in catalog '${relCatalog}': ${location.reason}. Refusing rather ` +
          `than rewriting the whole document, which would re-wrap entries this ` +
          `amendment never named.`,
      },
    };
  }

  // ── Merge: patch replaces named top-level fields, everything else survives ──
  const merged = { ...location.entry.current, ...args.patch, id: args.id };

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

  // Built ONCE and shared by both branches, so the dry-run preview shows the
  // exact lines the commit will write rather than an independently rendered
  // approximation of them. Only the amended entry's lines are re-serialized;
  // sibling entries are carried through as bytes and cannot be re-wrapped.
  const splice = location.entry.splice(validated);

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
        diff: renderAmendDiff(
          relCatalog,
          args.id,
          location.entry.currentText,
          splice.entryText,
        ),
        next_actions: [...NEXT_ACTIONS],
      },
    };
  }

  // ── Commit path ──
  // `deps.write` throws on any filesystem failure and must not escape: dispatch's
  // outer safety net would flatten it to a generic INTERNAL_ERROR, discarding the
  // coded envelope this handler returns on every OTHER failure path (#1706 DR-1).
  // `CATALOG_WRITE_FAILED` is what the caller branches on. (The rewrite itself is
  // no longer inside this try: locating refuses through its own envelope above,
  // and splicing located text cannot fail, so the filesystem is the last thrower.)
  try {
    deps.write(catalogAbs, splice.contents);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'CATALOG_WRITE_FAILED',
        message:
          `Amending '${args.id}' failed while writing catalog '${relCatalog}': ` +
          `${err instanceof Error ? err.message : String(err)}. No ` +
          `invariant.amended event was emitted; re-read the catalog before retrying.`,
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action: 'invariants_amend',
            id: args.id,
            catalog: relCatalog,
            tier,
            dryRun: true,
          },
        },
      },
    };
  }

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
