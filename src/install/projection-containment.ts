/**
 * Prove that each generated projection is present and selected in the shipped
 * artifact. A projection comes from an authored source. The kinds are skills,
 * command aliases, agents, hooks, the plugin manifest, `AGENTS.md`, and the
 * runtime capability maps.
 *
 * Present means that the packaged copy has the expected content digest from
 * {@link digestText}. Selected means that the packaged layer wins resolution
 * over stale or fallback copies.
 *
 * The verifier core is pure over its inputs, and {@link enumerateProjections}
 * reads the repo tree. A real proof needs two independent reads.
 * {@link verifyPackedContainment} reads the required inventory from the source
 * tree and the packaged layer from an unpacked `npm pack` tarball.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { digestText } from './artifact-agreement.js';

/**
 * The kinds of generated projection. A test can seed each kind on its own, and
 * a violation names its kind.
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

/**
 * One projection that must be present and selected in the shipped artifact. The
 * expected `digest` comes from the committed generated tree.
 */
export interface RequiredProjection {
  /** Stable unique id in the form `<kind>:<path>`. */
  readonly id: string;
  readonly kind: ProjectionKind;
  /** POSIX repo-relative path of the projection within the packaged artifact. */
  readonly path: string;
  /** Expected `sha256:<hex>` content digest from {@link digestText}. */
  readonly digest: string;
}

/**
 * A named root in the resolution search order of the shipped runtime. Index 0
 * in the layer list has the highest priority. Exactly one layer must set
 * `packaged`.
 */
export interface ProjectionLayer {
  /** Unique layer name, such as `packaged`, `stale-cache` or `source-fallback`. */
  readonly name: string;
  /** True for the authoritative packaged root that MUST win selection. */
  readonly packaged: boolean;
  /** POSIX repo-relative path → raw file content present at this layer. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * The kind of containment failure:
 * - `missing`: the packaged layer does not carry the projection.
 * - `content-mismatch`: the packaged copy has a different digest.
 * - `not-selected`: a stale or fallback layer wins resolution.
 */
export type ContainmentViolationKind =
  | 'missing'
  | 'content-mismatch'
  | 'not-selected';

/** A single containment failure, keyed to the offending projection. */
export interface ContainmentViolation {
  readonly kind: ContainmentViolationKind;
  readonly projection: ProjectionKind;
  readonly id: string;
  readonly path: string;
  readonly detail: string;
}

/** Outcome of a containment check. `ok` is true when no violation exists. */
export interface ContainmentResult {
  readonly ok: boolean;
  /** How many required projections were checked. */
  readonly checked: number;
  readonly violations: readonly ContainmentViolation[];
}

/**
 * Return the first layer in `layers` that carries `path`, or `undefined`. This
 * models the search order of the shipped runtime: the winner is the copy that
 * the runtime uses.
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
 * Check that each required projection is present in the packaged layer, by
 * content digest, and that the packaged layer wins resolution. One pass reports
 * every violation. A projection that no layer carries gets only `missing`.
 *
 * @throws When two required projections share an `id`, when two layers share a
 *   name, or when the layers do not hold exactly one `packaged` layer.
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

    const winner = resolveWinningLayer(r.path, layers);
    if (winner === undefined) {
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

/**
 * How a projection kind reaches the shipped artifact:
 * - `npm-files`: the root must appear in the `files[]` list of `package.json`.
 * - `embedded-binary`: the projection is compiled into the single-file binary
 *   at `dist/bin`. Codegen writes `content/harness/runtimes/*.yaml` into
 *   `src/install/runtimes/embedded.ts`, and `runtimes:guard` keeps them equal.
 */
export type ShippedVia =
  | { readonly via: 'npm-files'; readonly entry: string }
  | { readonly via: 'embedded-binary'; readonly entry: string; readonly note: string };

/**
 * Where the files of a projection kind live, which of them are projections, and
 * how they reach the shipped artifact. The inventory comes from a scan of these
 * roots, so the scan finds a new skill, alias or agent automatically.
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
 * The governed projection roots. Each kind has one root directory or file, so a
 * test can seed each kind on its own.
 */
export const PROJECTION_ROOT_SPECS: readonly ProjectionRootSpec[] = [
  /**
   * Rendered skill Markdown at `rendered/skills/<runtime>/<skill>/` and deeper.
   * The `test-fixtures` and `trigger-tests` trees and `__…__` probe directories
   * are excluded.
   */
  {
    kind: 'skill',
    root: 'rendered/skills',
    rootKind: 'dir',
    include: (rel) => {
      const parts = rel.split('/');
      if (parts[0] !== 'rendered' || parts[1] !== 'skills') return false;
      const top = parts[2];
      if (top === undefined || top === 'test-fixtures' || top === 'trigger-tests') return false;
      if (hasDunderSegment(rel)) return false;
      return parts.length >= 5 && rel.endsWith('.md');
    },
    shipped: { via: 'npm-files', entry: 'rendered' },
  },
  /** Command alias Markdown under `rendered/command-aliases/`. */
  {
    kind: 'alias',
    root: 'rendered/command-aliases',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('rendered/command-aliases/') && rel.endsWith('.md'),
    shipped: { via: 'npm-files', entry: 'rendered' },
  },
  /** Agent definitions under `rendered/agents/`, which `plugin.json` lists. */
  {
    kind: 'agent',
    root: 'rendered/agents',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('rendered/agents/') && rel.endsWith('.md'),
    shipped: { via: 'npm-files', entry: 'rendered' },
  },
  /** Lifecycle hooks: `hooks/hooks.json` and each `HOOKS.md` note under `hooks/`. */
  {
    kind: 'hook',
    root: 'hooks',
    rootKind: 'dir',
    include: (rel) => rel === 'hooks/hooks.json' || (rel.startsWith('hooks/') && rel.endsWith('/HOOKS.md')),
    shipped: { via: 'npm-files', entry: 'hooks' },
  },
  /** The plugin manifest that Claude reads at runtime. */
  {
    kind: 'manifest',
    root: '.claude-plugin/plugin.json',
    rootKind: 'file',
    shipped: { via: 'npm-files', entry: '.claude-plugin' },
  },
  /** The always-loaded instruction file, which carries the runtime-neutral binding block. */
  {
    kind: 'instruction',
    root: 'AGENTS.md',
    rootKind: 'file',
    shipped: { via: 'npm-files', entry: 'AGENTS.md' },
  },
  /** Runtime capability maps, compiled into the binary through the generated `embedded.ts`. */
  {
    kind: 'runtime',
    root: 'content/harness/runtimes',
    rootKind: 'dir',
    include: (rel) => rel.startsWith('content/harness/runtimes/') && rel.endsWith('.yaml'),
    shipped: {
      via: 'embedded-binary',
      entry: 'dist/bin',
      note:
        'content/harness/runtimes/*.yaml are codegen\'d into src/runtimes/embedded.ts and compiled into the ' +
        'single-file binary (dist/bin); runtimes:guard enforces embedded-vs-YAML parity',
    },
  },
] as const;

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
    const current = stack.pop();
    if (current === undefined) break;
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
 * Read the repo tree under `repoRoot` into the pure model. Each matching file
 * becomes a {@link RequiredProjection} with the digest of its authored bytes.
 * Throws when a required root is missing or matches no file, because an empty
 * inventory makes the proof vacuous.
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
 * Build a `packaged` {@link ProjectionLayer} that copies the enumerated source
 * contents.
 *
 * Warning: this layer comes from the same read as the required inventory, so an
 * unchanged copy always passes. Use it only as a base for seeded mutation in
 * unit tests. For a real proof, use {@link verifyPackedContainment}, which reads
 * the bytes of an actual `npm pack`.
 */
export function packagedLayerFromContents(
  contents: ReadonlyMap<string, string>,
  name = 'packaged',
): ProjectionLayer {
  return { name, packaged: true, files: new Map(contents) };
}

/**
 * Return the subset of `specs` that ships as files in the npm tarball. The
 * `embedded-binary` kinds are compiled into the binary, so the packed proof
 * cannot see them. {@link checkShippedCoverage} checks their carrier.
 */
export function npmFilesSpecs(
  specs: readonly ProjectionRootSpec[] = PROJECTION_ROOT_SPECS,
): readonly ProjectionRootSpec[] {
  return specs.filter((s) => s.shipped.via === 'npm-files');
}

/**
 * Return the projection kind of a POSIX repo-relative path, or `undefined` when
 * the path is not a projection. `enumerateProjections` applies the same rules,
 * so the two sides of the packed proof differ only in bytes and presence.
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
 * Read the packaged {@link ProjectionLayer} from `packageDir`, the `package/`
 * directory of an unpacked `npm pack` tarball. The paths and the bytes come
 * from the archive only, so this side can disagree with the source tree.
 *
 * @throws When the directory is absent or carries no projection file, because
 *   an empty layer makes the proof vacuous.
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
 * Compare the required inventory from the source tree at `repoRoot` with the
 * packaged layer from the bytes at `packageDir`, by content digest. A file
 * deleted from the tarball reports `missing`, and changed bytes report
 * `content-mismatch`. A packed projection that the source does not require goes
 * in `unexpected` and also fails the check.
 */
export function verifyPackedContainment(
  inputs: PackedContainmentInputs,
): PackedContainmentResult {
  const specs = npmFilesSpecs(inputs.specs ?? PROJECTION_ROOT_SPECS);
  const fs = inputs.fs ?? DEFAULT_REPO_FS;

  const { projections } = enumerateProjections(inputs.repoRoot, specs, fs);
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
 * Check that the `files[]` list of `package.json` holds the shipped entry of
 * each projection kind. For an `embedded-binary` kind, the entry is the binary.
 * A missing entry means that the projections exist in source but not in the
 * shipped artifact. Matching is exact, and entries that start with `!` are
 * ignored.
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
