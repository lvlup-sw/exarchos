/**
 * The `invariants_add` handler. It validates one authored entry against `InvariantEntryV3Schema`, which includes the sandbox-safe `.strict()` enforcement DSL.
 *   - `dryRun` (the default) renders the entry as YAML and a file diff, and writes nothing.
 *   - `dryRun: false` assigns the next free id in the namespace (`U-N` for user, `INV-N` for dev), unless the caller gives an id.
 *     It appends the entry to the catalog, registers the catalog in `.exarchos.yml` when needed, and emits `invariant.authored`.
 *     A first registration also emits `catalog.registered`.
 *
 * A `ZodError` or an `UnknownCheckKindError` maps to the carrier `{ validTargets, expectedShape, suggestedFix }`, so the agent can correct itself.
 * File system effects go through the injected `ScaffoldDeps`.
 * The catalog file shape and the id scan are shared with `invariants_amend`, so the two writers agree.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { z } from 'zod';
import { parseDocument, stringify as stringifyYaml, isSeq } from 'yaml';
import type { YAMLSeq } from 'yaml';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  InvariantEntryV3Schema,
  UnknownCheckKindError,
} from '../../architecture/invariant-schema.js';
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
} from '../../architecture/invariants-loader.js';
import {
  splitCatalog,
  readCatalogIds,
  catalogUnreadableResult,
} from './catalog-file.js';
import type { ScaffoldDeps } from './scaffold.js';
import { wireCatalogRegistration } from './exarchos-yml-writer.js';
import { assertDevTierAllowed } from './reserved-tier-guard.js';

const CONFIG_FILENAME = '.exarchos.yml';
const NEXT_ACTIONS = ['doctor', 'view invariants_effective'] as const;

export interface HandleAddArgs {
  /** Repo root the catalog + `.exarchos.yml` resolve against. */
  readonly repoRoot: string;
  /** The authored entry (without an `id` — auto-assigned on commit). */
  readonly entry: Record<string, unknown>;
  /** Repo-relative path of the target catalog. Defaults per tier. */
  readonly catalog?: string | undefined;
  /** Target tier — drives namespace (`U-N` user, `INV-N` dev). Default user. */
  readonly tier?: 'dev' | 'user' | undefined;
  /** Explicit id override (rare — normally auto-assigned). */
  readonly id?: string | undefined;
  /** Dry-run (default true): render and diff, and write nothing. */
  readonly dryRun?: boolean;
  /**
   * Opt-in to author into exarchos's reserved `dev` namespace from a non-exarchos
   * repo. Almost always a mistake outside the exarchos repo itself (#1489).
   */
  readonly allowReservedTier?: boolean | undefined;
}

const DEFAULT_PATH: Record<'dev' | 'user', string> = {
  user: '.exarchos/invariants.md',
  dev: '.exarchos/invariants.md',
};

const NAMESPACE_PREFIX: Record<'dev' | 'user', string> = {
  user: 'U',
  dev: 'INV',
};

/**
 * Allocate the next free id in a namespace. Scans `existingIds` for the
 * `${prefix}-${n}` form and returns `${prefix}-${max+1}` (1 when none exist).
 * Gaps are never reused — monotonic allocation keeps ids stable across edits.
 */
export function allocateNextId(existingIds: readonly string[], prefix: string): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Appends a validated entry to the `invariants:` sequence of a catalog file, and keeps the markdown body and the frontmatter comments.
 * A markdown catalog (`---\n<frontmatter>\n---\n<body>`) cannot go through `parseDocument` as a whole file, because `toString()` throws and the body is lost.
 * So the function changes only the frontmatter document and puts the body back byte for byte.
 * A bare-YAML catalog has no body, so a `parseDocument` and `toString()` round trip is correct.
 * Both paths change a CST-backed `Document`, because `parse` and `stringify` discard comments.
 */
export function appendEntryToCatalog(
  contents: string,
  validated: unknown,
): string {
  const { frontmatter, body } = splitCatalog(contents);

  if (body !== undefined) {
    const fmDoc = parseDocument(frontmatter);
    appendToInvariantsSeq(fmDoc, validated);
    return `---\n${fmDoc.toString()}---\n${body}`;
  }

  const doc = parseDocument(frontmatter);
  appendToInvariantsSeq(doc, validated);
  return doc.toString();
}

/**
 * Appends `validated` to the `invariants:` sequence of `doc`.
 * A missing, null, or non-sequence node (for example `invariants: {}`) becomes an empty `YAMLSeq` first, because `.add` on a scalar or map throws a `TypeError`.
 * `createNode` gives a real `YAMLSeq`. A plain array from `doc.set` has no `.add`.
 */
function appendToInvariantsSeq(doc: ReturnType<typeof parseDocument>, validated: unknown): void {
  let list = doc.get('invariants', true) as unknown;
  if (!isSeq(list)) {
    const seq = doc.createNode([]);
    doc.set('invariants', seq);
    list = doc.get('invariants', true) as unknown;
  }
  (list as YAMLSeq).add(validated);
}

/**
 * The carrier refusal for a primary-key collision. It names the offending id and the count of entries in the catalog.
 * It points the agent at `invariants_amend`, which is usually what a caller who reuses an id wants.
 * The message starts with the loader's own sentence, so the read path and the write path refuse with the same text.
 */
function duplicateIdResult(
  id: string,
  relCatalog: string,
  tier: 'dev' | 'user',
  existingIds: readonly string[],
): ToolResult {
  return {
    success: false,
    error: {
      code: 'DUPLICATE_INVARIANT_ID',
      message:
        `${duplicateInvariantIdMessage(id)}. Catalog '${relCatalog}' resolved ` +
        `${existingIds.length} existing entr${existingIds.length === 1 ? 'y' : 'ies'} ` +
        `and one already carries this id; appending a second would author a ` +
        `file the invariants loader refuses to read. To CHANGE the existing ` +
        `entry use invariants_amend; to add a NEW entry omit 'id' and let it ` +
        `be auto-assigned.`,
      expectedShape: {
        id: `an id not already in ${relCatalog}, or omit it entirely`,
      },
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: {
          action: 'invariants_amend',
          id,
          catalog: relCatalog,
          tier,
          note:
            'Amending edits the existing entry in place (identity and unnamed ' +
            'fields survive). To append a brand-new entry instead, re-run ' +
            "invariants_add without 'id'.",
        },
      },
    },
  };
}

/**
 * Maps a validation failure (`ZodError` or `UnknownCheckKindError`) to the carrier shape, so the agent can correct itself and not guess again.
 *
 * `invariants_amend` shares it, because an amendment is validated again against the same `InvariantEntryV3Schema`.
 * `action` goes into `suggestedFix.params.action`, so the offered fix targets the verb that the caller used.
 */
export function validationErrorResult(
  err: unknown,
  action: 'invariants_add' | 'invariants_amend' = 'invariants_add',
): ToolResult {
  if (err instanceof UnknownCheckKindError) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: err.message,
        expectedShape: {
          enforcement: {
            mode: 'check',
            check: { kind: 'grep | structural | heuristic', pattern: 'string' },
          },
        },
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action,
            note: "Use a known leaf kind (grep | structural | heuristic). The enforcement DSL is declarative-only (INV-4) — there is no shell/exec kind.",
          },
        },
      },
    };
  }

  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Invariant entry failed validation: ${issues
          .map((i) => `${i.path || '(root)'}: ${i.message}`)
          .join('; ')}`,
        validTargets: issues.map((i) => i.path).filter((p) => p.length > 0),
        expectedShape: {
          dimension: 'string',
          axis: 'substrate | authoring',
          'cost-of-load': 'always-load | reference-only | archivable',
          'applies-to': ['glob'],
          summary: 'string',
          references: ['string'],
          enforcement:
            "{ mode: 'audit', 'audit-prompt': string } | { mode: 'check', check: <combinator-tree> }",
        },
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action,
            note: 'Correct the fields above and re-run with dryRun:true to preview.',
          },
        },
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * The `invariants_add` handler. It refuses a `dev` tier entry from a consumer repo first, even in a dry run, so a preview never renders one.
 * The target catalog must exist. An unresolvable id list is refused, because it is the denominator of the uniqueness check.
 * The duplicate check uses the loader's own predicate on the id list that the write makes, so the reader and the writer agree.
 * Event emission is best-effort and never fails the write, which already landed.
 */
export async function handleAdd(
  args: HandleAddArgs,
  ctx: DispatchContext,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const tier = args.tier ?? 'user';

  const reserved = assertDevTierAllowed(
    {
      tier,
      repoRoot: args.repoRoot,
      allowReservedTier: args.allowReservedTier,
      action: 'invariants_add',
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
        message: `Target catalog '${relCatalog}' does not exist. Run invariants_scaffold first to create it.`,
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: { action: 'invariants_scaffold', path: relCatalog, tier },
        },
      },
    };
  }
  const catalogContents = deps.read(catalogAbs);

  const scan = readCatalogIds(catalogContents);
  if (!scan.resolved) {
    return catalogUnreadableResult(relCatalog, tier, scan.reason);
  }
  const existingIds = scan.ids;

  const id = args.id ?? allocateNextId(existingIds, NAMESPACE_PREFIX[tier]);

  const collision = findDuplicateInvariantId([...existingIds, id]);
  if (collision !== undefined) {
    return duplicateIdResult(collision, relCatalog, tier, existingIds);
  }

  let validated;
  try {
    validated = InvariantEntryV3Schema.parse({ ...args.entry, id });
  } catch (err) {
    return validationErrorResult(err);
  }

  const renderedEntry = stringifyYaml([validated]);

  if (dryRun) {
    const diff = renderDiff(relCatalog, renderedEntry);
    return {
      success: true,
      data: {
        committed: false,
        id,
        tier,
        catalog: relCatalog,
        renderedEntry,
        diff,
        next_actions: [...NEXT_ACTIONS],
      },
    };
  }

  deps.write(catalogAbs, appendEntryToCatalog(catalogContents, validated));

  const ymlPath = toPosix(path.join(args.repoRoot, CONFIG_FILENAME));
  const registration = wireCatalogRegistration(
    ymlPath,
    { path: relCatalog, tier },
    deps,
  );

  const emitted: string[] = [];
  try {
    await ctx.eventStore.append(`invariants/${tier}`, {
      type: 'invariant.authored' as const,
      data: {
        id,
        catalog: relCatalog,
        tier,
        dimension: validated.dimension,
        mode: validated.enforcement?.mode,
      },
    });
    emitted.push('invariant.authored');

    if (registration.wrote) {
      await ctx.eventStore.append(`invariants/${tier}`, {
        type: 'catalog.registered' as const,
        data: { path: relCatalog, tier },
      });
      emitted.push('catalog.registered');
    }
  } catch {
  }

  return {
    success: true,
    data: {
      committed: true,
      id,
      tier,
      catalog: relCatalog,
      registration,
      events: emitted,
      next_actions: [...NEXT_ACTIONS],
    },
  };
}

/**
 * Render a minimal append diff for the dry-run preview: the rendered entry
 * shown as added lines under the target catalog's `invariants:` list.
 */
function renderDiff(relCatalog: string, renderedEntry: string): string {
  const added = renderedEntry
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => `+${l}`)
    .join('\n');
  return `--- a/${relCatalog}\n+++ b/${relCatalog}\n@@ invariants: (append) @@\n${added}`;
}
