// ─── check_exploration_depth gate — DR-4 (Gap B) ────────────────────────────
//
// Tests run THROUGH `handleOrchestrate` so the dispatch wiring (registry action
// → ACTION_HANDLERS entry → handler) is exercised, not just the bare handler —
// guarding against the registered-action-without-a-dispatch-branch failure mode
// that returns UNKNOWN_ACTION.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  checkExplorationDepth,
  extractExplorationSection,
  resolveExplorationSkip,
  SKIPPED_BY_DEPTH,
} from '../../../../src/verbs/gates/check-exploration-depth.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
} from '../../../../tools/test-helpers/trusted-context.js';

const FEATURE_ID = 'exploration-feature';

// A `deep` spec whose Exploration section cites the discover pass by path +
// correlationId (the deep-only obligation per spec-template.md).
const DEEP_WITH_EXPLORATION = `# Spec: Example

## Design & Rationale

### Problem Statement

Something is broken.

### Exploration

Considered three approaches; the open-design path won. See the research report
at \`docs/research/2026-06-29-example.md\`, stitched by correlationId
\`discover-bridge:exploration-feature\`.

### Alternatives considered

- **Option B —** rejected.
`;

// A `deep` spec missing the `### Exploration` section entirely.
const DEEP_WITHOUT_EXPLORATION = `# Spec: Example

## Design & Rationale

### Problem Statement

Something is broken.

### Alternatives considered

- **Option B —** rejected.
`;

interface EnvelopeData {
  passed?: boolean;
  skipped?: boolean;
  discriminant?: string;
  hasSection?: boolean;
}

describe('check_exploration_depth gate (DR-4)', () => {
  let base: string;
  let stateDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'exploration-depth-'));
    stateDir = path.join(base, 'state');
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = {
      stateDir,
      eventStore,
      enableTelemetry: false,
      cwd: base,
    } as unknown as DispatchContext;
    // The gate records durable evidence, which binds to the active phase
    // attempt and reads the caller's authorization from the ambient dispatch
    // scope. Driving the handler below `dispatch()` means the test has to open
    // both, or it exercises the fail-closed path instead of the gate.
    await seedActivePhaseAttempt(eventStore, FEATURE_ID, { phase: 'plan' });
  });

  async function orchestrate(args: Record<string, unknown>): Promise<ToolResult> {
    return runAsTrustedCaller(stateDir, () => handleOrchestrate(args, ctx));
  }

  afterEach(async () => {
    // MUST close the SQLite handle before removing the temp dir — on Windows an
    // open `exarchos.db` handle blocks `fs.rm` with EBUSY (store.ts close()
    // contract). POSIX tolerates unlinking an open file, so this is Windows-only.
    eventStore.close();
    await rm(base, { recursive: true, force: true });
  });

  // ── Dispatch wiring: the action must route end-to-end ──────────────────────

  it('routes through handleOrchestrate (not UNKNOWN_ACTION)', async () => {
    const result = await orchestrate(
      { action: 'check_exploration_depth', featureId: FEATURE_ID, designDepth: 'standard' },
    );
    const errCode = result.success === false ? result.error?.code : undefined;
    expect(errCode).not.toBe('UNKNOWN_ACTION');
    expect(result.success).toBe(true);
  });

  // ── (a) deep WITHOUT an Exploration section → gate FAILS ───────────────────

  it('deep spec without `### Exploration` section fails the gate', async () => {
    const specPath = path.join(base, 'deep-without.md');
    await writeFile(specPath, DEEP_WITHOUT_EXPLORATION, 'utf-8');

    const result = await orchestrate(
      {
        action: 'check_exploration_depth',
        featureId: FEATURE_ID,
        designDepth: 'deep',
        designPath: specPath,
      },
    );

    expect(result.success).toBe(true);
    const data = result.data as EnvelopeData;
    expect(data.passed).toBe(false);
    expect(data.skipped).toBe(false);
    expect(data.hasSection).toBe(false);
  });

  // ── (b) deep WITH a valid Exploration section → gate PASSES ────────────────

  it('deep spec with a path + correlationId Exploration section passes', async () => {
    const specPath = path.join(base, 'deep-with.md');
    await writeFile(specPath, DEEP_WITH_EXPLORATION, 'utf-8');

    const result = await orchestrate(
      {
        action: 'check_exploration_depth',
        featureId: FEATURE_ID,
        designDepth: 'deep',
        designPath: specPath,
      },
    );

    expect(result.success).toBe(true);
    const data = result.data as EnvelopeData;
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(false);
  });

  // ── (c) standard / thin → SELF-SKIP (no artifact touched) ──────────────────

  it('standard depth self-skips the gate', async () => {
    const result = await orchestrate(
      { action: 'check_exploration_depth', featureId: FEATURE_ID, designDepth: 'standard' },
    );

    expect(result.success).toBe(true);
    const data = result.data as EnvelopeData;
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.discriminant).toBe(SKIPPED_BY_DEPTH);
  });

  it('thin depth self-skips the gate', async () => {
    const result = await orchestrate(
      { action: 'check_exploration_depth', featureId: FEATURE_ID, designDepth: 'thin' },
    );

    expect(result.success).toBe(true);
    const data = result.data as EnvelopeData;
    expect(data.skipped).toBe(true);
    expect(data.discriminant).toBe(SKIPPED_BY_DEPTH);
  });

  it('reports INVALID_INPUT when featureId is missing', async () => {
    const result = await orchestrate(
      { action: 'check_exploration_depth', designDepth: 'standard' },
    );
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error?.code).toBe('INVALID_INPUT');
    }
  });
});

// ── Pure-helper unit coverage (no dispatch / no event store) ─────────────────

describe('checkExplorationDepth (pure)', () => {
  it('extractExplorationSection returns null when the header is absent', () => {
    expect(extractExplorationSection(DEEP_WITHOUT_EXPLORATION)).toBeNull();
  });

  it('extractExplorationSection stops at the next h3 heading', () => {
    const section = extractExplorationSection(DEEP_WITH_EXPLORATION);
    expect(section).not.toBeNull();
    expect(section).toContain('docs/research/2026-06-29-example.md');
    // The trailing `### Alternatives considered` heading is NOT part of the body.
    expect(section).not.toContain('Alternatives considered');
  });

  it('fails when the Exploration section is missing', () => {
    const r = checkExplorationDepth(DEEP_WITHOUT_EXPLORATION);
    expect(r.passed).toBe(false);
    expect(r.hasSection).toBe(false);
  });

  it('fails when the section cites a path but no correlationId', () => {
    const md = `## Design & Rationale

### Exploration

See \`docs/research/foo.md\` for the divergent loop.
`;
    const r = checkExplorationDepth(md);
    expect(r.passed).toBe(false);
    expect(r.hasSection).toBe(true);
    expect(r.citesPath).toBe(true);
    expect(r.citesCorrelationId).toBe(false);
  });

  it('fails when the section cites a correlationId but no path', () => {
    const md = `## Design & Rationale

### Exploration

Stitched by correlationId discover-bridge:foo.
`;
    const r = checkExplorationDepth(md);
    expect(r.passed).toBe(false);
    expect(r.citesPath).toBe(false);
    expect(r.citesCorrelationId).toBe(true);
  });

  it('passes when the section cites both path and correlationId', () => {
    const r = checkExplorationDepth(DEEP_WITH_EXPLORATION);
    expect(r.passed).toBe(true);
    expect(r.citesPath).toBe(true);
    expect(r.citesCorrelationId).toBe(true);
  });
});

describe('resolveExplorationSkip (pure)', () => {
  it('skips at thin and standard, and when the stamp is absent', () => {
    expect(resolveExplorationSkip('thin')).not.toBeNull();
    expect(resolveExplorationSkip('standard')).not.toBeNull();
    expect(resolveExplorationSkip(undefined)).not.toBeNull();
  });

  it('does not skip at deep', () => {
    expect(resolveExplorationSkip('deep')).toBeNull();
  });
});
