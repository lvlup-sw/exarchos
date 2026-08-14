import { z } from 'zod';

export type ActionAnnotations = {
  readonly safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
};

// Mapping rules (mirror the §"Shared Annotation Presets" comment block
// below). `superRefine` rejects contradictory tuples — e.g. an action
// that claims `safety: 'read-only'` but flips `readOnly: false` would
// otherwise pass the shape-only check yet smuggle a writer past the
// capability boundary (CodeRabbit MAJOR on PR #1369; also the same
// mis-annotation class behind the doctor / check_convergence Sentry
// HIGH).
//
// `idempotent` is not asserted because the comment block explicitly
// notes that idempotency varies per handler within the local-mutation
// family. `openWorld` is asserted only where the safety enum implies
// it (remote-mutation must be openWorld:true; other classes leave it
// free because compensable splits local/remote).
export const ActionAnnotationsSchema = z.object({
  safety: z.enum(['read-only', 'local-mutation', 'remote-mutation', 'compensable']),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  openWorld: z.boolean(),
}).strict().superRefine((a, ctx) => {
  switch (a.safety) {
    case 'read-only':
      if (!a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'read-only' requires readOnly: true",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'read-only' requires destructive: false",
        });
      }
      break;
    case 'local-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'local-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'local-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      break;
    case 'remote-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'remote-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'remote-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      if (!a.openWorld) {
        ctx.addIssue({
          code: 'custom',
          path: ['openWorld'],
          message: "safety 'remote-mutation' requires openWorld: true",
        });
      }
      break;
    case 'compensable':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'compensable' requires readOnly: false",
        });
      }
      if (!a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'compensable' requires destructive: true",
        });
      }
      break;
  }
});

export function validateAnnotations(a: unknown, actionName: string): asserts a is ActionAnnotations {
  const result = ActionAnnotationsSchema.safeParse(a);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Action '${actionName}' has invalid annotations: ${issues}`);
  }
}

/**
 * Registration-time invariant check (Wave 0 task C.3, design §2.1 + §2.4,
 * issues #1287 + #1289).
 *
 * Every action MUST declare both `outputSchema` (a Zod schema for the
 * response envelope) and `annotations` (a typed ActionAnnotations record).
 * Called from the module-load loop at the bottom of this file so any
 * malformed action fails the import — DIM-3 contracts fail closed at
 * startup rather than at first call. The thrown error always surfaces
 * the fully-qualified `${toolName}.${action.name}` identifier so the
 * operator can navigate from a failed import directly to the offender.
 */
export function validateAction(
  action: { name: string; outputSchema?: z.ZodType; annotations?: unknown },
  toolName: string,
): void {
  const id = `${toolName}.${action.name}`;
  if (action.outputSchema === undefined) {
    throw new Error(`Action '${id}' is missing required outputSchema`);
  }
  if (typeof (action.outputSchema as { parse?: unknown }).parse !== 'function') {
    throw new Error(`Action '${id}' outputSchema is not a Zod schema`);
  }
  // ActionAnnotationsSchema is re-validated here (not just a presence
  // check) so a hand-edited field set that drifts from the schema fails
  // at the same boundary as a missing declaration.
  validateAnnotations(action.annotations, id);
}

// ─── Shared Annotation Presets (Wave 0 E.1-E.5, design §2.4) ────────
//
// Each preset codifies the (safety, readOnly, destructive, idempotent,
// openWorld) tuple for one of the recurring action shapes in the
// registry. Co-locating them removes drift risk across 90+ declaration
// sites and makes per-action annotations a single keyword in the array
// literal — the *kind* of action is the only thing the author has to
// classify; the flag tuple follows from the preset.
//
// Mapping rules (DIM-3 safety boundary, applied uniformly):
// - read-only            → readOnly:true,  destructive:false, idempotent:true,  openWorld:false
// - read-only + external → readOnly:true,  destructive:false, idempotent:true,  openWorld:true
// - local-mutation       → readOnly:false, destructive:false, idempotent:false, openWorld:false
// - local-mutation idem. → readOnly:false, destructive:false, idempotent:true,  openWorld:false
// - compensable (local)  → readOnly:false, destructive:true,  idempotent:false, openWorld:false
// - compensable (remote) → readOnly:false, destructive:true,  idempotent:false, openWorld:true
// - remote-mutation      → readOnly:false, destructive:false, idempotent:false, openWorld:true
//
// `idempotent: true` is asserted only for actions whose handler is
// documented or empirically safe to re-run (reconcile, rehydrate,
// checkpoint, sync, plus all pure reads). Default for state-writers is
// false because re-running yields a new event in the stream.

export const READ_ONLY_LOCAL: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

export const READ_ONLY_REMOTE: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: true,
};

export const LOCAL_MUTATION: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

export const LOCAL_MUTATION_IDEMPOTENT: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

// DR-6 (lifecycle-verbs) — a local-mutation whose side effect is a FILE written
// OUTSIDE the managed `.exarchos/` store (the `export` diagnostic zip bundle),
// so `openWorld` is true. Non-destructive (a diagnostic write, not a workflow
// mutation) and NOT idempotent at the event level (a fresh invocation mints a
// new INV-13 pair). `local-mutation` leaves `openWorld` free (the annotation
// schema only pins it for `remote-mutation`), so this tuple is valid.
export const LOCAL_MUTATION_OPEN_WORLD: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
};

export const COMPENSABLE_LOCAL: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
};

export const COMPENSABLE_REMOTE: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
};

export const REMOTE_MUTATION: ActionAnnotations = {
  safety: 'remote-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
};

// Wave 5 (#1437) — shared correlation-tuple filter shape spliced into every
// view action that supports dispatch-boundary scoping. Keeping it in one
// place prevents the six call sites from drifting if a field is added,
// renamed, or constrained.
export const CORRELATION_TUPLE_FILTER_SHAPE = {
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
} as const;
