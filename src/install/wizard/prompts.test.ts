/**
 * Tests for the PromptAdapter interface and MockPromptAdapter.
 */

import { describe, it, expect } from 'vitest';
import {
  createPromptAdapter,
  MockPromptAdapter,
} from './prompts.js';
import type { PromptAdapter } from './prompts.js';

describe('createPromptAdapter', () => {
  it('returns an adapter instance', () => {
    const adapter = createPromptAdapter();

    expect(adapter).toBeDefined();
    expect(typeof adapter.select).toBe('function');
    expect(typeof adapter.multiselect).toBe('function');
    expect(typeof adapter.confirm).toBe('function');
    expect(typeof adapter.text).toBe('function');
  });
});

describe('MockPromptAdapter', () => {
  it('select returns preset value', async () => {
    const adapter = new MockPromptAdapter(['standard']);

    const result = await adapter.select('Choose mode:', [
      { label: 'Standard', value: 'standard' },
      { label: 'Dev', value: 'dev' },
    ]);

    expect(result).toBe('standard');
  });

  it('multiselect returns preset values', async () => {
    const adapter = new MockPromptAdapter([['server-a', 'server-b']]);

    const result = await adapter.multiselect('Choose servers:', [
      { label: 'Server A', value: 'server-a' },
      { label: 'Server B', value: 'server-b' },
      { label: 'Server C', value: 'server-c' },
    ]);

    expect(result).toEqual(['server-a', 'server-b']);
  });

  it('confirm returns preset boolean', async () => {
    const adapter = new MockPromptAdapter([true]);

    const result = await adapter.confirm('Proceed?');

    expect(result).toBe(true);
  });

  it('text returns preset string', async () => {
    const adapter = new MockPromptAdapter(['my-input']);

    const result = await adapter.text('Enter name:');

    expect(result).toBe('my-input');
  });

  it('dequeues responses in FIFO order', async () => {
    const adapter = new MockPromptAdapter(['first', 'second', 'third']);

    const r1 = await adapter.select('Q1:', [{ label: 'A', value: 'first' }]);
    const r2 = await adapter.select('Q2:', [{ label: 'B', value: 'second' }]);
    const r3 = await adapter.select('Q3:', [{ label: 'C', value: 'third' }]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(r3).toBe('third');
  });

  it('throws when response queue is exhausted', async () => {
    const adapter = new MockPromptAdapter([]);

    await expect(adapter.select('Q:', [{ label: 'A', value: 'a' }]))
      .rejects.toThrow('MockPromptAdapter: no more preset responses');
  });

  it('implements PromptAdapter interface', () => {
    const adapter: PromptAdapter = new MockPromptAdapter([]);

    expect(adapter).toBeDefined();
  });
});
