import { writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

// target → { layer, published }. `install` is a declared NON-layer peer.
const TARGETS = {
  storage:     { layer: 'L1', name: 'Storage' },
  events:      { layer: 'L2', name: 'Event store' },
  projections: { layer: 'L3', name: 'Projections' },
  workflow:    { layer: 'L4', name: 'Workflow primitives' },
  contract:    { layer: 'L5', name: 'Dispatch core' },
  dispatch:    { layer: 'L5', name: 'Dispatch core' },
  verbs:       { layer: 'L6', name: 'Composite tools' },
  lifecycle:   { layer: 'L7', name: 'Lifecycle verbs' },
  adapters:    { layer: 'L8', name: 'Adapters' },
  runtime:     { layer: 'L9', name: 'Cooperative agents' },
  install:     { layer: null, name: 'Install (non-layer peer)' },
};

const M = (target, why) => ({ target, why });
const X = (destination, why) => ({ exception: true, destination, why });

const MAP = {
  storage:      M('storage', 'The SQLite backend, its lifecycle and the sidecar merger — L1 itself. Task 012 folded artifacts/ in: the content-addressed store is persistence, and its path-containment guards travel with it.'),
  events:       M('events', 'Append, expected-sequence, idempotency, the composite reader — L2 itself. Task 012 renamed event-store/ to match its target.'),
  projections:  M('projections', 'Pure reducers, cursors, snapshot/rebuild — L3 itself. Task 012 folded views/, telemetry/, quality/, session/ and task-store/ in as subdirectories; each remains a read model that derives and never decides.'),
  workflow:     M('workflow', 'State machines, phase contracts, guards, checkpoint — L4 itself. Task 013 folded topology/ in: the phase-contract loader and staleness signal are workflow-primitive data, not a layer of their own.'),

  config:       M('workflow', 'Cross-cutting by nature, but its output is the resolved config the dispatch context and workflow guards read. Placed at its consumer, not split.'),
  contract:     M('contract', 'Authority collection, digests, IR and admission — the contract half of the L5 split. Task 014 folded schemas/, sdk/ and shared/ in: all three are contract surface.'),
  dispatch:     M('dispatch', 'Caller identity, dispatch context, elicitation dispatch — the dispatch half of the L5 split. Task 014 folded core/ in: context.ts and dispatch.ts ARE the single dispatch function L5 describes.'),
  verbs:        M('verbs', 'The action bodies behind the composite tools — the largest single directory in the tree (159 files) and squarely L6. Task 015 regrouped it from a flat `orchestrate/` into capability families; it now sits at its target.'),
  review:       M('verbs', 'Review dispatch, classifier and check catalog are composite-tool actions.'),
  pruner:       M('verbs', 'Prune coordinator and scoring are a composite-tool action.'),
  stack:        M('verbs', 'Stack tools are composite-tool actions.'),
  tasks:        M('verbs', 'Task tools are composite-tool actions.'),
  lifecycle:    M('lifecycle', 'Command bodies invoked by the CLI adapter; the logic is verb-shaped, the surface is not. Task 017 moved it from `cli-commands/` to its L7 target.'),
  describe:     M('lifecycle', 'L7 names describe explicitly among its generic windows over the log.'),
  runbooks:     M('lifecycle', 'Resolved here per plan: runbooks are generic operator windows, the same shape as ps/describe/wait/export.'),
  sync:         M('lifecycle', 'Outbox and sync handler are lifecycle-shaped generic windows, not workflow primitives.'),
  adapters:     M('adapters', 'CLI and MCP over one dispatch core — L8 itself.'),
  mcp:          M('adapters', 'MCP wire methods (elicitation, notifications, tasks) are adapter surface.'),
  cli:          M('adapters', 'Follow-loop and formatter are CLI adapter surface.'),
  hooks:        M('adapters', 'Hook config is an adapter-side integration point.'),

  ndjson:       M('adapters', 'Frame encoding and heartbeat are transport framing beneath the adapters.'),
  vcs:          M('adapters', 'GitHub/GitLab/ADO providers adapt an external system; same shape as L8.'),
  runtime:      M('runtime', 'Environment detection and command shims — L9 itself.'),

  install:      M('install', 'Atomic promotion and freshness checks. Declared NON-layer peer: it installs the engine rather than sitting in its call graph.'),

  architecture: X('tools/conformance/', 'Conformance scanners and seam audits. They read the tree; they are not part of it. Extraction named in the plan.'),

  __tests__:    X('(stays test-adjacent)', 'Integration tests and the parity harness — test-only (44 files).'),
  commands:     X('(stays test-adjacent)', 'Test-only (3 files, all .test.ts): prose assertions over commands/*.md, which live at the repo root, not here.'),

  utils:        X('(unresolved — task 020)', 'atomic-write, paths, process, task-id: genuinely cross-cutting with consumers in five layers. Splitting it is a task 020 decision, not a naming one; recorded unresolved rather than forced.'),
};

const dirs = readdirSync(SRC).filter((d) => statSync(path.join(SRC, d)).isDirectory()).sort();
const missing = dirs.filter((d) => !(d in MAP));
const extra = Object.keys(MAP).filter((d) => !dirs.includes(d));
if (missing.length || extra.length) {
  console.error('MISSING:', missing, '\nEXTRA:', extra);
  process.exit(1);
}

const directories = {};
for (const d of dirs) {
  const e = MAP[d];
  directories[d] = e.exception
    ? { disposition: 'exception', destination: e.destination, reason: e.why }
    : { disposition: 'mapped', target: e.target, layer: TARGETS[e.target].layer, reason: e.why };
}

const publishedLayers = {};
for (const [target, meta] of Object.entries(TARGETS)) {
  if (meta.layer === null) continue;
  (publishedLayers[meta.layer] ??= { name: meta.name, targets: [] }).targets.push(target);
}

const doc = {
  capturedAt: new Date().toISOString().slice(0, 10),
  tree: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  source: 'src',
  authority:
    'docs/system-design.html is the canonical L1-L9 architecture; this file maps the tree onto it. ' +
    'Task 044 asserts THIS mapping, not set equality, which is why the 11 targets -> 9 published ' +
    'layers relation is written out rather than inferred.',
  counts: {
    directories: dirs.length,
    mapped: Object.values(directories).filter((v) => v.disposition === 'mapped').length,
    exceptions: Object.values(directories).filter((v) => v.disposition === 'exception').length,
    targets: Object.keys(TARGETS).length,
    publishedLayers: Object.keys(publishedLayers).length,
  },
  publishedLayers,
  nonLayerPeers: {
    install: 'Declared non-layer peer. It installs and packages the engine rather than sitting in its call graph, so it is a sibling of L1-L9, not a tenth layer.',
  },
  splitNote:
    'L5 (Dispatch core) is the one layer served by two target directories: `contract` (what may be ' +
    'called, and its authority) and `dispatch` (the single function that calls it). They are split ' +
    'because the contract is asserted independently of the dispatcher that honours it.',
  directories,
};

writeFileSync(path.join(ROOT, 'tools/audit/layer-map.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${dirs.length} directories: ${doc.counts.mapped} mapped, ${doc.counts.exceptions} exceptions, ${doc.counts.publishedLayers} published layers`);
