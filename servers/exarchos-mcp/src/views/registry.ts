import { ViewMaterializer } from './materializer.js';
import type { ViewProjection } from './materializer.js';

// ─── Built-in View Names ────────────────────────────────────────────────────
//
// These correspond to the action names exposed through `exarchos_view` in the
// registry plus the internal projection names registered in tools.ts.
// Custom views MUST NOT collide with these names.

export const BUILTIN_VIEW_NAMES: ReadonlySet<string> = new Set([
  // Action names from exarchos_view (registry.ts viewActions)
  'pipeline',
  'tasks',
  'workflow_status',
  'stack_status',
  'stack_place',
  'telemetry',
  'team_performance',
  'delegation_timeline',
  'code_quality',
  'quality_hints',
  'eval_results',
  'quality_correlation',
  'quality_attribution',
  'session_provenance',
  'delegation_readiness',
  'synthesis_readiness',
  'shepherd_status',
  'provenance',
  'ideate_readiness',
  'convergence',
  // Internal projection names registered in tools.ts createMaterializer()
  'workflow-status',
  'task-detail',
  'pipeline',
  'stack',
  'telemetry',
  'team-performance',
  'delegation-timeline',
  'code-quality',
  'eval-results',
  'workflow-state',
  'delegation-readiness',
  'ideate-readiness',
  'synthesis-readiness',
  'shepherd-status',
  'provenance',
  'convergence',
  'unified-task',
]);

// ─── View Registry ──────────────────────────────────────────────────────────

/**
 * Higher-level registry wrapping ViewMaterializer that tracks built-in vs
 * custom views and prevents name collisions.
 */
export class ViewRegistry {
  private readonly customViews = new Set<string>();
  private readonly materializer: ViewMaterializer;

  constructor(materializer?: ViewMaterializer) {
    this.materializer = materializer ?? new ViewMaterializer();
  }

  /**
   * Register a custom view projection. Throws if the name collides with a
   * built-in view or an already-registered custom view.
   */
  registerCustomView<T>(name: string, projection: ViewProjection<T>): void {
    if (BUILTIN_VIEW_NAMES.has(name)) {
      throw new Error(
        `Cannot register custom view "${name}": collides with built-in view name`,
      );
    }
    if (this.customViews.has(name)) {
      throw new Error(
        `Cannot register custom view "${name}": already registered as a custom view`,
      );
    }
    this.materializer.register(name, projection);
    this.customViews.add(name);
  }

  /**
   * Unregister a custom view. Throws if the name is a built-in view or
   * not registered as a custom view.
   */
  unregisterCustomView(name: string): void {
    if (BUILTIN_VIEW_NAMES.has(name)) {
      throw new Error(
        `Cannot unregister built-in view "${name}"`,
      );
    }
    if (!this.customViews.has(name)) {
      throw new Error(
        `Cannot unregister view "${name}": not registered as a custom view`,
      );
    }
    this.customViews.delete(name);
    this.materializer.unregister(name);
  }

  /**
   * Check if a view name is registered as a custom view.
   */
  isCustomView(name: string): boolean {
    return this.customViews.has(name);
  }

  /**
   * Get all custom view names.
   */
  getCustomViewNames(): readonly string[] {
    return [...this.customViews];
  }

  /**
   * Get the underlying materializer for event materialization.
   */
  getMaterializer(): ViewMaterializer {
    return this.materializer;
  }
}
