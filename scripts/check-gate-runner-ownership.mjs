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

const RUNTIME_ROOT = 'servers/exarchos-mcp/src';
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
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-runner.ts', kind: 'durable-runner', count: 3, owner: 'orchestrate/gate-runner', rationale: 'The canonical v2.12 runner owns normalized evidence execution and the awaited durable append.', category: 'canonical-runner' },
  // The canonical runner's own `gate.executed` append literal also matches the
  // manual-gate-event detector; it is the ONE producer that literal names.
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-runner.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/gate-runner', rationale: 'appendGateExecutedSignal inside the canonical runner is THE single gate.executed producer; the literal is its own append, not a bypass.', category: 'canonical-runner' },
  // The ownership census proves the seam live by invoking the real runner
  // twice (success + fail-closed witness) against throwaway in-memory stores.
  // Those invocations are observations of the canonical producer, not a
  // second production seam.
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-ownership-census.ts', kind: 'durable-runner', count: 2, owner: 'orchestrate/gate-ownership-census', rationale: 'Live-witness probes drive the canonical runGate against sacrificial stores to prove success-carries-evidence and fail-closed behavior; no enforceable evidence is produced outside the runner.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/orchestrate/durable-gate-producer.ts', kind: 'durable-runner', count: 2, owner: 'orchestrate/durable-gate-producer', rationale: mergedRationale, category: 'merged-durable-producer' },
  ...[
    'check-integration-suite.ts',
    'contract-drift-handler.ts',
    'mock-boundary-handler.ts',
    'static-analysis.ts',
    'test-adequacy-handler.ts',
  ].map((name) => ({
    file: `servers/exarchos-mcp/src/orchestrate/${name}`,
    kind: 'durable-runner',
    count: 1,
    owner: 'orchestrate/durable-gate-producer',
    rationale: mergedRationale,
    category: 'merged-durable-producer',
  })),
  ...[
    'plan-coverage.ts',
    'prepare-synthesis.ts',
    'provenance-chain.ts',
    'review-verdict.ts',
  ].map((name) => ({
    file: `servers/exarchos-mcp/src/orchestrate/${name}`,
    kind: 'durable-runner',
    count: 1,
    owner: 'orchestrate/gate-runner',
    rationale: mergedRationale,
    category: 'merged-durable-producer',
  })),

  // One exhaustive provider owner and the shared benchmark taxonomy it maps.
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-provider-registry.ts', kind: 'provider-registration', count: 4, owner: 'orchestrate/gate-provider-registry', rationale: 'The exhaustive typed registry assigns exactly one action owner to every supported GateClass.', category: 'provider-registry' },
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-provider-registry.ts', kind: 'gate-class-definition', count: 2, owner: 'orchestrate/gate-provider-registry', rationale: 'Local phase classes extend the shared taxonomy only at the exhaustive provider registry.', category: 'provider-registry' },
  { file: 'servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts', kind: 'gate-class-definition', count: 1, owner: 'seeded-defect-corpus', rationale: 'This closed benchmark taxonomy is the shared mechanical GateClass source consumed by the provider registry.', category: 'gate-taxonomy' },

  // Existing transition-shell topology is reserved, not newly approved. v3.0
  // retirement owns deletion; this census rejects any additional location.
  ...[
    ['servers/exarchos-mcp/src/config/define.ts', 'guard-definition', 1],
    ['servers/exarchos-mcp/src/config/validation.ts', 'guard-definition', 1],
    ['servers/exarchos-mcp/src/config/register.ts', 'legacy-custom-shell', 6],
    ['servers/exarchos-mcp/src/config/guards.ts', 'legacy-custom-shell', 1],
    ['servers/exarchos-mcp/src/workflow/state-machine.ts', 'legacy-custom-shell', 4],
    ['servers/exarchos-mcp/src/workflow/hsm-transition-guard.ts', 'legacy-custom-shell', 2],
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
    ['check-convergence.ts', 1],
    ['check-event-emissions.ts', 1],
    ['check-exploration-depth.ts', 2],
    ['check-invariant-conformance.ts', 1],
    ['context-economy.ts', 1],
    ['gate-utils.ts', 1],
    ['mutation-adequacy.ts', 3],
    ['operational-resilience.ts', 1],
    ['plan-coverage.ts', 1],
    ['post-merge.ts', 1],
    ['prepare-delegation.ts', 1],
    ['prepare-synthesis.ts', 3],
    ['provenance-chain.ts', 1],
    ['pure/gate-preflight.ts', 1],
    ['review-verdict.ts', 3],
    ['security-scan.ts', 1],
    ['task-decomposition.ts', 1],
    ['workflow-determinism.ts', 1],
  ].map(([name, count]) => ({
    file: `servers/exarchos-mcp/src/orchestrate/${name}`,
    kind: 'direct-gate-emitter',
    count,
    owner: `orchestrate/${name.replace(/\.ts$/, '')}`,
    rationale: diagnosticRationale,
    category: 'diagnostic-observation',
  })),
  { file: 'servers/exarchos-mcp/src/orchestrate/assess-stack.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/assess-stack', rationale: 'Mirrors external CI check status for diagnostics; it does not produce admission evidence.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/orchestrate/gate-utils.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/gate-utils', rationale: 'Legacy compatibility event helper; canonical enforceable proof is owned by gate-runner.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/benchmarks/event-factories.ts', kind: 'manual-gate-event', count: 1, owner: 'benchmarks/event-factories', rationale: 'Synthetic benchmark fixture construction cannot execute or enforce a workflow gate.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/orchestrate/review-verdict.ts', kind: 'manual-gate-event', count: 1, owner: 'orchestrate/review-verdict', rationale: 'Read-only query of compatibility observations; durable review evidence is produced by the merged runner seam.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/tasks/tools.ts', kind: 'manual-gate-event', count: 1, owner: 'tasks/tools', rationale: 'Read-only task status query; this path cannot emit or enforce gate evidence.', category: 'diagnostic-observation' },
  { file: 'servers/exarchos-mcp/src/telemetry/middleware.ts', kind: 'manual-gate-event', count: 1, owner: 'telemetry/middleware', rationale: 'Fire-and-forget token-budget telemetry; append failure is explicitly non-fatal and cannot affect a transition.', category: 'telemetry-observation' },
  { file: 'servers/exarchos-mcp/src/workflow/playbooks.ts', kind: 'playbook-gate-observation', count: 17, owner: 'workflow/playbooks', rationale: 'Legacy model guidance describes compatibility observations only; it is not a provider or durable evidence path.', category: 'diagnostic-observation' },
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
      file === 'servers/exarchos-mcp/src/workflow/playbooks.ts'
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
  if (file === 'servers/exarchos-mcp/src/workflow/playbooks.ts') {
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
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
