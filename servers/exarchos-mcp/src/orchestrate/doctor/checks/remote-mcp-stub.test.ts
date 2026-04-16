import { describe, it, expect } from 'vitest';
import { remoteMcpStub } from './remote-mcp-stub.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';

const signal = new AbortController().signal;

describe('remote-mcp-stub', () => {
  it('RemoteMcpStub_NoConfigPresent_ReturnsSkippedWithPendingReason', async () => {
    const probes = makeStubProbes();

    const result = await remoteMcpStub(probes, signal);

    expect(result.category).toBe('remote');
    expect(result.name).toBe('remote-mcp');
    expect(result.status).toBe('Skipped');
    expect(result.reason).toBe(
      'Remote MCP not configured; basileus integration pending (#1081)',
    );
    expect(result.durationMs).toBe(0);
    expect(result.message).toBe(
      'Remote MCP connectivity probe is deferred until basileus ships',
    );
  });
});
