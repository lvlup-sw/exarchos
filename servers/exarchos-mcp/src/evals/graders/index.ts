import type { IGrader } from '../types.js';
import { ExactMatchGrader } from './exact-match.js';
import { SchemaGrader } from './schema-grader.js';
import { ToolCallGrader } from './tool-call.js';
import { TracePatternGrader } from './trace-pattern.js';

/**
 * Registry for grader instances, keyed by assertion type.
 */
export class GraderRegistry {
  private readonly graders = new Map<string, IGrader>();

  /**
   * Register a grader for a given assertion type.
   */
  register(type: string, grader: IGrader): void {
    this.graders.set(type, grader);
  }

  /**
   * Resolve a grader by assertion type. Throws if not found.
   */
  resolve(type: string): IGrader {
    const grader = this.graders.get(type);
    if (!grader) {
      throw new Error(`Unknown grader type: ${type}`);
    }
    return grader;
  }
}

/**
 * Create a registry pre-populated with all built-in graders.
 */
export function createDefaultRegistry(): GraderRegistry {
  const registry = new GraderRegistry();
  registry.register('exact-match', new ExactMatchGrader());
  registry.register('schema', new SchemaGrader());
  registry.register('tool-call', new ToolCallGrader());
  registry.register('trace-pattern', new TracePatternGrader());
  return registry;
}
