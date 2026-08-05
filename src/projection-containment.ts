/**
 * projection-containment — prove every generated projection is PRESENT and
 * SELECTED in the shipped / installed artifact (P05-03; ART-008).
 *
 * Exarchos renders a fan-out of generated projections from single authored
 * sources: per-runtime **skills** (`skills/<runtime>/…`), canonical command
 * **aliases** (`command-aliases/<runtime>/…`), **agents** (`agents/…`),
 * lifecycle **hooks** (`hooks/hooks.json` + `hooks/<runtime>/HOOKS.md`), the
 * plugin **manifest** (`.claude-plugin/plugin.json`), the always-loaded
 * **instruction** surface (`AGENTS.md`), and the **runtime** capability maps
 * (`runtimes/*.yaml`, baked into the single-file binary). Each of those is a
 * *projection* that must survive the trip into the packaged/installed artifact.
 *
 * Two properties, per the work package, are load-bearing and distinct:
 *
 *   - **present** — the projection physically exists in the shipped/installed
 *     artifact, verified by a CONTENT DIGEST (not merely a path existence
 *     check): a same-path replacement with different bytes is still a defect.
 *   - **selected** — the shipped runtime actually RESOLVES *that* copy. A
 *     projection that ships but is shadowed by a stale duplicate (a lingering
 *     cache, a source-tree fallback that wins the search order) is the subtle
 *     bug this catches — the artifact is present yet never used.
 *
 * ## Digesting — reuse, don't re-invent
 *
 * This module does NOT define a third digest. It reuses P03-07's digest layer
 * ({@link digestText} from `./artifact-agreement.js`), which itself mirrors the
 * P03-01 authority digest and the P05-04 install-identity tree digest so a
 * Windows (CRLF, `\`) checkout agrees with a Linux (LF, `/`) render.
 *
 * ## Purity
 *
 * The verifier core ({@link verifyContainment}, {@link resolveWinningLayer},
 * {@link checkShippedCoverage}) is PURE over its inputs — callers assemble the
 * layers (packaged copy, any stale/fallback copies) and the required-projection
 * inventory and hand them in, so every rule is unit-testable with no filesystem.
 * {@link enumerateProjections} is the thin, injectable I/O adapter that reads the
 * real repo tree into the pure model, and the inventory is DERIVED from the
 * renderers' own committed outputs ({@link PROJECTION_ROOT_SPECS}) so it cannot
 * silently drift from what is authored.
 *
 * ## Two authorities, not one (DR-21)
 *
 * A containment proof is only worth its name when the two sides are independent
 * READS. Building the required inventory and the "packaged" layer from a single
 * `contents` map compares a map with itself: deleting a real agent, alias or
 * hook shrinks both sides together and the check still passes. That is why
 * {@link packagedLayerFromContents} carries an explicit single-authority
 * warning and is confined to seeded unit fixtures, while the real proof —
 * {@link verifyPackedContainment} — takes the required inventory from the
 * authored SOURCE TREE and the packaged layer from the BYTES of an unpacked
 * `npm pack` tarball ({@link readPackedProjectionLayer}). Only the two-read form
 * can report `missing` for a projection dropped from the artifact or
 * `content-mismatch` for one whose shipped bytes were rewritten.
 *
 * ## Selection model
 *
 * A shipped runtime resolves a projection by searching an ordered list of roots
 * (index 0 = highest priority). Each root is a {@link ProjectionLayer}; exactly
 * one is flagged `packaged` (the authoritative copy that MUST win). Resolution
 * picks the first layer that carries the path — so a stale duplicate at LOWER
 * priority than `packaged` correctly loses, while a duplicate at HIGHER priority
 * (a stale cache ahead of the package, or a source-tree fallback) wins and is
 * flagged `not-selected`. Removing the packaged copy makes resolution fall
 * through to whatever stale copy remains — also `not-selected`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { digestText } from './artifact-agreement.js';

// ─── Projection kinds ────────────────────────────────────────────────────────

/**
 * The enumerated projection kinds. Each is independently seedable (its files can
 * be removed / replaced on their own) and independently blocking (a violation
 * names the kind), per the work package.
 */
export type ProjectionKind =
  | 'skill'
  | 'alias'
  | 'agent'
  | 'hook'
  | 'manifest'
  | 'instruction'
  | 'runtime';

/** Every projection kind, in a stable order for exhaustive coverage checks. */
export const PROJECTION_KINDS: readonly ProjectionKind[] = [
  'skill',
  'alias',
  'agent',
  'hook',
  'manifest',
  'instruction',
  'runtime',
] as const;

// ─── The required-projection inventory ───────────────────────────────────────

/**
 * One projection that MUST be present and selected in the shipped artifact. The
 * `digest` is the expected content digest computed from the authored source of
 * truth (the committed generated tree, which `skills:guard` / `hooks:guard`
 * hold equal to the renderers' output).
 */
export interface RequiredProjection {
  /** Stable unique id, e.g. `skill:skills/standard/plan/SKILL.md`. */
  readonly id: string;
  readonly kind: ProjectionKind;
  /** POSIX repo-relative path of the projection within the packaged artifact. */
  readonly path: string;
  /** Expected `sha256:<hex>` content digest (via P03-07's {@link digestText}). */
  readonly digest: string;
}

// ─── Resolution layers (the selection model) ─────────────────────────────────

/**
 * A named root in the shipped runtime's resolution search order. Index 0 in the
 * layer list is highest priority. Exactly one layer must be flagged `packaged`.
 */
export interface ProjectionLayer {
  /** Unique layer name (e.g. `packaged`, `stale-cache`, `source-fallback`). */
  readonly name: string;
  /** True for the authoritative packaged root that MUST win selection. */
  readonly packaged: boolean;
  /** POSIX repo-relative path → raw file content present at this layer. */
  readonly files: ReadonlyMap<string, string>;
}

// ─── Violations & result ─────────────────────────────────────────────────────

export type ContainmentViolationKind =
  /** Absent from the packaged layer (a removed projection). */
  | 'missing'
  /** Present in the packaged layer but its digest ≠ required (a replacement). */
  | 'content-mismatch'
  /** Resolution winner is not the packaged layer (a stale/fallback copy wins). */
  | 'not-selected';

/** A single containment failure, keyed to the offending projection. */
export interface ContainmentViolation {
  readonly kind: ContainmentViolationKind;
  readonly projection: ProjectionKind;
  readonly id: string;
  readonly path: string;
  readonly detail: string;
}

/** Outcome of a containment check — discriminated on `ok`. */
export interface ContainmentResult {
  readonly ok: boolean;
  /** How many required projections were checked. */
  readonly checked: number;
  readonly violations: readonly ContainmentViolation[];
}

// ─── Pure verifier core ──────────────────────────────────────────────────────

/**
 * Resolve `path` against the ordered `layers`, returning the first (highest
 * priority) layer that carries it, or `undefined` when no layer has it. This is
 * the model of the shipped runtime's search order — the winner is the copy that
 * is actually used at runtime.
 */
export function resolveWinningLayer(
  path: string,
  layers: readonly ProjectionLayer[],
): ProjectionLayer | undefined {
  for (const layer of layers) {
    if (layer.files.has(path)) return layer;
  }
  return undefined;
}

/** Inputs to {@link verifyContainment}. */
export interface ContainmentInputs {
  /** The governed inventory of projections that must ship. */
  readonly required: readonly RequiredProjection[];
  /** The resolution layers, in priority order (index 0 highest). */
  readonly layers: readonly ProjectionLayer[];
}

function findPackagedLayer(layers: readonly ProjectionLayer[]): ProjectionLayer {
  const seenNames = new Set<string>();
  const packaged: ProjectionLayer[] = [];
  for (const layer of layers) {
    if (seenNames.has(layer.name)) {
      throw new Error(`verifyContainment: duplicate layer name '${layer.name}'`);
    }
    seenNames.add(layer.name);
    if (layer.packaged) packaged.push(layer);
  }
  const first = packaged[0];
  if (first === undefined) {
    throw new Error('verifyContainment: no layer is flagged `packaged` — nothing to prove containment against');
  }
  if (packaged.length > 1) {
    throw new Error(
      `verifyContainment: ${packaged.length} layers are flagged \`packaged\` (${packaged
        .map((l) => l.name)
        .join(', ')}) — exactly one authoritative packaged root is required`,
    );
  }
  return first;
}

/**
 * Verify that every required projection is PRESENT in the packaged layer (by
 * content digest) and SELECTED (the packaged layer wins resolution across all
 * layers). Never short-circuits — one pass surfaces every violation.
 *
 * @throws if two required projections share an `id`, or if the layer set does
 *   not contain exactly one `packaged` layer (assembly bugs that would make the
 *   proof ambiguous).
 */
export function verifyContainment(inputs: ContainmentInputs): ContainmentResult {
  const { required, layers } = inputs;
  const packaged = findPackagedLayer(layers);

  const seenIds = new Set<string>();
  const violations: ContainmentViolation[] = [];

  for (const r of required) {
    if (seenIds.has(r.id)) {
      throw new Error(`verifyContainment: duplicate required-projection id '${r.id}'`);
    }
    seenIds.add(r.id);

    // ── Presence: the packaged layer must carry this exact content. ──────────
    const packagedContent = packaged.files.get(r.path);
    if (packagedContent === undefined) {
      violations.push({
        kind: 'missing',
        projection: r.kind,
        id: r.id,
        path: r.path,
        detail:
          `${r.kind} projection '${r.path}' is absent from the packaged layer ` +
          `'${packaged.name}' — the projection was removed from the shipped artifact`,
      });
    } else {
      const actual = digestText(packagedContent);
      if (actual !== r.digest) {
        violations.push({
          kind: 'content-mismatch',
          projection: r.kind,
          id: r.id,
          path: r.path,
          detail:
            `${r.kind} projection '${r.path}' in the packaged layer '${packaged.name}' ` +
            `has digest ${actual} but the authored source of truth requires ${r.digest} ` +
            `— the shipped copy was replaced with different content`,
        });
      }
    }

    // ── Selection: the packaged layer must WIN resolution. ───────────────────
    const winner = resolveWinningLayer(r.path, layers);
    if (winner === undefined) {
      // No layer at all carries it — already reported as `missing` above; the
      // extra selection note would be redundant, so skip it.
      continue;
    }
    if (winner.name !== packaged.name) {
      violations.push({
        kind: 'not-selected',
        projection: r.kind,
        id: r.id,
        path: r.path,
        detail:
          `${r.kind} projection '${r.path}' resolves to layer '${winner.name}', not the ` +
          `packaged layer '${packaged.name}' — a stale/duplicate copy shadows the shipped ` +
          `projection (or the packaged copy is missing and resolution fell back)`,
      });
    }
  }

  return { ok: violations.length === 0, checked: required.length, violations };
}

/** Thrown by {@link assertContainment} when any projection fails containment. */
export class ProjectionContainmentError extends Error {
  override readonly name = 'ProjectionContainmentError';
  readonly code = 'PROJECTION_CONTAINMENT_VIOLATION';
  constructor(public readonly violations: readonly ContainmentViolation[]) {
    super(
      `Generated projection containment failed — ${violations.length} violation(s):\n` +
        violations
          .map((v) => `  • [${v.kind}] ${v.projection} ${v.id}\n      ${v.detail}`)
          .join('\n'),
    );
  }
}

/**
 * Verify containment and THROW {@link ProjectionContainmentError} on any
 * violation. Returns the passing result so callers can log what was checked.
 */
export function assertContainment(inputs: ContainmentInputs): ContainmentResult {
  const result = verifyContainment(inputs);
  if (!result.ok) throw new ProjectionContainmentError(result.violations);
  return result;
}

// ─── Governed inventory spec (derived from the renderers' outputs) ────────────

/**
 * How a projection kind is delivered into the shipped artifact.
 *
 *   - `npm-files`       — the projection's root directory/file must appear in
 *     `package.json` `files[]` (what `npm pack` / the plugin bundle ships).
 *   - `embedded-binary` — the projection is baked INTO the single-file binary
 *     (shipped as `dist/bin`) rather than as loose files. `runtimes/*.yaml` are
 *     codegen'd into `src/runtimes/embedded.ts` and compiled in; `runtimes:guard`
 *     enforces the embedded table equals the YAML source, so the binary carries
 *     the authoritative runtime maps and the loose YAML need not ship.
 */
export type ShippedVia =
  | { readonly via: 'npm-files'; readonly entry: string }
  | { readonly via: 'embedded-binary'; readonly entry: string; readonly note: string };

/**
 * Where a projection kind's files live, which of them are projections, and how
 * they reach the shipped artifact. The inventory is DERIVED by scanning these
 * roots (the renderers' committed outputs) so it cannot drift from what is
 * authored — adding a new skill/alias/agent is picked up automatically.
 */
export interface ProjectionRootSpec {
  readonly kind: ProjectionKind;
  /** POSIX repo-relative root — a directory (`rootKind:'dir'`) or a single file. */
  readonly root: string;
  readonly rootKind: 'dir' | 'file';
  /** For a `dir` root: which repo-relative paths under it are projections. */
  readonly include?: (relPath: string) => boolean;
  readonly shipped: ShippedVia;
}

/** True when any path segment is a `__…__` transient probe/fixture dir. */
function hasDunderSegment(rel: string): boolean {
  return rel.split('/').some((seg) => seg.startsWith('__'));
}

/**
 * The governed projection-root inventory. Each kind maps to exactly one shipped
 * root (or single file) so the seven kinds stay independently seedable/blocking.
 */
export const PROJECTION_ROOT_SPECS: readonly ProjectionRootSpec[] = [
  {
    // Rendered per-runtime skill tree (`skills/<runtime>/<skill>/SKILL.md` plus
    // any `references/*.md`). Excludes the intentionally-malformed frontmatter
    // fixtures and transient probe dirs, matching packaging-consistency's scan.
    kind: 'skill',
    root: 'skills',
    rootKind: 'dir',
    include: (rel) => {
      const parts = rel.split('/');
      if (parts[0] !== 'skills') return false;
      const top = parts[1];
      if (top === undefined || top === 'test-fixtures' || top === 'trigger-tests') return false;
      if (hasDunderSegment(rel)) return false;
      // At least skills/<runtime>/<skill>/<file>.md.
      return parts.length >= 4 && rel.endsWith('.md');
    },
    shipped: { via: 'npm-files', entry: 'skills' },
  },
  {
    // Canonical-name command aliases (`command-aliases/<runtime>/<name>.md`).
    kind: 'alias',
    root: 'command-aliases',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('command-aliases/') && rel.endsWith('.md'),
    shipped: { via: 'npm-files', entry: 'command-aliases' },
  },
  {
    // Claude agent definitions (`agents/<id>.md`) — the copy plugin.json selects.
    kind: 'agent',
    root: 'agents',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('agents/') && rel.endsWith('.md'),
    shipped: { via: 'npm-files', entry: 'agents' },
  },
  {
    // Lifecycle hooks: the active Claude plugin `hooks/hooks.json` plus each
    // runtime's `hooks/<runtime>/HOOKS.md` note.
    kind: 'hook',
    root: 'hooks',
    rootKind: 'dir',
    include: (rel) => rel === 'hooks/hooks.json' || (rel.startsWith('hooks/') && rel.endsWith('/HOOKS.md')),
    shipped: { via: 'npm-files', entry: 'hooks' },
  },
  {
    // The plugin manifest Claude consumes at runtime.
    kind: 'manifest',
    root: '.claude-plugin/plugin.json',
    rootKind: 'file',
    shipped: { via: 'npm-files', entry: '.claude-plugin' },
  },
  {
    // The always-loaded orientation/instruction surface (the runtime-neutral
    // binding block is delivered here, per build-hooks DR-5/DR-6).
    kind: 'instruction',
    root: 'AGENTS.md',
    rootKind: 'file',
    shipped: { via: 'npm-files', entry: 'AGENTS.md' },
  },
  {
    // Runtime capability maps — the projection that drives every other
    // projection. Shipped baked into the binary via codegen'd embedded.ts.
    kind: 'runtime',
    root: 'runtimes',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('runtimes/') && rel.endsWith('.yaml'),
    shipped: {
      via: 'embedded-binary',
      entry: 'dist/bin',
      note:
        'runtimes/*.yaml are codegen\'d into src/runtimes/embedded.ts and compiled into the ' +
        'single-file binary (dist/bin); runtimes:guard enforces embedded-vs-YAML parity',
    },
  },
] as const;

// ─── I/O adapter — read the real repo into the pure model ────────────────────

/** Narrow, injectable filesystem surface so enumeration is testable. */
export interface RepoReadFs {
  readFile(abs: string): string;
  /** Recursively list absolute file paths under `absDir` (dirs skipped). */
  listFilesRecursive(absDir: string): string[];
  exists(abs: string): boolean;
  isDirectory(abs: string): boolean;
}

function listFilesRecursiveReal(absDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [absDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out;
}

/** Live filesystem surface. */
export const DEFAULT_REPO_FS: RepoReadFs = {
  readFile: (abs) => readFileSync(abs, 'utf8'),
  listFilesRecursive: (absDir) => listFilesRecursiveReal(absDir),
  exists: (abs) => existsSync(abs),
  isDirectory: (abs) => {
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Normalize an OS path to POSIX separators. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** The enumerated required-projection inventory plus the authored file contents. */
export interface EnumeratedProjections {
  readonly projections: readonly RequiredProjection[];
  /** POSIX repo-relative path → authored content (the source of truth). */
  readonly contents: ReadonlyMap<string, string>;
}

/**
 * Read the real repo tree under `repoRoot` into the pure model: for each spec,
 * every matching projection file becomes a {@link RequiredProjection} whose
 * digest is computed from the authored bytes. Throws if a required root is
 * missing or matches zero files — an empty enumeration would make the whole
 * proof vacuous, so it fails loudly instead.
 */
export function enumerateProjections(
  repoRoot: string,
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
  fs: RepoReadFs = DEFAULT_REPO_FS,
): EnumeratedProjections {
  const projections: RequiredProjection[] = [];
  const contents = new Map<string, string>();

  const add = (kind: ProjectionKind, rel: string, content: string): void => {
    contents.set(rel, content);
    projections.push({ id: `${kind}:${rel}`, kind, path: rel, digest: digestText(content) });
  };

  for (const spec of specs) {
    const absRoot = join(repoRoot, spec.root);

    if (spec.rootKind === 'file') {
      if (!fs.exists(absRoot)) {
        throw new Error(
          `enumerateProjections: required ${spec.kind} projection file '${spec.root}' is missing`,
        );
      }
      add(spec.kind, spec.root, fs.readFile(absRoot));
      continue;
    }

    if (!fs.exists(absRoot) || !fs.isDirectory(absRoot)) {
      throw new Error(
        `enumerateProjections: required ${spec.kind} projection root '${spec.root}' is missing or not a directory`,
      );
    }

    let matched = 0;
    for (const abs of fs.listFilesRecursive(absRoot)) {
      const rel = toPosix(relative(repoRoot, abs));
      if (spec.include && !spec.include(rel)) continue;
      add(spec.kind, rel, fs.readFile(abs));
      matched++;
    }
    if (matched === 0) {
      throw new Error(
        `enumerateProjections: ${spec.kind} root '${spec.root}' matched zero projection files — ` +
          `the renderer output is empty or the include filter is wrong`,
      );
    }
  }

  return { projections, contents };
}

/**
 * Build a `packaged` {@link ProjectionLayer} by MIRRORING the enumerated source
 * contents.
 *
 * ⚠ SINGLE-AUTHORITY WARNING (DR-21). A layer built this way is derived from the
 * very same read that produced the required inventory, so
 * `verifyContainment({ required: projections, layers: [packagedLayerFromContents(contents)] })`
 * compares a map with itself and CANNOT disagree — deleting a real agent, alias
 * or hook shrinks both sides together and the proof still passes. It is useful
 * only as a *base* for seeded mutation in the pure unit tier (mutate the copy,
 * keep the inventory) — never as evidence that the shipped artifact contains
 * anything. For a real containment proof, build the packaged layer from the
 * bytes an actual `npm pack` produced: {@link readPackedProjectionLayer} /
 * {@link verifyPackedContainment}.
 */
export function packagedLayerFromContents(
  contents: ReadonlyMap<string, string>,
  name = 'packaged',
): ProjectionLayer {
  return { name, packaged: true, files: new Map(contents) };
}

// ─── Packed-bytes containment (DR-21) ────────────────────────────────────────

/**
 * The subset of `specs` whose projections must literally appear as FILES inside
 * the npm tarball.
 *
 * `embedded-binary` kinds (the runtime capability maps) are compiled INTO the
 * single-file binary rather than shipped loose, so looking for them among the
 * tarball entries would be a category error — they would report `missing` for a
 * reason that is not a defect. Excluding them here keeps the packed proof
 * honest about exactly which delivery mode it can observe; `checkShippedCoverage`
 * remains the proof for the embedded carrier.
 */
export function npmFilesSpecs(
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
): readonly ProjectionRootSpec[] {
  return specs.filter((s) => s.shipped.via === 'npm-files');
}

/**
 * Classify a POSIX repo-relative path as a projection of some kind, or
 * `undefined` when it is not a projection at all. This is the SAME
 * classification `enumerateProjections` applies to the source tree, so the two
 * sides of the packed proof disagree only about BYTES and PRESENCE — never
 * about what counts as a projection.
 */
export function classifyProjectionPath(
  rel: string,
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
): ProjectionKind | undefined {
  for (const spec of specs) {
    if (spec.rootKind === 'file') {
      if (rel === spec.root) return spec.kind;
      continue;
    }
    if (rel !== spec.root && !rel.startsWith(`${spec.root}/`)) continue;
    if (spec.include !== undefined && !spec.include(rel)) continue;
    return spec.kind;
  }
  return undefined;
}

/** A packaged layer read out of the bytes of an UNPACKED npm tarball. */
export interface PackedProjectionLayer {
  /** The packaged layer — its `files` map holds the tarball's own bytes. */
  readonly layer: ProjectionLayer;
  /** Sorted POSIX repo-relative projection paths the packed bytes carry. */
  readonly paths: readonly string[];
  /** Every file scanned in the packed tree, projection or not (the denominator). */
  readonly totalFiles: number;
}

/**
 * Read the packaged {@link ProjectionLayer} from `packageDir` — the `package/`
 * directory of an unpacked `npm pack` tarball.
 *
 * NOTHING here consults the source tree: the paths and the bytes both come from
 * the archive. That is the whole point of DR-21 — the packaged side of the
 * comparison must be able to disagree with the source-tree inventory.
 *
 * @throws when the directory is absent (nothing was unpacked) or carries zero
 *   projection files — either would make the containment proof vacuous, so it
 *   fails loudly instead of quietly proving nothing.
 */
export function readPackedProjectionLayer(
  packageDir: string,
  specs: readonly ProjectionRootSpec[] = npmFilesSpecs(),
  fs: RepoReadFs = DEFAULT_REPO_FS,
  name = 'packed',
): PackedProjectionLayer {
  if (!fs.exists(packageDir) || !fs.isDirectory(packageDir)) {
    throw new Error(
      `readPackedProjectionLayer: unpacked package root '${packageDir}' is missing or not a ` +
        `directory — there are no packaged bytes to prove containment against`,
    );
  }

  const files = new Map<string, string>();
  let totalFiles = 0;
  for (const abs of fs.listFilesRecursive(packageDir)) {
    totalFiles += 1;
    const rel = toPosix(relative(packageDir, abs));
    if (classifyProjectionPath(rel, specs) === undefined) continue;
    files.set(rel, fs.readFile(abs));
  }

  if (files.size === 0) {
    throw new Error(
      `readPackedProjectionLayer: the packed tree at '${packageDir}' carries ZERO projection ` +
        `files (${totalFiles} file(s) scanned) — an empty packaged layer would make the ` +
        `containment proof vacuous`,
    );
  }

  return {
    layer: { name, packaged: true, files },
    paths: [...files.keys()].sort(),
    totalFiles,
  };
}

/** Inputs to {@link verifyPackedContainment}. */
export interface PackedContainmentInputs {
  /**
   * Repository root — the INDEPENDENT authority for the required inventory. The
   * authored/committed projection tree says what MUST ship.
   */
  readonly repoRoot: string;
  /**
   * The `package/` directory of an unpacked `npm pack` tarball — the bytes that
   * actually shipped. Never derived from `repoRoot` by this function.
   */
  readonly packageDir: string;
  /** Defaults to the `npm-files` subset of {@link PROJECTION_ROOT_SPECS}. */
  readonly specs?: readonly ProjectionRootSpec[];
  readonly fs?: RepoReadFs;
}

/** Outcome of {@link verifyPackedContainment} — discriminated on `ok`. */
export interface PackedContainmentResult {
  readonly ok: boolean;
  /** How many source-authority projections were required of the tarball. */
  readonly checked: number;
  /** How many projection files the tarball actually carried. */
  readonly packedCount: number;
  readonly violations: readonly ContainmentViolation[];
  /**
   * Projection paths the tarball carries that the source authority does NOT
   * require — a projection smuggled into the artifact from outside the
   * authored tree. Containment fails in this direction too.
   */
  readonly unexpected: readonly string[];
}

/**
 * The DR-21 containment proof: the required inventory is read from the SOURCE
 * TREE at `repoRoot`, the packaged layer is read from the BYTES at
 * `packageDir`, and the two are compared by content digest.
 *
 * Because the sides come from two independent reads, deleting a projection file
 * from the tarball reports `missing`, and rewriting its bytes reports
 * `content-mismatch` — neither of which the old single-map proof could observe.
 */
export function verifyPackedContainment(
  inputs: PackedContainmentInputs,
): PackedContainmentResult {
  const specs = npmFilesSpecs(inputs.specs ?? PROJECTION_ROOT_SPECS);
  const fs = inputs.fs ?? DEFAULT_REPO_FS;

  // Authority A — what MUST ship, read from the authored source tree.
  const { projections } = enumerateProjections(inputs.repoRoot, specs, fs);
  // Authority B — what DID ship, read from the packed tarball bytes.
  const packed = readPackedProjectionLayer(inputs.packageDir, specs, fs);

  const base = verifyContainment({ required: projections, layers: [packed.layer] });

  const requiredPaths = new Set(projections.map((p) => p.path));
  const unexpected = packed.paths.filter((p) => !requiredPaths.has(p));

  return {
    ok: base.ok && unexpected.length === 0,
    checked: base.checked,
    packedCount: packed.paths.length,
    violations: base.violations,
    unexpected,
  };
}

/** Thrown by {@link assertPackedContainment} when the packed bytes fail containment. */
export class PackedContainmentError extends Error {
  override readonly name = 'PackedContainmentError';
  readonly code = 'PACKED_CONTAINMENT_VIOLATION';
  constructor(public readonly result: PackedContainmentResult) {
    super(
      `Packed-artifact projection containment failed — ${result.violations.length} violation(s) ` +
        `and ${result.unexpected.length} unexpected packed projection(s) over ${result.checked} ` +
        `required projection(s):\n` +
        [
          ...result.violations.map((v) => `  • [${v.kind}] ${v.projection} ${v.id}\n      ${v.detail}`),
          ...result.unexpected.map(
            (p) => `  • [unexpected] '${p}' is in the tarball but not required by the source tree`,
          ),
        ].join('\n'),
    );
  }
}

/**
 * Verify packed containment and THROW {@link PackedContainmentError} on any
 * violation. Returns the passing result so callers can log what was proven.
 */
export function assertPackedContainment(
  inputs: PackedContainmentInputs,
): PackedContainmentResult {
  const result = verifyPackedContainment(inputs);
  if (!result.ok) throw new PackedContainmentError(result);
  return result;
}

// ─── Shipped-`files` coverage (the packaging-declaration proof) ───────────────

/** A projection kind whose shipped-root entry is absent from `package.json` files[]. */
export interface ShippedCoverageViolation {
  readonly kind: ProjectionKind;
  readonly entry: string;
  readonly detail: string;
}

/** Outcome of {@link checkShippedCoverage} — discriminated on `ok`. */
export interface ShippedCoverageResult {
  readonly ok: boolean;
  readonly violations: readonly ShippedCoverageViolation[];
}

/**
 * Verify that every projection kind's shipped root is actually declared in the
 * `package.json` `files[]` set (for `npm-files` delivery) or that its
 * embedded-binary carrier is declared (for `embedded-binary` delivery). A kind
 * whose root is not shipped means its projections are PRESENT in source but
 * ABSENT from the shipped artifact — the exact containment failure P05-03
 * catches, one level up at the packaging manifest.
 *
 * Negation entries in `files[]` (those beginning with a `!`) are ignored;
 * matching is exact against the positive entries (`command-aliases`, `skills`,
 * `dist/bin`, …).
 */
export function checkShippedCoverage(
  shippedFiles: readonly string[],
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
): ShippedCoverageResult {
  const positive = new Set(shippedFiles.filter((e) => !e.startsWith('!')));
  const violations: ShippedCoverageViolation[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const entry = spec.shipped.entry;
    const key = `${spec.kind}:${entry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!positive.has(entry)) {
      violations.push({
        kind: spec.kind,
        entry,
        detail:
          `${spec.kind} projections ship via package.json files[] entry '${entry}' ` +
          `(${spec.shipped.via}) but that entry is absent from files[] — the ${spec.kind} ` +
          `projections will not be present in the shipped/installed artifact`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Thrown by {@link assertShippedCoverage} when a projection root is not shipped. */
export class ShippedCoverageError extends Error {
  override readonly name = 'ShippedCoverageError';
  readonly code = 'PROJECTION_NOT_SHIPPED';
  constructor(public readonly violations: readonly ShippedCoverageViolation[]) {
    super(
      `Projection roots missing from package.json files[] — ${violations.length} kind(s):\n` +
        violations.map((v) => `  • ${v.kind} (entry '${v.entry}') — ${v.detail}`).join('\n'),
    );
  }
}

/** Verify shipped coverage and THROW {@link ShippedCoverageError} on any gap. */
export function assertShippedCoverage(
  shippedFiles: readonly string[],
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
): void {
  const result = checkShippedCoverage(shippedFiles, specs);
  if (!result.ok) throw new ShippedCoverageError(result.violations);
}
