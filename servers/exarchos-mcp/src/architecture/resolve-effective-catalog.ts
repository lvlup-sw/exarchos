/**
 * Single core function that materializes the *effective* invariant catalog
 * for a given SDLC context (DR-7).
 *
 * The effective catalog is the merged + override-clamped + projected view of
 * every invariant layer (dev / sdlc / user) relevant to one `(phase,
 * workflowType, touchedFiles)` key. It is exposed by exactly ONE core
 * function so that the two facades that surface it produce a byte-identical
 * payload (INV-2):
 *
 *   - NOW: a CLI / `exarchos_view` export verb (INV-5c) — see
 *     `views/effective-catalog.ts` and the `invariants_effective` view action.
 *   - LATER: an MCP Resource (`resources/exarchos-invariants/effective`) once
 *     #1275 lands. Until then the facade simply re-exposes this function's
 *     output; see the SEAM comment at the view facade.
 *
 * Pure composition (INV-1): no caching, no mutable state. Every call re-loads
 * and re-folds from source so the payload can never drift from the catalog
 * files or `.exarchos.yml`.
 *
 * ## Pipeline
 *
 *   load dev catalog (gated by `invariants.devCatalog`)
 *     + load user `catalogs` from config
 *     + sdlc layer (placeholder — empty today; the sdlc catalog CONTENT is
 *       out of scope for this task, only the seam is wired)
 *   → mergeCatalogs (tags each layer's integrity-class)
 *   → applyOverrides (clamp each override to its invariant's floor)
 *   → drop honored-disabled entries (the final filter — see note below)
 *   → projectCatalog (filter to the (phase, workflowType, touchedFiles) key)
 *
 * ### Honored-disable filter
 *
 * `applyOverrides` does NOT itself drop entries whose `enabled:false`
 * override is honored — for a `disable`/`none` floor it leaves the entry in
 * place and relies on the caller to apply the final filter. This function IS
 * that caller: it drops an entry when its resolved override is `enabled:false`
 * AND its floor permits a full disable (`disable` | `none`). Entries whose
 * floor is `advisory`/`immutable` are NOT dropped — `applyOverrides` already
 * clamped (advisory) or ignored (immutable) the disable, so they stay.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';
import { loadInvariants, type InvariantEntry } from './invariants-loader.js';
import {
  mergeCatalogs,
  applyOverrides,
  resolveFloor,
  isReservedUserId,
  type InvariantOverride,
} from './catalog-merge.js';
import { projectCatalog } from './project-catalog.js';

/** Context for resolving the effective catalog (DR-7). */
export interface ResolveEffectiveCatalogContext {
  /**
   * Repository root. The built-in dev catalog is read from
   * `<repoRoot>/docs/architecture/invariants.md`. Defaults to the repo root
   * derived from this module's location (four levels up from
   * `src/architecture/`), mirroring `vocabulary-lint.ts`.
   */
  repoRoot?: string;
  /**
   * Resolved `.exarchos.yml` config. Drives dev-catalog gating
   * (`invariants.devCatalog`), the user `catalogs` paths, and per-invariant
   * `overrides`. When omitted, no dev catalog is surfaced (default-disabled)
   * and there are no user catalogs or overrides.
   */
  config?: ExarchosConfig;
  /** SDLC phase to project for — e.g. `'ideate' | 'plan' | 'delegate'`. */
  phase: string;
  /** Workflow kind to project for — e.g. `'feature' | 'debug' | 'discover'`. */
  workflowType: string;
  /** Files the current task touches (delegate-phase projection narrowing). */
  touchedFiles?: string[];
}

/** Result of `resolveEffectiveCatalog`: projected entries plus merge/override warnings. */
export interface ResolveEffectiveCatalogResult {
  entries: InvariantEntry[];
  warnings: string[];
}

/**
 * Resolve the repository root from this module's location.
 *
 * `src/architecture/resolve-effective-catalog.ts` → repo root is four
 * levels up (mirrors `vocabulary-lint.ts`).
 */
function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

/**
 * Config used to load *user-authored* catalog files. User catalogs are opt-in
 * by virtue of being listed in `invariants.catalogs`; the `devCatalog` gate is
 * about the built-in dev catalog's content, not the user's own files. We pass
 * a config that enables the loader so the user's explicitly-requested catalog
 * is read regardless of the dev gate.
 */
const USER_CATALOG_LOAD_CONFIG: ExarchosConfig = {
  invariants: { devCatalog: 'enabled' },
};

/**
 * Materialize the effective invariant catalog for one SDLC context (DR-7).
 *
 * Pure composition — see the module header for the pipeline and the
 * honored-disable filter contract.
 */
export function resolveEffectiveCatalog(
  ctx: ResolveEffectiveCatalogContext,
): ResolveEffectiveCatalogResult {
  const repoRoot = ctx.repoRoot ?? defaultRepoRoot();
  const config = ctx.config;

  // ── Layer 1: dev catalog (gated by invariants.devCatalog) ──
  // `loadInvariants` returns [] unless the passed config enables the gate,
  // so the dev layer is empty for consumers who have not opted in.
  const devCatalogPath = path.join(repoRoot, 'docs/architecture/invariants.md');
  const dev = fs.existsSync(devCatalogPath)
    ? loadInvariants(devCatalogPath, undefined, config)
    : [];

  // ── Layer 2: sdlc catalog (placeholder) ──
  // The sdlc catalog CONTENT is out of scope for this task; the layer seam is
  // wired with an empty array so `mergeCatalogs` still receives all three
  // layers and the sdlc tagging path stays exercised once content lands.
  const sdlc: InvariantEntry[] = [];

  // ── Layer 3: user catalogs (paths from config.invariants.catalogs) ──
  //
  // DR-9 degradation: a malformed user catalog (bad YAML / unknown check
  // kind / reserved-namespace id) must NOT abort the whole resolution. Each
  // catalog is loaded in isolation; a load failure is folded into `warnings`
  // (naming the offending file) and the remaining layers proceed. This is the
  // single place the gate, the view facade, and any future Resource share, so
  // the degradation is exercised on every effective-catalog read — not just
  // under a hand-injected loader double.
  const loadWarnings: string[] = [];
  const userCatalogPaths = config?.invariants?.catalogs ?? [];
  const user: InvariantEntry[] = userCatalogPaths.flatMap((catalogPath) => {
    const resolved = path.isAbsolute(catalogPath)
      ? catalogPath
      : path.join(repoRoot, catalogPath);
    // A configured-but-missing path is almost always a typo or a rename; a
    // silent `[]` would invisibly disable the intended invariant checks. Warn
    // (naming the path) and degrade like any other DR-9 skip.
    if (!fs.existsSync(resolved)) {
      loadWarnings.push(
        `User invariant catalog '${catalogPath}' was not found at '${resolved}' ` +
          `and was skipped; evaluated remaining layers only.`,
      );
      return [];
    }
    let loaded: InvariantEntry[];
    try {
      loaded = loadInvariants(resolved, undefined, USER_CATALOG_LOAD_CONFIG);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      loadWarnings.push(
        `User invariant catalog '${catalogPath}' failed to load and was ` +
          `skipped; evaluated remaining layers only. Reason: ${reason}`,
      );
      return [];
    }
    // Reserved-namespace ids (`INV-*` / `SDLC-*`) belong to built-in layers.
    // `mergeCatalogs` would throw `ReservedNamespaceError` on the first such
    // user entry and abort the WHOLE resolution (crashing the conformance
    // gate). Pre-filter them here so the violation degrades to a per-entry
    // warning and the catalog's valid entries still apply (DR-9).
    const accepted: InvariantEntry[] = [];
    for (const entry of loaded) {
      if (isReservedUserId(entry.id)) {
        loadWarnings.push(
          `User invariant catalog '${catalogPath}' entry '${entry.id}' uses a ` +
            `reserved id namespace (INV-*, SDLC-*) and was skipped; those ` +
            `prefixes are reserved for built-in invariants — rename it.`,
        );
        continue;
      }
      accepted.push(entry);
    }
    return accepted;
  });

  // ── Merge + override-clamp ──
  const merged = mergeCatalogs({ dev, sdlc, user });
  const overrides: Record<string, InvariantOverride> =
    config?.invariants?.overrides ?? {};
  const { entries: clamped, warnings: overrideWarnings } = applyOverrides(
    merged,
    overrides,
  );
  const warnings = [...loadWarnings, ...overrideWarnings];

  // ── Final honored-disable filter ──
  // `applyOverrides` leaves disabled entries in place; drop those whose
  // override is `enabled:false` AND whose floor permits a full disable.
  const survived = clamped.filter((entry) => {
    const override = overrides[entry.id];
    if (override?.enabled !== false) return true;
    const floor = resolveFloor(entry);
    // Drop only when the floor permits disabling outright.
    return !(floor === 'disable' || floor === 'none');
  });

  // ── Project to the (phase, workflowType, touchedFiles) key ──
  const entries = projectCatalog(survived, {
    phase: ctx.phase,
    workflowType: ctx.workflowType,
    touchedFiles: ctx.touchedFiles,
  });

  return { entries, warnings };
}
