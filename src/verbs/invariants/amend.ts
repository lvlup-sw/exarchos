/**
 * The `invariants_amend` handler. It changes the fields of an existing catalog
 * entry. `invariants_add` only appends, so this is the path to correct an entry.
 *
 *   - `id` names an existing entry. The id is the primary key, and the patch
 *     cannot change it.
 *   - `patch` replaces the named top-level fields. Other fields stay as they are.
 *   - The write splices the new lines of the entry into the original text, so
 *     sibling entries keep their bytes.
 *   - `dryRun` is the default. A commit appends an `invariant.amended` event.
 *
 * The merged entry must pass `InvariantEntryV3Schema` and the primary-key rule
 * of the loader. A failure returns a coded `ToolResult.error`, so dispatch does
 * not change it to a generic INTERNAL_ERROR.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { InvariantEntryV3Schema } from '../../architecture/invariant-schema.js';
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
 * The `data` payload of `invariants_amend`. `committed` is the discriminant and
 * is required. `renderedEntry` and `diff` are only on the dry-run branch, and
 * `events` is only on the commit branch.
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
   * Dry-run only: the lines that the commit replaces, and the new lines. Both
   * come from the same splice that the commit writes.
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
  /** Id of the entry to amend. The entry must exist, and the patch cannot change the id. */
  readonly id: string;
  /**
   * Top-level fields to replace. Fields that the patch does not name stay as
   * they are. The handler replaces a named field whole and does not deep-merge
   * it, so a patch of `enforcement` replaces the whole block.
   */
  readonly patch: Record<string, unknown>;
  /** Repo-relative path of the target catalog. Defaults per tier. */
  readonly catalog?: string | undefined;
  /** Target tier. Default user. */
  readonly tier?: 'dev' | 'user' | undefined;
  /** When true, the default, the handler renders the entry and the diff and writes nothing. */
  readonly dryRun?: boolean;
  /** Opt-in to amend the reserved `dev` namespace of exarchos. */
  readonly allowReservedTier?: boolean | undefined;
}

/**
 * Renders a replace diff for the dry-run preview. The current lines of the
 * entry are the removed lines, and the splice is the added lines. Thus the
 * preview shows only the lines that the commit changes. It drops only the one
 * empty string after a final newline, because a blank line inside a YAML block
 * scalar is a real edit.
 */
function renderAmendDiff(
  relCatalog: string,
  id: string,
  before: string,
  after: string,
): string {
  const mark = (text: string, sign: string): string => {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((l) => `${sign}${l}`).join('\n');
  };
  return (
    `--- a/${relCatalog}\n+++ b/${relCatalog}\n@@ invariants: (amend ${id}) @@\n` +
    `${mark(before, '-')}\n${mark(after, '+')}`
  );
}

/**
 * The `invariants_amend` handler. It checks the reserved `dev` tier first, also
 * on a dry run. The catalog read has its own error arm, because the file can
 * change between `exists` and `read`. An empty catalog gives CATALOG_EMPTY,
 * because "not found" in zero entries tells the caller nothing.
 *
 * An entry with an id but no lines to splice, such as an alias, gives an error,
 * not a full rewrite. The primary-key check after the merge cannot fail now,
 * but it proves that the loader accepts the document. The audit event is
 * best-effort, because the write is already on disk.
 */
export async function handleAmend(
  args: HandleAmendArgs,
  ctx: DispatchContext,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const tier = args.tier ?? 'user';

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

  const scan = readCatalogIds(catalogContents);
  if (!scan.resolved) {
    return catalogUnreadableResult(relCatalog, tier, scan.reason);
  }
  const existingIds = scan.ids;

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

  const merged = { ...location.entry.current, ...args.patch, id: args.id };

  let validated;
  try {
    validated = InvariantEntryV3Schema.parse(merged);
  } catch (err) {
    return validationErrorResult(err, 'invariants_amend');
  }

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
