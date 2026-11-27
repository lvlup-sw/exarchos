// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — pinned PR admission is staged until synthesis cutover.
/** Judge a single exact PR observation against captured repository and template authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractSectionsFromTemplateText, validateSections } from '../../vcs/pr-observation.js';
import type { GithubPrRecord } from '../../vcs/github-pr-observer.js';

const repo = z.object({
  id: z.number().int().positive(),
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..')),
  apiUrl: z.string().url()
}).strict();
const subject = z.object({
  number: z.number().int().positive(),
  id: z.number().int().positive(),
  apiUrl: z.string().url(),
  source: repo,
  destination: repo,
  headRef: z.string().regex(/^refs\/heads\/.+/),
  baseRef: z.string().regex(/^refs\/heads\/.+/),
  headCommit: z.string().regex(/^[a-f0-9]{40}$/),
  template: z.object({
    policy: z.literal('heading-presence-v1'),
    repositoryId: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1),
    text: z.string().max(65536),
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
}).strict();

/** Canonical API repository locators contain no credentials, query, fragment or normalized path aliases. */
function canonicalRepository(value: z.infer<typeof repo>): boolean {
  const url = new URL(value.apiUrl);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.href === value.apiUrl && [ `/repos/${value.fullName}`, `/api/v3/repos/${value.fullName}` ].includes(url.pathname);
}

/** No author, queue, mutable file or current-configuration fallback can bypass pinned headings. */
export function judgePrObservation(expected: z.infer<typeof subject>, observed: { record: GithubPrRecord; observedAt: string }):
  | { kind: 'accepted'; subject: z.infer<typeof subject>; observedAt: string; body: string; bodyDigest: string; templateDigest: string }
  | { kind: 'refused'; reason: string } {
  try {
    const pin = subject.parse(expected);
    const pr = observed.record;
    if (!canonicalRepository(pin.source) || !canonicalRepository(pin.destination)
      || pin.source.apiUrl.split('/repos/')[0] !== pin.destination.apiUrl.split('/repos/')[0]
      || pin.apiUrl !== `${pin.destination.apiUrl}/pulls/${pin.number}`) throw new Error('Noncanonical provider locator');
    const sameRepo = (actual: GithubPrRecord['base']['repo'], required: z.infer<typeof repo>) => actual.id === required.id && actual.full_name === required.fullName && actual.url === required.apiUrl;
    if (pr.id !== pin.id || pr.number !== pin.number || pr.url !== pin.apiUrl || pr.state !== 'open' || pr.merged
      || !sameRepo(pr.base.repo, pin.destination) || !sameRepo(pr.head.repo, pin.source)
      || `refs/heads/${pr.base.ref}` !== pin.baseRef || `refs/heads/${pr.head.ref}` !== pin.headRef || pr.head.sha !== pin.headCommit) throw new Error('PR identity, open state or immutable coordinates differ');
    if (pin.template.repositoryId !== pin.destination.id || Buffer.byteLength(pin.template.text) > 65536
      || createHash('sha256').update(pin.template.text).digest('hex') !== pin.template.digest) throw new Error('Pinned template identity or bytes differ');
    const sections = extractSectionsFromTemplateText(pin.template.text);
    if (sections.length === 0 || sections.some(section => section.length === 0) || !validateSections(pr.body, sections).passed) throw new Error('PR body lacks pinned template headings');
    if (Buffer.byteLength(pr.body) > 256 * 1024 || !Number.isFinite(Date.parse(observed.observedAt))) throw new Error('Invalid observation bounds');
    return { kind: 'accepted',
      subject: pin,
      observedAt: observed.observedAt,
      body: pr.body,
      bodyDigest: createHash('sha256').update(pr.body).digest('hex'),
      templateDigest: pin.template.digest };
  } catch { return { kind: 'refused', reason: 'PR observation does not satisfy the captured subject and template policy' }; }
}
