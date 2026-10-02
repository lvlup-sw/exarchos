import { z } from 'zod';
import {
  ActionContractError,
  normalizeActionContract,
  type ActionContract,
} from './action-contract.js';

export type ActionAnnotations = {
  readonly safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
};

/**
 * The annotation schema. `superRefine` rejects a flag tuple that contradicts its `safety` class.
 * For example, `safety: 'read-only'` with `readOnly: false` lets a writer past the capability
 * boundary. The schema does not check `idempotent`, because it varies per handler. It requires
 * `openWorld: true` only for `remote-mutation`.
 */
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
 * The admission path that calls `validateAction`. `load` is the built-in module-load loop and
 * `registration` is custom and extension tools. Both require a complete `actionContract` block.
 */
export type ActionRegistrationMode = 'load' | 'registration';

function readActionContract(action: object): unknown {
  if (!('actionContract' in action)) {
    return undefined;
  }
  return Reflect.get(action, 'actionContract');
}

function replayAnnotationsOf(annotations: unknown): { readonly idempotent: boolean } | undefined {
  if (typeof annotations !== 'object' || annotations === null) return undefined;
  const idempotent: unknown = Reflect.get(annotations, 'idempotent');
  return typeof idempotent === 'boolean' ? { idempotent } : undefined;
}

/**
 * The admission gate for the action-contract block. Built-in and extension registration share it.
 * A missing block fails. A present block must normalize, which includes its replay check against
 * `annotations.idempotent`.
 */
export function admitActionContract(
  action: { name: string; annotations?: unknown; actionContract?: unknown },
  toolName: string,
): ActionContract {
  const id = `${toolName}.${action.name}`;
  const contract = readActionContract(action);
  if (contract === undefined) {
    throw new ActionContractError(
      'MISSING_DIMENSION',
      `Action '${id}' is missing required actionContract`,
    );
  }
  const annotations = replayAnnotationsOf(action.annotations);
  try {
    return normalizeActionContract(
      contract,
      annotations === undefined ? {} : { annotations },
    );
  } catch (error) {
    if (error instanceof ActionContractError) {
      throw new ActionContractError(
        error.code,
        `Action '${id}' has invalid actionContract: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * The registration-time check of one action. The action must declare a Zod `outputSchema`, valid
 * `annotations`, and an `actionContract` block. The module-load loop in `tools.ts` calls it, so a
 * malformed built-in action fails the import. The error names the `<tool>.<action>` id. The
 * annotations get a full schema check, not only a presence check.
 */
export function validateAction(
  action: { name: string; outputSchema?: z.ZodType; annotations?: unknown },
  toolName: string,
  _mode: ActionRegistrationMode = 'load',
): void {
  const id = `${toolName}.${action.name}`;
  if (action.outputSchema === undefined) {
    throw new Error(`Action '${id}' is missing required outputSchema`);
  }
  if (typeof Reflect.get(action.outputSchema, 'parse') !== 'function') {
    throw new Error(`Action '${id}' outputSchema is not a Zod schema`);
  }
  validateAnnotations(action.annotations, id);
  admitActionContract(action, toolName);
}

/**
 * The annotation presets, one for each recurring action shape. An action author picks the kind of
 * action, and the flag tuple follows from the preset. Only actions that are safe to run again get
 * `idempotent: true`. A state writer gets `false`, because each run appends a new event.
 */
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

/**
 * A local mutation that writes a file outside the managed `.exarchos/` store, such as the `export`
 * diagnostic bundle, so `openWorld` is true. It is not destructive. It is not idempotent, because
 * each run appends a new requested and executed event pair.
 */
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

/**
 * The correlation-tuple filter shape that view actions with dispatch-boundary scoping spread into
 * their schemas. One copy keeps the call sites in agreement.
 */
export const CORRELATION_TUPLE_FILTER_SHAPE = {
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
} as const;
