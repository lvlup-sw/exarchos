// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — exact GET observation staged for later admission.
/** Operator-provisioned GitHub reads expose no general HTTP or credential-selection interface. */
import { z } from 'zod';

const repository = z.object({
  id: z.number().int().positive(),
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'))
}).strict();
const provisioning = z.object({
  apiEndpoint: z.string().url(),
  token: z.string().min(1).max(4096),
  repository
}).strict();
const selection = z.object({
  number: z.number().int().positive(),
  id: z.number().int().positive()
}).strict();
const wireRepository = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  url: z.string()
});
const record = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  body: z.string(),
  head: z.object({ ref: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/), repo: wireRepository }),
  base: z.object({ ref: z.string(), repo: wireRepository }),
});

/** Exact provider identity and body returned by the single bounded GET. */
export type GithubPrRecord = z.infer<typeof record>;

/** Construct the trusted transport once, separately from later PR selection. */
export function createGithubPrObserver(input: z.infer<typeof provisioning>, wire: typeof fetch = fetch) {
  const trusted = provisioning.parse(input);
  const endpoint = new URL(trusted.apiEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['/', '/api/v3', '/api/v3/'].includes(endpoint.pathname)) throw new Error('Unsupported approved GitHub API endpoint');
  const api = endpoint.href.replace(/\/$/, '');
  const repoUrl = `${api}/repos/${trusted.repository.fullName}`;

  return async (requested: z.infer<typeof selection>): Promise<{ kind: 'observed'; record: GithubPrRecord; observedAt: string } | { kind: 'refused'; reason: string }> => {
    let cancel: (() => void) | undefined;
    const controller = new AbortController();
    const cancelBody = () => {
      const current = cancel;
      cancel = undefined;
      current?.();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const selected = selection.parse(requested);
      const url = `${repoUrl}/pulls/${selected.number}`;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancelBody();
          reject(new Error('timeout'));
        }, 5000);
      });
      const read = async () => {
        const response = await wire(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${trusted.token}`,
            'X-GitHub-Api-Version': '2022-11-28'
          }
        });
        cancel = () => { void response.body?.cancel().catch(() => {}); };
        if (controller.signal.aborted) {
          cancelBody();
          throw new Error('observation expired');
        }
        if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) throw new Error('provider refusal');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024 * 1024)) throw new Error('response too large');
        if (response.body === null) throw new Error('missing body');
        const reader = response.body.getReader();
        cancel = () => { void reader.cancel().catch(() => {}); };
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 1024 * 1024) throw new Error('response too large');
            chunks.push(chunk.value);
          }
        } finally {
          cancelBody();
        }
        const value = record.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        if (value.id !== selected.id || value.number !== selected.number || value.url !== url
          || value.base.repo.id !== trusted.repository.id || value.base.repo.full_name !== trusted.repository.fullName || value.base.repo.url !== repoUrl
          || Buffer.byteLength(value.body, 'utf8') > 256 * 1024) throw new Error('provider identity or body differs');
        if (controller.signal.aborted) throw new Error('observation expired');
        const result: { kind: 'observed'; record: GithubPrRecord; observedAt: string } = { kind: 'observed',
          record: value,
          observedAt: new Date().toISOString()
        };
        return result;
      };
      return await Promise.race([read(), timeout]);
    } catch {
      return { kind: 'refused',
        reason: 'GitHub PR observation unavailable, malformed, unauthorized or outside its bound' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      cancelBody();
    }
  };
}
