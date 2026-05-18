// ─── T3 / #1436 — Elicitation form-mode E2E fixture smoke test ──────────────
//
// Sanity-only test for the fixture itself. The accept / decline / capability-
// absent path tests (T4 / T5 / T6) build on `createElicitationTestPair`, so a
// failure here would cascade across the substrate-realization wave. This
// test proves the wiring works end-to-end (handshake + tool registration)
// before the path tests layer assertions on top.
//
// Design: `docs/designs/2026-05-17-preview-4-substrate-realization.md` §4.1.

import { describe, it, expect } from 'vitest';
import { createElicitationTestPair } from './elicitation-roundtrip.fixture.js';

describe('#1436 — elicitation-roundtrip fixture smoke', () => {
  it('CreateElicitationTestPair_DefaultArgs_HandshakeSucceeds', async () => {
    // Default-args path: no client capabilities declared, no elicitation
    // handler attached. Verifies the InMemoryTransport handshake completes
    // and the server advertises a non-empty `tools/list` (matches the
    // production registry shape — `exarchos_workflow`, `exarchos_event`,
    // etc.). If this fails, T4 / T5 / T6 are blocked.
    const pair = await createElicitationTestPair({});
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await pair.cleanup();
    }
  });
});
