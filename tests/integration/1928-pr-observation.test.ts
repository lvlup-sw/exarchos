// @oracle-sources: exact deterministic GitHub wire records, captured repository PR template bytes and independent request/identity assertions
/** Exercise the real GET adapter and shared body policy without any provider network request. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubPrObserver } from '../../src/vcs/github-pr-observer.js';
import { judgePrObservation } from '../../src/verbs/settle/pr-observation.js';
import { extractSectionsFromTemplateText, validateSections } from '../../src/vcs/pr-observation.js';
import { handleValidatePrBody } from '../../src/verbs/vcs/validate-pr-body.js';

const template = readFileSync(new URL('../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
const headings = ['Background', 'Design Decisions', 'Changes', 'Verification Performed', 'Post-Merge Operations'];
const body = headings.map(heading => `## ${heading}\n\nRecorded evidence.\n`).join('\n');
const api = 'https://api.github.com';
const destination = { id: 11, fullName: 'approved/repository', apiUrl: `${api}/repos/approved/repository` };
const source = { id: 22, fullName: 'approved-fork/repository', apiUrl: `${api}/repos/approved-fork/repository` };
const sha = 'a'.repeat(40);
const pin = {
  number: 42, id: 123, apiUrl: `${destination.apiUrl}/pulls/42`, source, destination,
  headRef: 'refs/heads/integration', baseRef: 'refs/heads/main', headCommit: sha,
  template: { policy: 'heading-presence-v1', repositoryId: 11, sourceCommit: 'b'.repeat(40), path: '.github/PULL_REQUEST_TEMPLATE.md', text: template, digest: createHash('sha256').update(template).digest('hex') },
} satisfies Parameters<typeof judgePrObservation>[0];
const trusted = { apiEndpoint: api, token: 'operator-secret', repository: { id: 11, fullName: 'approved/repository' } };

/** Provider-shaped data has distinct fork and destination identities, not merely matching branch names. */
function record() {
  return { id: 123, number: 42, url: pin.apiUrl, state: 'open', merged: false, body,
    user: { login: 'dependabot[bot]' },
    head: { ref: 'integration', sha, repo: { id: source.id, full_name: source.fullName, url: source.apiUrl } },
    base: { ref: 'main', repo: { id: destination.id, full_name: destination.fullName, url: destination.apiUrl } } };
}

/** The injected wire only supplies bytes while the production adapter constructs and validates the request. */
async function observe(value: unknown) {
  const wire = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
  const result = await createGithubPrObserver(trusted, wire)({ number: 42, id: 123 });
  expect(wire).toHaveBeenCalledTimes(1);
  return result;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('exact staged PR observation', () => {
  it('OneApprovedGET_BindsExactRecordAndFiveHeadingTemplate', async () => {
    expect(extractSectionsFromTemplateText(template)).toEqual(headings);
    const wire = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(record())));
    const observation = await createGithubPrObserver(trusted, wire)({ number: 42, id: 123 });
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(pin.apiUrl, expect.objectContaining({ method: 'GET', redirect: 'manual', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer operator-secret', 'X-GitHub-Api-Version': '2022-11-28' } }));
    if (observation.kind !== 'observed') throw new Error(observation.reason);
    expect(judgePrObservation(pin, observation)).toMatchObject({ kind: 'accepted', body, bodyDigest: createHash('sha256').update(body).digest('hex'), templateDigest: pin.template.digest });
    expect(JSON.stringify(observation)).not.toContain(trusted.token);
  });

  it('WrongOwnerHeadRefsStateAndMalformedIdentity_Refuse', async () => {
    const variants: readonly { name: string; change: (value: ReturnType<typeof record>) => void }[] = [
      { name: 'source-owner', change: value => { value.head.repo.full_name = 'imposter/repository'; } },
      { name: 'source-id', change: value => { value.head.repo.id = 99; } },
      { name: 'source-url', change: value => { value.head.repo.url = 'https://foreign.invalid/repos/approved-fork/repository'; } },
      { name: 'destination-owner', change: value => { value.base.repo.full_name = 'imposter/repository'; } },
      { name: 'destination-id', change: value => { value.base.repo.id = 99; } },
      { name: 'destination-url', change: value => { value.base.repo.url = 'https://foreign.invalid/repos/approved/repository'; } },
      { name: 'head', change: value => { value.head.sha = 'c'.repeat(40); } },
      { name: 'head-ref', change: value => { value.head.ref = 'other'; } },
      { name: 'base-ref', change: value => { value.base.ref = 'other'; } },
      { name: 'closed', change: value => { value.state = 'closed'; } },
      { name: 'merged', change: value => { value.merged = true; } },
      { name: 'id', change: value => { value.id = 124; } },
      { name: 'number', change: value => { value.number = 43; } },
      { name: 'url', change: value => { value.url = 'https://foreign.invalid/pulls/42'; } },
      { name: 'deleted-source', change: value => { Reflect.set(value.head, 'repo', null); } },
      { name: 'null-body', change: value => { Reflect.set(value, 'body', null); } },
    ];
    for (const { name: mode, change } of variants) {
      const value = record();
      change(value);
      const result = await observe(value);
      if (result.kind === 'observed') expect(judgePrObservation(pin, result).kind, mode).toBe('refused');
      else expect(result.kind, mode).toBe('refused');
    }
  });

  it('CapturedTemplate_NoDefaultBotOrQueueBypass', async () => {
    const value = record();
    value.body = '## Summary\n\n## Changes\n\n## Test Plan\n';
    value.head.ref = 'gh-readonly-queue/main';
    const result = await observe(value);
    if (result.kind !== 'observed') throw new Error(result.reason);
    expect(judgePrObservation({ ...pin, headRef: 'refs/heads/gh-readonly-queue/main' }, result).kind).toBe('refused');
    const good = await observe(record());
    if (good.kind !== 'observed') throw new Error(good.reason);
    for (const change of [ { digest: '0'.repeat(64) }, { text: '' }, { repositoryId: 999 }, { text: '##   ', digest: createHash('sha256').update('##   ').digest('hex') }, { text: 'No headings', digest: createHash('sha256').update('No headings').digest('hex') } ]) {
      expect(judgePrObservation({ ...pin, template: { ...pin.template, ...change } }, good).kind).toBe('refused');
    }
    expect(judgePrObservation(pin, good).kind).toBe('accepted');
  });

  it('RedirectCredentialAndBoundedResponse_RefuseWithoutSecondFetch', async () => {
    const invalidUtf8 = Buffer.from(JSON.stringify(record()));
    invalidUtf8[invalidUtf8.indexOf('Recorded')] = 255;
    const redirected = new Response(JSON.stringify(record()));
    Object.defineProperty(redirected, 'redirected', { value: true });
    const wrongUrl = new Response(JSON.stringify(record()));
    Object.defineProperty(wrongUrl, 'url', { value: 'https://foreign.invalid/pulls/42' });
    for (const response of [redirected, wrongUrl, new Response('', { status: 302, headers: { Location: 'https://foreign.invalid/steal' } }), new Response('', { status: 307, headers: { Location: pin.apiUrl } }), new Response('', { status: 401 }), new Response('', { status: 404 }), new Response('not json'), new Response(invalidUtf8), new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new Response('x'.repeat(1024 * 1024 + 1)), new Response(JSON.stringify({ ...record(), body: 'x'.repeat(256 * 1024 + 1) }))]) {
      const wire = vi.fn<typeof fetch>().mockResolvedValue(response);
      const result = await createGithubPrObserver(trusted, wire)({ number: 42, id: 123 });
      expect(result.kind).toBe('refused');
      expect(wire).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(trusted.token);
    }
    const wire = vi.fn<typeof fetch>().mockRejectedValue(new Error(trusted.token));
    expect(await createGithubPrObserver(trusted, wire)({ number: 42, id: 123 })).toMatchObject({ kind: 'refused' });
    expect(wire).toHaveBeenCalledTimes(1);
    for (const apiEndpoint of ['http://api.github.com', 'https://user:password@api.github.com', `${api}/repos/untrusted`, `${api}?token=bad`]) expect(() => createGithubPrObserver({ ...trusted, apiEndpoint }, wire)).toThrow();
    for (const fullName of ['../repository', 'approved/..', './repository']) expect(() => createGithubPrObserver({ ...trusted, repository: { id: 11, fullName } }, wire)).toThrow();
    const request = { number: 42, id: 123, token: 'caller-credential' };
    const count = wire.mock.calls.length;
    expect((await createGithubPrObserver(trusted, wire)(request)).kind).toBe('refused');
    expect(wire).toHaveBeenCalledTimes(count);
  });

  it('SlowHeadersAndBody_AbortWithinFixedBound', async () => {
    vi.useFakeTimers();
    for (const slowBody of [false, true]) {
      const wire = vi.fn<typeof fetch>().mockImplementation(async () => slowBody ? new Response(new ReadableStream({ start() {} })) : new Promise<Response>(() => {}));
      const pending = createGithubPrObserver(trusted, wire)({ number: 42, id: 123 });
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).kind).toBe('refused');
      expect(wire).toHaveBeenCalledTimes(1);
      expect(wire.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
    const canceled = vi.fn();
    const lateWire = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 6000));
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(JSON.stringify(record()))); },
        cancel: canceled,
      }));
    });
    const late = createGithubPrObserver(trusted, lateWire)({ number: 42, id: 123 });
    await vi.advanceTimersByTimeAsync(5001);
    expect((await late).kind).toBe('refused');
    await vi.advanceTimersByTimeAsync(1000);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(lateWire).toHaveBeenCalledTimes(1);
  });

  it('SharedPurePolicy_PreservesLegacyDefaultAndCaseSemantics', async () => {
    expect(validateSections('## summary\n## CHANGES\n## Test Plan', ['Summary', 'Changes', 'Test Plan']).passed).toBe(true);
    expect(await handleValidatePrBody({ body: '## Summary\n## Changes\n## Test Plan' })).toMatchObject({ success: true, data: { passed: true } });
    expect(await handleValidatePrBody({ body: 'missing' })).toMatchObject({ success: true, data: { passed: false } });
    expect(await handleValidatePrBody({ body: 'missing', enforce: true })).toMatchObject({ success: false });
  });
});
