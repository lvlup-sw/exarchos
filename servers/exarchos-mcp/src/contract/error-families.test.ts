import { describe, it, expect } from 'vitest';
import {
  FAILURE_LAYERS,
  FAMILY_DEFAULTS,
  CONTRACT_EXIT_CODES,
  STABLE_ERROR_REGISTRY,
  failureFamily,
  layerSeverity,
  contractError,
  exitCodeForError,
  toErrorEnvelope,
  stableErrorCodes,
  layerCodes,
  assertNever,
  type FailureLayer,
} from './error-families.js';
import { CLI_EXIT_CODES, ERROR_CODE_EXIT_CODES } from '../adapters/cli/cli.js';

describe('error-families — six-layer exit proof', () => {
  // The CORE exit proof (P03-02 exit-proof): every one of the six failure
  // origins maps to the expected stable contract error code AND stable CLI
  // exit code. One row per layer.
  const CASES: ReadonlyArray<{
    layer: FailureLayer;
    code: string;
    exitCode: number;
  }> = [
    { layer: 'protocol', code: 'PROTOCOL_ERROR', exitCode: 1 },
    { layer: 'authorization', code: 'AUTHORIZATION_DENIED', exitCode: 2 },
    { layer: 'task', code: 'TASK_FAILED', exitCode: 2 },
    { layer: 'handler', code: 'HANDLER_ERROR', exitCode: 2 },
    { layer: 'output', code: 'OUTPUT_CONTRACT_VIOLATION', exitCode: 2 },
    { layer: 'presenter', code: 'PRESENTER_ERROR', exitCode: 3 },
  ];

  for (const { layer, code, exitCode } of CASES) {
    it(`Layer_${layer}_MapsToStableCodeAndExit`, () => {
      const err = contractError(layer, `seeded ${layer} failure`);
      expect(err.code).toBe(code);
      expect(err.exitCode).toBe(exitCode);
      // The exit code is also recoverable from the code alone (the CLI path).
      expect(exitCodeForError(err.code)).toBe(exitCode);
      // The family lookup agrees with the constructed error — pins BOTH the
      // family-default descriptor AND the stable-registry entry, so breaking
      // either source reddens this row.
      expect(failureFamily(layer).code).toBe(code);
      expect(failureFamily(layer).exitCode).toBe(exitCode);
      expect(STABLE_ERROR_REGISTRY[code as keyof typeof STABLE_ERROR_REGISTRY].exitCode).toBe(
        exitCode,
      );
    });
  }

  it('EverySeededLayerFailureMapsExactlyOnce', () => {
    // Totality at the value level: each of the six layers produces a distinct,
    // registered code — no layer falls through to a shared generic bucket.
    const codes = FAILURE_LAYERS.map((l) => contractError(l, 'x').code);
    expect(new Set(codes).size).toBe(FAILURE_LAYERS.length);
    for (const code of codes) {
      expect(code in STABLE_ERROR_REGISTRY).toBe(true);
    }
  });
});

describe('error-families — totality / exhaustiveness', () => {
  it('FamilyDefaults_CoverExactlyTheSixLayers', () => {
    expect(Object.keys(FAMILY_DEFAULTS).sort()).toEqual([...FAILURE_LAYERS].sort());
  });

  it('EveryFamilyIsRepresentedInTheStableRegistry', () => {
    for (const layer of FAILURE_LAYERS) {
      expect(layerCodes(layer).length).toBeGreaterThan(0);
    }
  });

  it('EveryRegisteredCodeHasAKnownLayerAndExitCode', () => {
    const validExits = new Set<number>(Object.values(CONTRACT_EXIT_CODES));
    const validLayers = new Set<string>(FAILURE_LAYERS);
    for (const code of stableErrorCodes()) {
      const spec = STABLE_ERROR_REGISTRY[code];
      expect(validLayers.has(spec.layer)).toBe(true);
      expect(validExits.has(spec.exitCode)).toBe(true);
    }
  });

  it('LayerSeverity_IsTotalOverTheFamilyUnion', () => {
    // Exercises the `never`-guarded switch for all six members.
    for (const layer of FAILURE_LAYERS) {
      expect(['client', 'server']).toContain(layerSeverity(layer));
    }
  });

  it('AssertNever_ThrowsOnAnUnsoundCast', () => {
    // Belt to the compile-time braces: if control ever reaches the guard via
    // an unsound cast (a value outside the union), it fails loud.
    expect(() => assertNever('not-a-layer' as never, 'FailureLayer')).toThrow(
      /Non-exhaustive FailureLayer/,
    );
  });
});

describe('error-families — CLI exit-code parity (contract is the authority)', () => {
  it('ContractExitCodes_MatchTheCliSpine', () => {
    expect(CONTRACT_EXIT_CODES.SUCCESS).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(CONTRACT_EXIT_CODES.INVALID_INPUT).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(CONTRACT_EXIT_CODES.HANDLER_ERROR).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
    expect(CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);
  });

  it('ContractExitCodes_MatchTheCliWaitBand', () => {
    expect(CONTRACT_EXIT_CODES.WAIT_TIMEOUT).toBe(ERROR_CODE_EXIT_CODES.WAIT_TIMEOUT);
    expect(CONTRACT_EXIT_CODES.WAIT_FAILED).toBe(ERROR_CODE_EXIT_CODES.WAIT_FAILED);
  });

  it('WaitCodes_KeepTheirSpecialisedExitWithinTheTaskFamily', () => {
    expect(STABLE_ERROR_REGISTRY.WAIT_TIMEOUT.layer).toBe('task');
    expect(STABLE_ERROR_REGISTRY.WAIT_FAILED.layer).toBe('task');
    expect(exitCodeForError('WAIT_TIMEOUT')).toBe(17);
    expect(exitCodeForError('WAIT_FAILED')).toBe(18);
  });
});

describe('error-families — contract error carrier', () => {
  it('ContractError_UsesExplicitCodeSpecOverFamilyDefault', () => {
    const err = contractError('authorization', 'nope', { code: 'CAPABILITY_DENIED' });
    expect(err.code).toBe('CAPABILITY_DENIED');
    expect(err.layer).toBe('authorization');
    expect(err.exitCode).toBe(2);
    expect(err.retry).toBe('none');
  });

  it('ContractError_CarriesStructuredDetail', () => {
    const err = contractError('protocol', 'bad', {
      code: 'INVALID_INPUT',
      detail: { validTargets: ['a', 'b'] },
    });
    expect(err.detail).toEqual({ validTargets: ['a', 'b'] });
  });

  it('ContractError_OmitsDetailWhenAbsent', () => {
    const err = contractError('handler', 'boom');
    expect('detail' in err).toBe(false);
  });

  it('ToErrorEnvelope_ProducesTheCanonicalFailureShape', () => {
    const err = contractError('handler', 'boom', {
      code: 'CONCURRENCY_CONFLICT',
      detail: { streamId: 's-1', expectedVersion: 3 },
    });
    const env = toErrorEnvelope(err);
    expect(env.success).toBe(false);
    expect(env.error.code).toBe('CONCURRENCY_CONFLICT');
    expect(env.error.message).toBe('boom');
    expect(env.error.streamId).toBe('s-1');
    expect(env.error.expectedVersion).toBe(3);
  });

  it('ExitCodeForError_FallsBackToHandlerErrorForUnknownCodes', () => {
    expect(exitCodeForError('SOME_UNREGISTERED_CODE')).toBe(2);
    expect(exitCodeForError(undefined)).toBe(0);
  });

  it('ConcurrencyAndStorage_KeepTheirRetryPolicies', () => {
    expect(contractError('handler', 'x', { code: 'CONCURRENCY_CONFLICT' }).retry).toBe(
      'after-refetch',
    );
    expect(contractError('handler', 'x', { code: 'STORAGE_BUSY' }).retry).toBe('after-backoff');
  });
});
