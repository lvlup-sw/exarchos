import { describe, it, expect } from 'vitest';
import { GraderRegistry, createDefaultRegistry } from './index.js';
import { ExactMatchGrader } from './exact-match.js';
import { SchemaGrader } from './schema-grader.js';
import { ToolCallGrader } from './tool-call.js';
import { TracePatternGrader } from './trace-pattern.js';
import { LlmRubricGrader } from './llm-rubric.js';
import { LlmSimilarityGrader } from './llm-similarity.js';
import type { IGrader, GradeResult } from '../types.js';

describe('GraderRegistry', () => {
  // ─── Default registry contains all 6 types ──────────────────────────

  it('CreateDefaultRegistry_ContainsAllSixTypes', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.resolve('exact-match')).not.toThrow();
    expect(() => registry.resolve('schema')).not.toThrow();
    expect(() => registry.resolve('tool-call')).not.toThrow();
    expect(() => registry.resolve('trace-pattern')).not.toThrow();
    expect(() => registry.resolve('llm-rubric')).not.toThrow();
    expect(() => registry.resolve('llm-similarity')).not.toThrow();
  });

  // ─── Resolve each type returns correct grader ────────────────────────

  it('Resolve_ExactMatch_ReturnsExactMatchGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('exact-match');
    expect(grader).toBeInstanceOf(ExactMatchGrader);
  });

  it('Resolve_Schema_ReturnsSchemaGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('schema');
    expect(grader).toBeInstanceOf(SchemaGrader);
  });

  it('Resolve_ToolCall_ReturnsToolCallGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('tool-call');
    expect(grader).toBeInstanceOf(ToolCallGrader);
  });

  it('Resolve_TracePattern_ReturnsTracePatternGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('trace-pattern');
    expect(grader).toBeInstanceOf(TracePatternGrader);
  });

  // ─── LLM graders ───────────────────────────────────────────────────

  it('createDefaultRegistry_ResolvesLlmRubricGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('llm-rubric');
    expect(grader).toBeInstanceOf(LlmRubricGrader);
  });

  it('createDefaultRegistry_ResolvesLlmSimilarityGrader', () => {
    const registry = createDefaultRegistry();
    const grader = registry.resolve('llm-similarity');
    expect(grader).toBeInstanceOf(LlmSimilarityGrader);
  });

  // ─── Unknown type throws ─────────────────────────────────────────────

  it('Resolve_UnknownType_Throws', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.resolve('nonexistent')).toThrow();
  });

  // ─── Custom registration works ───────────────────────────────────────

  it('Register_CustomGrader_Resolvable', () => {
    const registry = new GraderRegistry();
    const customGrader: IGrader = {
      name: 'custom',
      type: 'custom',
      async grade(): Promise<GradeResult> {
        return { passed: true, score: 1.0, reason: 'custom' };
      },
    };
    registry.register('custom', customGrader);
    expect(registry.resolve('custom')).toBe(customGrader);
  });

  it('Register_OverridesExisting_Resolvable', () => {
    const registry = createDefaultRegistry();
    const customGrader: IGrader = {
      name: 'custom-exact',
      type: 'exact-match',
      async grade(): Promise<GradeResult> {
        return { passed: true, score: 1.0, reason: 'overridden' };
      },
    };
    registry.register('exact-match', customGrader);
    expect(registry.resolve('exact-match')).toBe(customGrader);
  });

  // ─── Empty registry ──────────────────────────────────────────────────

  it('EmptyRegistry_Resolve_Throws', () => {
    const registry = new GraderRegistry();
    expect(() => registry.resolve('exact-match')).toThrow();
  });
});
