/**
 * Ownership census for admission evidence. The durable gate runner must be the only module that
 * appends it. The census fails on an alternate emitter, on a gate with no registered provider,
 * and on a runner success without a durable evidence append. It also fails on an unresolved append
 * site in an unacknowledged module, and on a stale acknowledgement. It checks the real system: a
 * source scan, the live registry, and a probe of the real runner. The scan resolves constants,
 * aliased imports, and hoisted event objects.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { ContentAddressedStore } from '../../storage/artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../../workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../dispatch/dispatch-context.js';
import { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { TOOL_REGISTRY } from '../../registry.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { ADMISSION_EVENT_TYPES } from '../../workflow/admission/types.js';
import { runGate } from './gate-runner.js';
import type { GateProviderRegistry } from './gate-provider-registry.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from './gate-provider-registry.js';

/** Repo-relative module that is permitted to append admission evidence. */
export const CANONICAL_EVIDENCE_EMITTER_MODULE = 'verbs/gates/gate-runner.ts';

const EVIDENCE_EVENT_TYPE = ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED;

export interface EvidenceEmitterSite {
  /** Source module (relative to the scan root, forward-slashed). */
  readonly module: string;
  /** True only for the single canonical durable runner module. */
  readonly canonical: boolean;
}

/**
 * One `.append(...)` call site with its resolved event discriminant. The scanner follows
 * aliases, constant members, and hoisted event bindings to the value of the `type:` property.
 * `undefined` means that `type:` did not reduce to a string, which is a reportable gap.
 */
export interface EvidenceAppendSite {
  /** 1-based line of the `.append(` call in the scanned source. */
  readonly line: number;
  /** The resolved event-type discriminant, or `undefined` when unresolvable. */
  readonly discriminant: string | undefined;
}

/** Inputs a scanner needs beyond the source text. */
export interface EvidenceScanOptions {
  /** Appears only in parse diagnostics. It does not change the answer. */
  readonly fileName?: string;
  /**
   * Dotted access paths, such as `ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`, mapped to their values.
   * Thus a discriminant written as a constant resolves like the raw literal.
   */
  readonly knownConstants: ReadonlyMap<string, string>;
}

/**
 * The append-site scanner port. It is required, not defaulted, because only the TypeScript
 * compiler parses the grammar correctly, and `typescript` is a devDependency. The
 * implementation is in `tools/test-helpers/evidence-emission-scanner.ts`.
 */
export type EvidenceEmissionScanner = (
  source: string,
  options: EvidenceScanOptions,
) => readonly EvidenceAppendSite[];

/** The discriminant vocabulary for a scanner, derived from the live constant table. */
export const EVIDENCE_DISCRIMINANT_CONSTANTS: ReadonlyMap<string, string> = Object.freeze(
  new Map(
    Object.entries(ADMISSION_EVENT_TYPES).map(
      ([member, value]) => [`ADMISSION_EVENT_TYPES.${member}`, value] as const,
    ),
  ),
);

/**
 * Modules that append an event with a runtime discriminant, such as a parameter or a cast.
 * No static scan can name that event. They are acknowledged, not skipped, because "unreadable"
 * and "not an emitter" are different answers. Each appends a caller-supplied type to a
 * non-admission stream. The set is shrink-only: a module whose appends all resolve is a
 * `STALE_UNRESOLVED_ACKNOWLEDGEMENT`. To remove a row, narrow the emitted `type` to a literal union.
 */
export const ACKNOWLEDGED_UNRESOLVED_MODULES: ReadonlySet<string> = Object.freeze(
  new Set([
    'dispatch/core/onboarding/event-ctx.ts',
    'events/store.ts',
    'events/tools.ts',
    'projections/task-store/event-sourced-task-store.ts',
    'storage/sidecar-merger.ts',
    'storage/sidecar-scheduler.ts',
    'vcs/mutation-owner.ts',
    'verbs/gates/mutation-adequacy.ts',
    'verbs/team/prepare-delegation.ts',
    'verbs/worktree/manager.ts',
    'verbs/worktree/merge-serializer.ts',
    'workflow/cancel.ts',
  ]),
);

export interface EnforceableGate {
  readonly gateClass: string;
  readonly actionName: string;
}

/**
 * Behavioural facts about the durable runner, collected by exercising the real
 * {@link runGate}. Both must hold for evidence production to be trustworthy.
 */
export interface DurabilityWitness {
  /** The runner returned a failure when the durable append threw. */
  readonly failsClosedOnAppendFailure: boolean;
  /** Every success carrier the runner produced referenced persisted evidence. */
  readonly successCarriesDurableEvidence: boolean;
}

/** The location of an `.append(...)` site that the scan did not resolve. */
export interface UnresolvedDiscriminantSite {
  readonly module: string;
  readonly line: number;
}

export interface OwnershipCensusModel {
  readonly emitterSites: readonly EvidenceEmitterSite[];
  readonly enforceableGates: readonly EnforceableGate[];
  readonly registry: GateProviderRegistry;
  readonly durability: DurabilityWitness;
  /**
   * Append sites whose event discriminant did not reduce to a string. Omitted
   * (not empty) by callers that did not scan for them, which also suspends the
   * stale-acknowledgement arm — an absent scan is not evidence of a shrink.
   */
  readonly unresolvedDiscriminants?: readonly UnresolvedDiscriminantSite[];
  /** Override for {@link ACKNOWLEDGED_UNRESOLVED_MODULES} (kill fixtures). */
  readonly acknowledgedUnresolvedModules?: ReadonlySet<string>;
}

/**
 * One census finding. `UNRESOLVED_EVIDENCE_DISCRIMINANT` marks an append site, in a module that
 * is not acknowledged, whose discriminant does not reduce to a string. An unreadable emitter can
 * append evidence, so the census reports it. `STALE_UNRESOLVED_ACKNOWLEDGEMENT` marks an
 * acknowledged module whose appends now all resolve, so its row must go.
 */
export type OwnershipCensusDiagnostic =
  | {
      readonly code: 'ALTERNATE_EVIDENCE_EMITTER';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'UNREGISTERED_GATE_PROVIDER';
      readonly gateClass: string;
      readonly actionName: string;
      readonly message: string;
    }
  | {
      readonly code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE';
      readonly message: string;
    }
  | {
      readonly code: 'UNRESOLVED_EVIDENCE_DISCRIMINANT';
      readonly module: string;
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_UNRESOLVED_ACKNOWLEDGEMENT';
      readonly module: string;
      readonly message: string;
    };

export interface OwnershipCensusResult {
  readonly ok: boolean;
  readonly diagnostics: readonly OwnershipCensusDiagnostic[];
}

/**
 * Pure ownership verdict over a collected model. Each check adds its own diagnostic, so the
 * removal of one check leaves its violation undetected. The stale-acknowledgement check runs
 * only when the model carries scan results, because an absent scan is not evidence of a shrink.
 */
export function runOwnershipCensus(
  model: OwnershipCensusModel,
): OwnershipCensusResult {
  const diagnostics: OwnershipCensusDiagnostic[] = [];

  for (const site of [...model.emitterSites].sort((a, b) =>
    a.module < b.module ? -1 : a.module > b.module ? 1 : 0,
  )) {
    if (!site.canonical) {
      diagnostics.push({
        code: 'ALTERNATE_EVIDENCE_EMITTER',
        module: site.module,
        message:
          `Module "${site.module}" appends "${EVIDENCE_EVENT_TYPE}" directly; ` +
          `admission evidence may only be produced by "${CANONICAL_EVIDENCE_EMITTER_MODULE}".`,
      });
    }
  }

  for (const gate of model.enforceableGates) {
    const resolution = model.registry.resolve(gate.gateClass);
    if (!resolution.success) {
      diagnostics.push({
        code: 'UNREGISTERED_GATE_PROVIDER',
        gateClass: gate.gateClass,
        actionName: gate.actionName,
        message:
          `Enforceable gate "${gate.gateClass}" (action "${gate.actionName}") ` +
          `resolves to no registered provider.`,
      });
    }
  }

  if (
    !model.durability.failsClosedOnAppendFailure ||
    !model.durability.successCarriesDurableEvidence
  ) {
    diagnostics.push({
      code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE',
      message:
        'The durable gate runner can report success without a persisted evidence ' +
        'record; evidence must be appended before any success carrier is returned.',
    });
  }

  const unresolved = model.unresolvedDiscriminants ?? [];
  const acknowledged = model.acknowledgedUnresolvedModules ?? ACKNOWLEDGED_UNRESOLVED_MODULES;
  for (const site of unresolved) {
    if (acknowledged.has(site.module)) continue;
    diagnostics.push({
      code: 'UNRESOLVED_EVIDENCE_DISCRIMINANT',
      module: site.module,
      line: site.line,
      message:
        `Module "${site.module}" appends an event at line ${site.line} whose \`type\` ` +
        `discriminant does not reduce to a string. The census cannot tell whether it ` +
        `produces "${EVIDENCE_EVENT_TYPE}"; write the discriminant as a literal or as a ` +
        `member of an exported constant table so ownership stays decidable.`,
    });
  }

  if (model.unresolvedDiscriminants !== undefined) {
    const stillUnresolved = new Set(unresolved.map((site) => site.module));
    for (const module of acknowledged) {
      if (stillUnresolved.has(module)) continue;
      diagnostics.push({
        code: 'STALE_UNRESOLVED_ACKNOWLEDGEMENT',
        module,
        message:
          `Module "${module}" is acknowledged as having an unresolvable event ` +
          `discriminant, but every append in it now resolves. Delete the row — the ` +
          `acknowledgement set is shrink-only.`,
      });
    }
  }

  return Object.freeze({ ok: diagnostics.length === 0, diagnostics });
}

/**
 * True when an `.append(...)` in `source` builds an event whose resolved discriminant is the
 * admission-evidence type. The literal, the `ADMISSION_EVENT_TYPES` member, an aliased import,
 * and a hoisted event object all resolve the same. A `.query(...)` filter is not an append.
 */
export function sourceEmitsEvidence(
  source: string,
  scan: EvidenceEmissionScanner,
  fileName?: string,
): boolean {
  return scanAppendSites(source, scan, fileName).some(
    (site) => site.discriminant === EVIDENCE_EVENT_TYPE,
  );
}

function scanAppendSites(
  source: string,
  scan: EvidenceEmissionScanner,
  fileName?: string,
): readonly EvidenceAppendSite[] {
  return scan(source, {
    ...(fileName === undefined ? {} : { fileName }),
    knownConstants: EVIDENCE_DISCRIMINANT_CONSTANTS,
  });
}

/**
 * Lists the `.ts` files under `root`, without `node_modules`, `.test.ts`, `.bench.ts`, and `.d.ts`
 * files. The build does not emit those files, so they cannot be shipped emitters.
 */
async function collectTypeScriptSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.bench.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** What one scan of a source tree found. */
export interface EmitterScanResult {
  readonly sites: readonly EvidenceEmitterSite[];
  readonly unresolvedDiscriminants: readonly UnresolvedDiscriminantSite[];
}

/**
 * Scans the non-test TypeScript modules under `sourceRoot`. It returns the modules that append
 * admission evidence, and the append sites with an unresolved discriminant. The canonical
 * durable runner is the only expected emitter.
 */
export async function scanEvidenceEmitters(
  sourceRoot: string,
  scan: EvidenceEmissionScanner,
): Promise<EmitterScanResult> {
  const files = await collectTypeScriptSources(sourceRoot);
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
  );
  const sites: EvidenceEmitterSite[] = [];
  const unresolved: UnresolvedDiscriminantSite[] = [];
  for (const { file, source } of sources) {
    const module = relative(sourceRoot, file).replaceAll('\\', '/');
    const appendSites = scanAppendSites(source, scan, module);
    for (const site of appendSites) {
      if (site.discriminant === undefined) {
        unresolved.push({ module, line: site.line });
      }
    }
    if (!appendSites.some((site) => site.discriminant === EVIDENCE_EVENT_TYPE)) {
      continue;
    }
    sites.push({
      module,
      canonical: module === CANONICAL_EVIDENCE_EMITTER_MODULE,
    });
  }
  return Object.freeze({
    sites: Object.freeze(sites),
    unresolvedDiscriminants: Object.freeze(unresolved),
  });
}

/** {@link scanEvidenceEmitters}, emitter sites only. */
export async function scanEvidenceEmitterSites(
  sourceRoot: string,
  scan: EvidenceEmissionScanner,
): Promise<readonly EvidenceEmitterSite[]> {
  return (await scanEvidenceEmitters(sourceRoot, scan)).sites;
}

/**
 * Every orchestrate action that declares a shared mechanical `gateClass` is an
 * enforceable gate and must resolve to a registered provider.
 */
export function collectEnforceableGates(): readonly EnforceableGate[] {
  const orchestrate = TOOL_REGISTRY.find(
    (tool) => tool.name === 'exarchos_orchestrate',
  );
  if (orchestrate === undefined) return Object.freeze([]);
  const gates: EnforceableGate[] = [];
  for (const action of orchestrate.actions) {
    const gateClass = action.gate?.gateClass;
    if (gateClass !== undefined) {
      gates.push({ gateClass, actionName: action.name });
    }
  }
  return Object.freeze(gates);
}

const WITNESS_TIME = '2026-08-03T00:00:00.000Z';

function witnessDispatchContext(sessionId: string): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId });
  const authorization = snapshotCallerAuthorization(
    identity,
    createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]),
    () => WITNESS_TIME,
  );
  return mintDispatchContext(undefined, authorization);
}

function referencesPersistedEvidence(result: ToolResult): boolean {
  const data = result.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const references = (data as { readonly evidenceReferences?: unknown })
    .evidenceReferences;
  return Array.isArray(references) && references.length > 0;
}

/**
 * Exercise the real durable runner and report whether success is gated on a
 * persisted evidence append. Uses a throwaway on-disk event store so the probe
 * observes production persistence semantics, not a stub.
 */
export async function witnessRunnerDurability(): Promise<DurabilityWitness> {
  const root = await mkdtemp(join(tmpdir(), 'exarchos-ownership-census-'));
  const eventStore = new EventStore(join(root, 'events'));
  try {
    await eventStore.initialize();
    const artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
    const request = {
      streamId: 'ownership-census-witness',
      gateClass: 'test-adequacy',
      phaseAttemptId: 'phase-attempt:census-witness',
      requirementId: 'requirement:ownership-census',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'census-witness' },
        { commit: 'census0', diff: 'census-diff' },
      ),
      providerInput: { taskId: 'census-witness' },
    };
    const passingProvider = async (): Promise<ToolResult> => ({
      success: true,
      data: { passed: true },
    });

    const success = await runWithDispatchContext(
      witnessDispatchContext('census-success'),
      () =>
        runGate(request, {
          eventStore,
          artifactStore,
          executeProvider: passingProvider,
          clock: () => WITNESS_TIME,
        }),
    );
    const persisted = await eventStore.query(request.streamId, {
      type: EVIDENCE_EVENT_TYPE,
    });
    const successCarriesDurableEvidence =
      success.success === true &&
      referencesPersistedEvidence(success) &&
      persisted.length >= 1;

    const failingStore: Pick<EventStore, 'append' | 'query'> = {
      query: eventStore.query.bind(eventStore),
      append: async () => {
        throw new Error('census: durable store unavailable');
      },
    };
    const failClosed = await runWithDispatchContext(
      witnessDispatchContext('census-fail'),
      () =>
        runGate(request, {
          eventStore: failingStore,
          artifactStore,
          executeProvider: passingProvider,
          clock: () => WITNESS_TIME,
        }),
    );
    const failsClosedOnAppendFailure = failClosed.success === false;

    return Object.freeze({
      failsClosedOnAppendFailure,
      successCarriesDurableEvidence,
    });
  } finally {
    eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Collect the full ownership model from the live system and return the verdict.
 * This is the callable the exit-proof harness drives against the real tree.
 */
export async function auditEvidenceOwnership(
  sourceRoot: string,
  scan: EvidenceEmissionScanner,
  registry: GateProviderRegistry = BUILTIN_GATE_PROVIDER_REGISTRY,
): Promise<OwnershipCensusResult> {
  const [emitters, durability] = await Promise.all([
    scanEvidenceEmitters(sourceRoot, scan),
    witnessRunnerDurability(),
  ]);
  return runOwnershipCensus({
    emitterSites: emitters.sites,
    enforceableGates: collectEnforceableGates(),
    registry,
    durability,
    unresolvedDiscriminants: emitters.unresolvedDiscriminants,
  });
}
