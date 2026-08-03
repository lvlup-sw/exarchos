// ─── The contract compiler (P03-03) ──────────────────────────────────────────
//
// PROGRAM-03, API-003. `compile(metaModel)` is the deterministic generation
// pipeline: it turns the (validated) Exarchos meta-model into runtime
// descriptors, schemas, a type manifest, a compatibility report, and proof
// fixtures — one byte-stable artifact. Compiling twice from identical input
// yields byte-identical output.
//
// Three fail-closed gates run BEFORE anything is emitted (never a partial
// descriptor):
//
//   1. AUTHORITY  — `verifyContractAuthority()` must be `ok`. A floating or
//      unapproved authority digest BLOCKS generation (P03-01's exit proof —
//      "floating or unapproved authority digests block generation and release").
//   2. SHAPE      — every entry is validated against the meta-model Zod schema;
//      a MISSING or INVALID required policy field is a typed diagnostic.
//   3. SURFACE    — every entry's surface version, error codes, output kinds,
//      and input/output schema must be COMPATIBLE with the frozen P03-02
//      `contract-surface`; an unknown error code / output kind / mismatched
//      surface version / malformed schema is a typed diagnostic.
//
// On any diagnostic, `compile` returns `{ ok:false, diagnostics }` (sorted
// deterministically) and emits nothing. On success it returns the compiled
// contract plus its canonical `serialized` string and `sha256:` digest.
// ────────────────────────────────────────────────────────────────────────────

import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import { AUTHORITY_IDS, type AuthorityVerdict } from '../authority-pin.js';
import { verifyContractAuthority } from '../authority-collector.js';
import { STABLE_ERROR_REGISTRY } from '../error-families.js';
import { OUTPUT_KINDS } from '../envelope.js';
import {
  CONTRACT_SURFACE_VERSION,
  classifyVersionChange,
  changeClassSeverity,
  requiresMixedVersionRefusal,
  type ChangeClass,
  type ChangeSeverity,
  type CompatibilityClass,
} from '../compatibility.js';
import {
  ActionMetaModelSchema,
  MetaModelSchema,
  sortedUnique,
  type ActionMetaModel,
  type ActionPolicy,
  type MetaModel,
} from './meta-model.js';
import {
  buildSchemaBundle,
  buildTypeManifest,
  compileDescriptor,
  type ActionDescriptor,
  type SchemaBundle,
  type TypeManifest,
} from './descriptors.js';
import { buildProofFixtures, type ProofFixtureBundle } from './fixtures.js';

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export const DIAGNOSTIC_CODES = [
  'AUTHORITY_BLOCKED',
  'MISSING_POLICY_FIELD',
  'INVALID_POLICY_FIELD',
  'INCOMPATIBLE_SURFACE_VERSION',
  'UNKNOWN_ERROR_CODE',
  'UNKNOWN_OUTPUT_KIND',
  'INCOMPATIBLE_SCHEMA',
  'DUPLICATE_ACTION',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface CompilerDiagnostic {
  readonly code: DiagnosticCode;
  /** The offending ActionId, or `<meta-model>` / `<authority>` for global faults. */
  readonly actionId: string;
  /** Dotted path to the offending field (`policy.economy.budgetTokens`). */
  readonly path: string;
  readonly message: string;
}

const META_SCOPE = '<meta-model>';
const AUTHORITY_SCOPE = '<authority>';

// ─── Compiled contract + outcome ─────────────────────────────────────────────

export interface ActionCompatibility {
  readonly actionId: string;
  readonly changeClasses: readonly { readonly class: ChangeClass; readonly severity: ChangeSeverity }[];
  readonly securitySensitive: boolean;
  /** True when an ADDITIVE (minor) change to this action would refuse mixed-version peers. */
  readonly refusesMixedVersionOnAdditive: boolean;
}

export interface CompatibilityReport {
  readonly surfaceVersion: string;
  readonly compatibleWithSurface: boolean;
  readonly versionChange: CompatibilityClass;
  readonly securitySensitiveActionCount: number;
  readonly actions: readonly ActionCompatibility[];
}

export interface CompiledContract {
  readonly surfaceVersion: string;
  readonly descriptors: readonly ActionDescriptor[];
  readonly schemas: SchemaBundle;
  readonly types: TypeManifest;
  readonly compatibilityReport: CompatibilityReport;
  readonly proofFixtures: ProofFixtureBundle;
  /** `sha256:` over the whole compiled contract (excludes the proof fixtures). */
  readonly contractDigest: string;
  /** Canonical, byte-stable serialization of the whole compiled contract. */
  readonly serialized: string;
  /** `sha256:` over `serialized`. */
  readonly digest: string;
}

export type CompileOutcome =
  | { readonly ok: true; readonly output: CompiledContract }
  | { readonly ok: false; readonly diagnostics: readonly CompilerDiagnostic[] };

export interface CompileOptions {
  /**
   * The authority freeze gate. Defaults to the real {@link verifyContractAuthority}
   * (reads the tree); overridable so a test can inject a floating/unapproved
   * verdict and prove generation blocks without mutating the lockfile.
   */
  readonly verifyAuthority?: () => AuthorityVerdict;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const SCHEMA_KEYWORDS = [
  'type',
  '$schema',
  '$ref',
  'anyOf',
  'allOf',
  'oneOf',
  'enum',
  'const',
  'properties',
  'items',
  'prefixItems',
] as const;

function isWellFormedSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return SCHEMA_KEYWORDS.some((k) => k in (value as Record<string, unknown>));
}

function resolveAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

const isStableErrorCode = (code: string): boolean => code in STABLE_ERROR_REGISTRY;
const OUTPUT_KIND_SET: ReadonlySet<string> = new Set(OUTPUT_KINDS);

/** Surface-compatibility checks over an entry that already passed Zod shape validation. */
function validateSurfaceCompatibility(entry: ActionMetaModel): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const id = entry.actionId;

  if (entry.surfaceVersion !== CONTRACT_SURFACE_VERSION) {
    diagnostics.push({
      code: 'INCOMPATIBLE_SURFACE_VERSION',
      actionId: id,
      path: 'surfaceVersion',
      message:
        `action '${id}' declares surface version '${entry.surfaceVersion}' but the frozen ` +
        `contract surface is '${CONTRACT_SURFACE_VERSION}'`,
    });
  }
  if (entry.policy.compatibility.surfaceVersion !== CONTRACT_SURFACE_VERSION) {
    diagnostics.push({
      code: 'INCOMPATIBLE_SURFACE_VERSION',
      actionId: id,
      path: 'policy.compatibility.surfaceVersion',
      message:
        `action '${id}' compatibility policy declares surface version ` +
        `'${entry.policy.compatibility.surfaceVersion}' but the frozen contract surface is ` +
        `'${CONTRACT_SURFACE_VERSION}'`,
    });
  }
  for (const code of entry.errorCodes) {
    if (!isStableErrorCode(code)) {
      diagnostics.push({
        code: 'UNKNOWN_ERROR_CODE',
        actionId: id,
        path: 'errorCodes',
        message: `action '${id}' declares error code '${code}' that is not in the frozen stable-error registry`,
      });
    }
  }
  for (const kind of entry.outputKinds) {
    if (!OUTPUT_KIND_SET.has(kind)) {
      diagnostics.push({
        code: 'UNKNOWN_OUTPUT_KIND',
        actionId: id,
        path: 'outputKinds',
        message: `action '${id}' declares output kind '${kind}' that is not in the closed output-kind set`,
      });
    }
  }
  if (!isWellFormedSchema(entry.inputSchema)) {
    diagnostics.push({
      code: 'INCOMPATIBLE_SCHEMA',
      actionId: id,
      path: 'inputSchema',
      message: `action '${id}' input schema is not a well-formed JSON Schema (no recognized keyword)`,
    });
  }
  if (!isWellFormedSchema(entry.outputSchema)) {
    diagnostics.push({
      code: 'INCOMPATIBLE_SCHEMA',
      actionId: id,
      path: 'outputSchema',
      message: `action '${id}' output schema is not a well-formed JSON Schema (no recognized keyword)`,
    });
  }
  return diagnostics;
}

function rawActionId(entry: unknown, index: number): string {
  if (entry !== null && typeof entry === 'object') {
    const id = (entry as { actionId?: unknown }).actionId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return `<action[${index}]>`;
}

/** Validate the whole meta-model, returning every diagnostic (never short-circuiting). */
function validateMetaModel(metaModel: unknown): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];

  if (metaModel === null || typeof metaModel !== 'object') {
    return [
      {
        code: 'INVALID_POLICY_FIELD',
        actionId: META_SCOPE,
        path: '',
        message: 'meta-model must be an object',
      },
    ];
  }
  const container = metaModel as { surfaceVersion?: unknown; actions?: unknown };

  if (typeof container.surfaceVersion !== 'string') {
    diagnostics.push({
      code: 'INVALID_POLICY_FIELD',
      actionId: META_SCOPE,
      path: 'surfaceVersion',
      message: 'meta-model surfaceVersion must be a string',
    });
  } else if (container.surfaceVersion !== CONTRACT_SURFACE_VERSION) {
    diagnostics.push({
      code: 'INCOMPATIBLE_SURFACE_VERSION',
      actionId: META_SCOPE,
      path: 'surfaceVersion',
      message:
        `meta-model surface version '${container.surfaceVersion}' does not match the frozen ` +
        `contract surface '${CONTRACT_SURFACE_VERSION}'`,
    });
  }

  if (!Array.isArray(container.actions)) {
    diagnostics.push({
      code: 'INVALID_POLICY_FIELD',
      actionId: META_SCOPE,
      path: 'actions',
      message: 'meta-model actions must be an array',
    });
    return diagnostics;
  }

  const seen = new Set<string>();
  container.actions.forEach((entry, index) => {
    const id = rawActionId(entry, index);
    const parsed = ActionMetaModelSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map((p) => String(p)).join('.');
        const missing = resolveAtPath(entry, issue.path) === undefined;
        diagnostics.push({
          code: missing ? 'MISSING_POLICY_FIELD' : 'INVALID_POLICY_FIELD',
          actionId: id,
          path,
          message: issue.message,
        });
      }
      return;
    }
    diagnostics.push(...validateSurfaceCompatibility(parsed.data));
    if (seen.has(parsed.data.actionId)) {
      diagnostics.push({
        code: 'DUPLICATE_ACTION',
        actionId: parsed.data.actionId,
        path: 'actionId',
        message: `duplicate ActionId '${parsed.data.actionId}' in the meta-model`,
      });
    }
    seen.add(parsed.data.actionId);
  });

  return diagnostics;
}

function sortDiagnostics(diagnostics: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  const key = (d: CompilerDiagnostic): string => `${d.actionId}\u0000${d.code}\u0000${d.path}\u0000${d.message}`;
  return [...diagnostics].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ─── Compatibility report ────────────────────────────────────────────────────

/**
 * The change classes an action's policy ACTIVATES. Schema / authorization /
 * economy / presentation are always present (every action carries them); the
 * rest are gated on the action's declared behavior, so a read-only action does
 * not spuriously advertise `effect` or `cancellation` sensitivity.
 */
export function activeChangeClasses(policy: ActionPolicy): ChangeClass[] {
  const classes: ChangeClass[] = ['schema', 'authorization', 'economy', 'presentation'];
  if (policy.effect.mutates) classes.push('effect', 'idempotency');
  if (policy.authorization.destructive) classes.push('safety');
  if (policy.task.taskAugmentable) classes.push('task');
  if (policy.cancellation.cancellable) classes.push('cancellation');
  if (policy.evidence.autoEmits.length > 0) classes.push('evidence');
  if (policy.cache.cacheable) classes.push('cache');
  return sortedUnique(classes) as ChangeClass[];
}

function buildActionCompatibility(descriptor: ActionDescriptor): ActionCompatibility {
  const activated = activeChangeClasses(descriptor.policy);
  const changeClasses = activated.map((cls) => ({ class: cls, severity: changeClassSeverity(cls) }));
  return {
    actionId: descriptor.actionId,
    changeClasses,
    securitySensitive: changeClasses.some((c) => c.severity === 'security-sensitive'),
    refusesMixedVersionOnAdditive: activated.some((cls) => requiresMixedVersionRefusal(cls, 'additive')),
  };
}

function buildCompatibilityReport(
  surfaceVersion: string,
  descriptors: readonly ActionDescriptor[],
): CompatibilityReport {
  const actions = descriptors.map(buildActionCompatibility);
  return {
    surfaceVersion,
    compatibleWithSurface: surfaceVersion === CONTRACT_SURFACE_VERSION,
    versionChange: classifyVersionChange(surfaceVersion, CONTRACT_SURFACE_VERSION),
    securitySensitiveActionCount: actions.filter((a) => a.securitySensitive).length,
    actions,
  };
}

// ─── The pipeline ────────────────────────────────────────────────────────────

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compile the meta-model into the deterministic contract artifact. Gated on the
 * authority freeze, then on shape + surface compatibility. Total: it always
 * returns a `CompileOutcome` and never throws for bad input.
 */
export function compile(metaModel: unknown, opts: CompileOptions = {}): CompileOutcome {
  // Gate 1 — authority freeze. Refuse before emitting anything (P03-01 block point).
  const verdict = (opts.verifyAuthority ?? verifyContractAuthority)();
  if (!verdict.ok) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'AUTHORITY_BLOCKED',
          actionId: AUTHORITY_SCOPE,
          path: '',
          message: verdict.report,
        },
      ],
    };
  }

  // Gates 2 + 3 — shape + surface compatibility.
  const diagnostics = validateMetaModel(metaModel);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  // Validated: re-parse to the typed model (guaranteed to succeed now).
  const model: MetaModel = MetaModelSchema.parse(metaModel);
  const entries: readonly ActionMetaModel[] = [...model.actions].sort((a, b) =>
    byString(a.actionId, b.actionId),
  );

  const descriptors = entries.map(compileDescriptor);
  const schemas = buildSchemaBundle(entries);
  const types = buildTypeManifest(model.surfaceVersion, entries);
  const compatibilityReport = buildCompatibilityReport(model.surfaceVersion, descriptors);

  const contractBody = {
    surfaceVersion: model.surfaceVersion,
    descriptors,
    schemas,
    types,
    compatibilityReport,
  };
  const contractDigest = digestText(canonicalJson(contractBody));

  const proofFixtures = buildProofFixtures(model.surfaceVersion, descriptors, schemas, contractDigest, {
    ok: verdict.ok,
    authorityIds: [...AUTHORITY_IDS],
  });

  const serialized = canonicalJson({ ...contractBody, proofFixtures });
  const digest = digestText(serialized);

  return {
    ok: true,
    output: {
      surfaceVersion: model.surfaceVersion,
      descriptors,
      schemas,
      types,
      compatibilityReport,
      proofFixtures,
      contractDigest,
      serialized,
      digest,
    },
  };
}
