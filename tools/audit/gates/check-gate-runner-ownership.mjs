#!/usr/bin/env node
/**
 * Deterministic gate-production ownership census (v2.12 / DR-5).
 *
 * This is deliberately a source census rather than an AST dependency. Exact
 * file/kind/count dispositions make additions fail closed while allowing the
 * v2.12 compatibility observations and v3.0-reserved transition guards to
 * remain visible. Exemptions are typed records, never directory allowlists.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROOT = 'src';
// These live outside `src/` after the evals fold but still carry owned
// taxonomy / fixture literals the census must keep counting.
const EXTRA_CENSUS_FILES = Object.freeze([
  'tools/evals/evals/benchmarks/seeded-defects/corpus.ts',
  'tools/evals/benchmarks/event-factories.ts',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const EXEMPTION_CATEGORIES = new Set([
  'diagnostic-observation',
  'telemetry-observation',
]);
const OWNER_CATEGORIES = new Set([
  'canonical-runner',
  'merged-durable-producer',
  'provider-registry',
  'gate-taxonomy',
  'legacy-v3-reservation',
]);

const diagnosticRationale =
  'Compatibility gate.executed observation only; it is not v2.12 admission evidence or an enforcement authority.';
const mergedRationale =
  'The enforceable result is persisted by the merged durable producer seam before a success carrier returns.';

/** @type {readonly {file:string, kind:string, count:number, owner:string, rationale:string, category:string}[]} */
const DISPOSITIONS = Object.freeze([
  // Canonical evidence-production seams.
  { file: 'src/verbs/gates/gate-runner.ts', kind: 'durable-runner', count: 3, owner: 'orchestrate/gate-runner', rationale: 'The canonical v2.12 runner owns normalized evidence execution and the awaited durable append.', category: 'canonical-runner' },
  // The canonical runner's own `gate.executed` append literal also matches the
  // manual-gate-event detector; it is the ONE producer that literal names.
  { file: 'src/verbs/gates/gate-runner.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/gate-runner', rationale: 'appendGateExecutedSignal inside the canonical runner is THE single gate.executed producer; the literal is its own append, not a bypass.', category: 'canonical-runner' },
  // The ownership census proves the seam live by invoking the real runner
  // twice (success + fail-closed witness) against throwaway in-memory stores.
  // Those invocations are observations of the canonical producer, not a
  // second production seam.
  { file: 'src/verbs/gates/gate-ownership-census.ts', kind: 'durable-runner', count: 2, owner: 'orchestrate/gate-ownership-census', rationale: 'Live-witness probes drive the canonical runGate against sacrificial stores to prove success-carries-evidence and fail-closed behavior; no enforceable evidence is produced outside the runner.', category: 'diagnostic-observation' },
  { file: 'src/verbs/gates/durable-gate-producer.ts', kind: 'durable-runner', count: 2, owner: 'orchestrate/durable-gate-producer', rationale: mergedRationale, category: 'merged-durable-producer' },
  ...[
    'src/verbs/gates/check-integration-suite.ts',
    'src/verbs/gates/contract-drift-handler.ts',
    'src/verbs/gates/mock-boundary-handler.ts',
    'src/verbs/gates/static-analysis.ts',
    'src/verbs/gates/test-adequacy-handler.ts',
  ].map((file) => ({
    file,
    kind: 'durable-runner',
    count: 1,
    owner: 'orchestrate/durable-gate-producer',
    rationale: mergedRationale,
    category: 'merged-durable-producer',
  })),
  ...[
    ['src/verbs/gates/plan-coverage.ts', 'orchestrate/gate-runner'],
    ['src/verbs/team/prepare-synthesis.ts', 'orchestrate/gate-runner'],
    ['src/verbs/gates/provenance-chain.ts', 'orchestrate/gate-runner'],
    ['src/verbs/review/review-verdict.ts', 'orchestrate/gate-runner'],
  ].map(([file, owner]) => ({
    file,
    kind: 'durable-runner',
    count: 1,
    owner,
    rationale: mergedRationale,
    category: 'merged-durable-producer',
  })),

  // One exhaustive provider owner and the shared benchmark taxonomy it maps.
  { file: 'src/verbs/gates/gate-provider-registry.ts', kind: 'provider-registration', count: 4, owner: 'orchestrate/gate-provider-registry', rationale: 'The exhaustive typed registry assigns exactly one action owner to every supported GateClass.', category: 'provider-registry' },
  { file: 'src/verbs/gates/gate-provider-registry.ts', kind: 'gate-class-definition', count: 3, owner: 'orchestrate/gate-provider-registry', rationale: 'Local phase classes extend the shared taxonomy only at the exhaustive provider registry. THREE definitions, not two: `MechanicalGateClass`, `PhaseGateClass`, and the union alias `SupportedGateClass = MechanicalGateClass | PhaseGateClass`. The alias is not a third AUTHORITY — it introduces no class of its own and changes meaning only when one of its two members changes — but the detector matches `type \\w*GateClass =` textually and cannot tell a union alias from a new taxonomy. Counted here rather than routed around: the alias arrived in 500cc832e (which moved the mechanical vocabulary out of the eval corpus) without this row being updated, so the census was reporting a real, unrecorded third definition. Recording it keeps the both-ways tooth intact — a genuinely new class in this file still trips the count.', category: 'provider-registry' },
  { file: 'tools/evals/evals/benchmarks/seeded-defects/corpus.ts', kind: 'gate-class-definition', count: 1, owner: 'seeded-defect-corpus', rationale: 'This closed benchmark taxonomy is the shared mechanical GateClass source consumed by the provider registry.', category: 'gate-taxonomy' },

  // Existing transition-shell topology is reserved, not newly approved. v3.0
  // retirement owns deletion; this census rejects any additional location.
  ...[
    ['src/config/define.ts', 'guard-definition', 1],
    ['src/config/validation.ts', 'guard-definition', 1],
    ['src/config/register.ts', 'legacy-custom-shell', 6],
    ['src/config/guards.ts', 'legacy-custom-shell', 1],
    ['src/workflow/state-machine.ts', 'legacy-custom-shell', 4],
    ['src/workflow/hsm-transition-guard.ts', 'legacy-custom-shell', 2],
  ].map(([file, kind, count]) => ({
    file,
    kind,
    count,
    owner: 'workflow-builder-v3-migration',
    rationale: 'Reserved legacy custom-shell transition guard retained for the v3.0 migration; no new guard path is permitted.',
    category: 'legacy-v3-reservation',
  })),

  // Typed, exact-file non-enforceable observation exemptions.
  ...[
    ['src/verbs/gates/check-convergence.ts', 1, 'orchestrate/check-convergence'],
    ['src/verbs/gates/check-event-emissions.ts', 1, 'orchestrate/check-event-emissions'],
    ['src/verbs/gates/check-exploration-depth.ts', 2, 'orchestrate/check-exploration-depth'],
    ['src/verbs/gates/check-invariant-conformance.ts', 1, 'orchestrate/check-invariant-conformance'],
    ['src/verbs/gates/context-economy.ts', 1, 'orchestrate/context-economy'],
    ['src/verbs/gates/gate-utils.ts', 1, 'orchestrate/gate-utils'],
    ['src/verbs/gates/mutation-adequacy.ts', 3, 'orchestrate/mutation-adequacy'],
    ['src/verbs/gates/operational-resilience.ts', 1, 'orchestrate/operational-resilience'],
    ['src/verbs/gates/plan-coverage.ts', 1, 'orchestrate/plan-coverage'],
    ['src/verbs/gates/post-merge.ts', 1, 'orchestrate/post-merge'],
    ['src/verbs/team/prepare-delegation.ts', 1, 'orchestrate/prepare-delegation'],
    ['src/verbs/team/prepare-synthesis.ts', 3, 'orchestrate/prepare-synthesis'],
    ['src/verbs/gates/provenance-chain.ts', 1, 'orchestrate/provenance-chain'],
    ['src/verbs/review/review-verdict.ts', 3, 'orchestrate/review-verdict'],
    ['src/verbs/gates/security-scan.ts', 1, 'orchestrate/security-scan'],
    ['src/verbs/tasks/task-decomposition.ts', 1, 'orchestrate/task-decomposition'],
    ['src/verbs/gates/workflow-determinism.ts', 1, 'orchestrate/workflow-determinism'],
  ].map(([file, count, owner]) => ({
    file,
    kind: 'direct-gate-emitter',
    count,
    owner,
    rationale: diagnosticRationale,
    category: 'diagnostic-observation',
  })),
  { file: 'src/verbs/vcs/assess-stack.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/assess-stack', rationale: 'Mirrors external CI check status for diagnostics; it does not produce admission evidence.', category: 'diagnostic-observation' },
  { file: 'src/verbs/gates/gate-utils.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/gate-utils', rationale: 'Legacy compatibility event helper; canonical enforceable proof is owned by gate-runner.', category: 'diagnostic-observation' },
  { file: 'tools/evals/benchmarks/event-factories.ts', kind: 'manual-gate-event', count: 1, owner: 'benchmarks/event-factories', rationale: 'Synthetic benchmark fixture construction cannot execute or enforce a workflow gate.', category: 'diagnostic-observation' },
  { file: 'src/verbs/review/review-verdict.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/review-verdict', rationale: 'Read-only query of compatibility observations; durable review evidence is produced by the merged runner seam.', category: 'diagnostic-observation' },
  { file: 'src/tasks/tools.ts', kind: 'manual-gate-event', count: 1, owner: 'tasks/tools', rationale: 'Read-only task status query; this path cannot emit or enforce gate evidence.', category: 'diagnostic-observation' },
  { file: 'src/projections/telemetry/middleware.ts', kind: 'manual-gate-event', count: 1, owner: 'telemetry/middleware', rationale: 'Fire-and-forget token-budget telemetry; append failure is explicitly non-fatal and cannot affect a transition.', category: 'telemetry-observation' },
  { file: 'src/workflow/playbooks.ts', kind: 'playbook-gate-observation', count: 17, owner: 'workflow/playbooks', rationale: 'Legacy model guidance describes compatibility observations only; it is not a provider or durable evidence path.', category: 'diagnostic-observation' },
]);

const DETECTORS = Object.freeze([
  { kind: 'direct-gate-emitter', regex: /\bemitGateEvent\s*\(/g },
  { kind: 'manual-gate-event', regex: /\btype\s*:\s*['"]gate\.executed['"]/g },
  { kind: 'durable-runner', regex: /\b(?:runGate|runGateWithEvidence|runPhaseGateWithEvidence|runDurableGateProducer)\s*\(/g },
  { kind: 'gate-class-definition', regex: /\b(?:export\s+)?type\s+\w*GateClass\s*=/g },
  { kind: 'provider-registration', regex: /\b(?:interface\s+GateProviderRegistration\b|const\s+BUILTIN_REGISTRATIONS\b|buildGateProviderRegistry\s*\(|(?:const|let|var)\s+\w*(?:GATE_PROVIDERS|GATE_REGISTRATIONS)\b)/g },
  { kind: 'guard-definition', regex: /\b(?:(?:export\s+)?interface\s+\w*(?:Gate|Guard)Definition|(?:export\s+)?const\s+\w*(?:gate|guard)DefinitionSchema)\b/g },
  { kind: 'legacy-custom-shell', regex: /\b(?:guardRegistry|executeGuard|createGuardFromDefinition)\b/g },
]);

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isProductionSource(relativePath) {
  const normalized = normalize(relativePath);
  const base = path.basename(normalized);
  return SOURCE_EXTENSIONS.has(path.extname(base)) &&
    !/\.(?:test|spec|bench)\.[^.]+$/.test(base) &&
    !normalized.split('/').some((part) =>
      part === '__fixtures__' || part === 'test-fixtures'
    );
}

async function walk(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute, root));
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      if (isProductionSource(relative)) files.push(relative);
    }
  }
  return files;
}

function lineNumber(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function collectFindings(relativePath, content) {
  const file = normalize(relativePath);
  const findings = [];
  for (const detector of DETECTORS) {
    if (
      detector.kind === 'manual-gate-event' &&
      file === 'src/workflow/playbooks.ts'
    ) continue;
    detector.regex.lastIndex = 0;
    for (const match of content.matchAll(detector.regex)) {
      findings.push({
        file,
        kind: detector.kind,
        line: lineNumber(content, match.index),
        token: match[0],
      });
    }
  }
  if (file === 'src/workflow/playbooks.ts') {
    for (const match of content.matchAll(/gate\.executed/g)) {
      findings.push({
        file,
        kind: 'playbook-gate-observation',
        line: lineNumber(content, match.index),
        token: match[0],
      });
    }
  }
  return findings.sort((left, right) =>
    left.line - right.line || left.kind.localeCompare(right.kind)
  );
}

function validateDispositions() {
  const violations = [];
  const seen = new Set();
  for (const disposition of DISPOSITIONS) {
    const key = `${disposition.file}\0${disposition.kind}`;
    if (seen.has(key)) violations.push(`duplicate disposition for ${disposition.file} (${disposition.kind})`);
    seen.add(key);
    if (!disposition.owner || !disposition.rationale || !disposition.category) {
      violations.push(`incomplete disposition for ${disposition.file} (${disposition.kind})`);
    }
    if (
      !OWNER_CATEGORIES.has(disposition.category) &&
      !EXEMPTION_CATEGORIES.has(disposition.category)
    ) {
      violations.push(`unknown category ${disposition.category} for ${disposition.file}`);
    }
  }
  return violations;
}

export async function censusGateRunnerOwnership(repoRoot) {
  const runtimeRoot = path.join(repoRoot, RUNTIME_ROOT);
  const runtimeStat = await stat(runtimeRoot);
  if (!runtimeStat.isDirectory()) throw new Error(`${RUNTIME_ROOT} is not a directory`);
  const isCompleteRepository = await stat(path.join(repoRoot, 'package.json'))
    .then((entry) => entry.isFile())
    .catch(() => false);

  const findings = [];
  for (const relative of await walk(runtimeRoot, repoRoot)) {
    findings.push(...collectFindings(relative, await readFile(path.join(repoRoot, relative), 'utf8')));
  }
  for (const extra of EXTRA_CENSUS_FILES) {
    const absolute = path.join(repoRoot, extra);
    try {
      const extraStat = await stat(absolute);
      if (extraStat.isFile()) {
        findings.push(...collectFindings(extra, await readFile(absolute, 'utf8')));
      }
    } catch {
      // Missing extra file: the disposition expected-count check reports found 0.
    }
  }

  const dispositionViolations = validateDispositions();
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.file}\0${finding.kind}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const violations = [];
  if (isCompleteRepository) {
    for (const disposition of DISPOSITIONS) {
      const key = `${disposition.file}\0${disposition.kind}`;
      const actual = groups.get(key)?.length ?? 0;
      if (actual < disposition.count) {
        violations.push({
          file: disposition.file,
          kind: disposition.kind,
          line: 1,
          token: '',
          message:
            `Owned census count drifted: expected ${disposition.count}, found ${actual}. ` +
            'Update the exact typed disposition only as part of the owning migration.',
        });
      }
    }
  }
  for (const [key, group] of groups) {
    const [file, kind] = key.split('\0');
    const disposition = DISPOSITIONS.find(
      (candidate) => candidate.file === file && candidate.kind === kind,
    );
    const allowed = disposition?.count ?? 0;
    for (const finding of group.slice(allowed)) {
      violations.push({
        ...finding,
        message:
          kind === 'legacy-custom-shell' || kind === 'guard-definition'
            ? 'Unowned legacy custom-shell transition guard. Keep reserved v3.0 guards at their declared owners; do not add a new guard path.'
            : kind === 'provider-registration' || kind === 'gate-class-definition'
              ? 'Unowned GateClass/provider registration. Register the class exactly once in orchestrate/gate-provider-registry.ts.'
              : 'Direct gate emitter is not owned. Route enforceable gate production through runDurableGateProducer/runPhaseGateWithEvidence; use a typed non-enforceable observation exemption only when it cannot affect transitions.',
      });
    }
  }
  return { findings, violations, dispositionViolations };
}

function parseArgs(argv) {
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repo-root' && argv[index + 1]) {
      repoRoot = path.resolve(argv[++index]);
    } else {
      return { error: `unknown or incomplete argument: ${argv[index]}` };
    }
  }
  return { repoRoot };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    process.stderr.write(`check-gate-runner-ownership: ${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await censusGateRunnerOwnership(args.repoRoot);
    if (result.dispositionViolations.length > 0) {
      process.stderr.write(
        `check-gate-runner-ownership: invalid typed dispositions:\n` +
        result.dispositionViolations.map((item) => `  - ${item}\n`).join(''),
      );
      process.exitCode = 1;
      return;
    }
    if (result.violations.length > 0) {
      process.stderr.write(
        `check-gate-runner-ownership: ${result.violations.length} violation(s):\n` +
        result.violations.map((item) =>
          `  ${item.file}:${item.line} [${item.kind}] ${item.message}\n`
        ).join(''),
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `check-gate-runner-ownership: clean — ${result.findings.length} production finding(s) have exact typed owners.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `check-gate-runner-ownership: census failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (argv1 === fileURLToPath(import.meta.url)) await main();
