/**
 * `invariants_add` handler (P2, T8/T9/T11).
 *
 * Validates one authored entry against `InvariantEntryV3Schema` (including the
 * sandbox-safe `.strict()` enforcement DSL — INV-4), then either:
 *
 *   - `dryRun` (DEFAULT, INV-5c): renders the entry as YAML + a file diff and
 *     writes NOTHING; or
 *   - `dryRun:false`: auto-assigns the next free id in the target namespace
 *     (`U-N` for user tier, `INV-N` for dev), appends the entry to the target
 *     catalog's `invariants:` list, wires the catalog into `.exarchos.yml` if
 *     unregistered, and emits `invariant.authored` (+ `catalog.registered` on
 *     first registration — INV-1).
 *
 * A ZodError (or the `UnknownCheckKindError` thrown by the combinator-DSL
 * preprocess) is mapped to the INV-5b carrier shape
 * `{ validTargets, expectedShape, suggestedFix }` so the agent can self-correct.
 *
 * Pure-by-default: fs side effects flow through injected `ScaffoldDeps`.
 */
import * as path from 'node:path';
import { z } from 'zod';
import { parseDocument, stringify as stringifyYaml } from 'yaml';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  InvariantEntryV3Schema,
  UnknownCheckKindError,
} from '../../architecture/invariant-schema.js';
import type { ScaffoldDeps } from './scaffold.js';
import { wireCatalogRegistration } from './exarchos-yml-writer.js';

const CONFIG_FILENAME = '.exarchos.yml';
const NEXT_ACTIONS = ['doctor', 'view invariants_effective'] as const;

export interface HandleAddArgs {
  /** Repo root the catalog + `.exarchos.yml` resolve against. */
  readonly repoRoot: string;
  /** The authored entry (without an `id` — auto-assigned on commit). */
  readonly entry: Record<string, unknown>;
  /** Repo-relative path of the target catalog. Defaults per tier. */
  readonly catalog?: string;
  /** Target tier — drives namespace (`U-N` user, `INV-N` dev). Default user. */
  readonly tier?: 'dev' | 'user';
  /** Explicit id override (rare — normally auto-assigned). */
  readonly id?: string;
  /** Dry-run (default true, INV-5c): render + diff, write nothing. */
  readonly dryRun?: boolean;
}

const DEFAULT_PATH: Record<'dev' | 'user', string> = {
  user: 'docs/architecture/my-invariants.md',
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

/** Read existing entry ids from a catalog file's `invariants:` list. */
function readExistingIds(catalogContents: string): string[] {
  const doc = parseDocument(catalogContents);
  const list = doc.get('invariants') as unknown;
  const ids: string[] = [];
  if (list && typeof (list as { toJSON?: unknown }).toJSON === 'function') {
    const arr = (list as { toJSON: () => unknown }).toJSON();
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') {
          ids.push((e as { id: string }).id);
        }
      }
    }
  }
  return ids;
}

/**
 * Map a validation failure (ZodError or UnknownCheckKindError) to the INV-5b
 * carrier shape so the agent can self-correct rather than re-guess.
 */
function validationErrorResult(err: unknown): ToolResult {
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
            action: 'invariants_add',
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
            action: 'invariants_add',
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
 * `invariants_add` handler. See module header for the dry-run/commit contract.
 */
export async function handleAdd(
  args: HandleAddArgs,
  ctx: DispatchContext,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const tier = args.tier ?? 'user';
  const relCatalog = args.catalog ?? DEFAULT_PATH[tier];
  const catalogAbs = path.join(args.repoRoot, relCatalog);
  const dryRun = args.dryRun === undefined ? true : args.dryRun;

  // Read the target catalog (must exist — scaffold first if not).
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

  // Allocate the id (or honor an explicit override) and validate the entry.
  const existingIds = readExistingIds(catalogContents);
  const id =
    args.id ?? allocateNextId(existingIds, NAMESPACE_PREFIX[tier]);

  let validated;
  try {
    validated = InvariantEntryV3Schema.parse({ ...args.entry, id });
  } catch (err) {
    return validationErrorResult(err);
  }

  // Render the validated entry as a YAML list fragment (one entry).
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

  // ── Commit path ──
  // Append the validated entry to the catalog's `invariants:` list.
  const doc = parseDocument(catalogContents);
  if (!doc.has('invariants') || doc.get('invariants') === null) {
    doc.set('invariants', []);
  }
  const list = doc.get('invariants') as { add: (v: unknown) => void };
  list.add(validated);
  deps.write(catalogAbs, doc.toString());

  // Wire the catalog into `.exarchos.yml` if unregistered (INV-1 first-time
  // registration emits catalog.registered).
  const ymlPath = path.join(args.repoRoot, CONFIG_FILENAME);
  const registration = wireCatalogRegistration(
    ymlPath,
    { path: relCatalog, tier },
    deps,
  );

  // Emit events (best-effort telemetry — never fail the authored write).
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
    /* best-effort: the authored write already landed */
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
