import { describe, it, expect, vi } from 'vitest';
import {
  deliver,
  DeliveryError,
  RequiredDeliveryError,
  isFailedDelivery,
  skipped,
  delivered,
  type DeliveryRequest,
} from '../../../../src/adapters/channel/delivery.js';

function request<P>(over: Partial<DeliveryRequest<P>> & { payload: P }): DeliveryRequest<P> {
  return {
    channel: 'test-channel',
    requirement: 'best-effort',
    transport: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('deliver — success', () => {
  it('returns a delivered outcome and calls the transport with the payload', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const outcome = await deliver(request({ payload: { n: 1 }, transport }));
    expect(transport).toHaveBeenCalledWith({ n: 1 });
    expect(outcome.kind).toBe('delivered');
  });
});

describe('deliver — best-effort failure (observable, not swallowed)', () => {
  it('captures the transport failure into a typed failed carrier', async () => {
    const cause = new Error('not connected');
    const transport = vi.fn().mockRejectedValue(cause);
    const outcome = await deliver(
      request({ payload: 1, requirement: 'best-effort', transport }),
    );

    // The failure is a VALUE the caller can inspect — not lost to a catch {}.
    expect(isFailedDelivery(outcome)).toBe(true);
    if (isFailedDelivery(outcome)) {
      expect(outcome.error).toBeInstanceOf(DeliveryError);
      expect(outcome.error.requirement).toBe('best-effort');
      expect(outcome.error.cause).toBe(cause);
    }
  });

  it('does not throw for a best-effort failure', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('down'));
    await expect(
      deliver(request({ payload: 1, requirement: 'best-effort', transport })),
    ).resolves.toMatchObject({ kind: 'failed' });
  });
});

describe('deliver — required failure (typed error propagates)', () => {
  it('throws a RequiredDeliveryError carrying the channel and cause', async () => {
    const cause = new Error('sink unavailable');
    const transport = vi.fn().mockRejectedValue(cause);

    await expect(
      deliver(request({ payload: 1, channel: 'audit-log', requirement: 'required', transport })),
    ).rejects.toBeInstanceOf(RequiredDeliveryError);

    // And it is not silently turned into a delivered/failed outcome.
    const caught = await deliver(
      request({ payload: 1, channel: 'audit-log', requirement: 'required', transport }),
    ).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RequiredDeliveryError);
    if (caught instanceof RequiredDeliveryError) {
      expect(caught.channel).toBe('audit-log');
      expect(caught.cause).toBe(cause);
      expect(caught.requirement).toBe('required');
    }
  });

  it('a required delivery that succeeds still resolves to delivered', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const outcome = await deliver(
      request({ payload: 1, requirement: 'required', transport }),
    );
    expect(outcome.kind).toBe('delivered');
  });
});

describe('outcome constructors', () => {
  it('delivered/skipped build the expected arms', () => {
    expect(delivered('c')).toEqual({ kind: 'delivered', channel: 'c' });
    expect(skipped('c', 'below-threshold')).toEqual({
      kind: 'skipped',
      channel: 'c',
      reason: 'below-threshold',
    });
  });
});
