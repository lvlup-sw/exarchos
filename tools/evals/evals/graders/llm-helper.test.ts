import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GradeResult } from '../types.js';

// We'll need to mock process.env and promptfoo
const originalEnv = process.env;

describe('callLlmAssertion', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('CallLlmAssertion_NoApiKey_ReturnsSkipped', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { callLlmAssertion } = await import('./llm-helper.js');
    const fn = vi.fn();
    const result = await callLlmAssertion(fn, [], {});
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty('skipped', true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('CallLlmAssertion_ApiKeyError_ReturnsSkipped', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const { callLlmAssertion } = await import('./llm-helper.js');
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));
    const result = await callLlmAssertion(fn, ['arg1'], { model: 'test' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty('skipped', true);
  });

  it('CallLlmAssertion_GenericError_ReturnsFailure', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const { callLlmAssertion } = await import('./llm-helper.js');
    const fn = vi.fn().mockRejectedValue(new Error('network timeout'));
    const result = await callLlmAssertion(fn, [], { model: 'test' });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('network timeout');
  });

  it('CallLlmAssertion_Success_ReturnsNormalizedResult', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const { callLlmAssertion } = await import('./llm-helper.js');
    const fn = vi.fn().mockResolvedValue({ pass: true, score: 0.85, reason: 'Good match' });
    const result = await callLlmAssertion(fn, ['a', 'b'], { model: 'claude' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.reason).toBe('Good match');
  });
});
