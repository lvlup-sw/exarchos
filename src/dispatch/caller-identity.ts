import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { CapabilityResolver } from '../workflow/capabilities/resolver.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  CAPABILITY_RESOLVER_ID,
  CAPABILITY_RESOLVER_VERSION,
  createInMemoryResolver,
  localOperatorAuthorization,
  resolveCapabilityAuthorization,
} from '../workflow/capabilities/resolver.js';
import { capabilitiesForPosture } from '../workflow/capabilities/posture-mapping.js';
import type { AgentPosture } from '../runtime/agents/spec.js';
import type { Capability } from '../runtime/agents/capabilities.js';

export type CallerKind = 'mcp-session' | 'local-operator';
export type CallerRole = 'agent' | 'operator';

/** Non-PII identity produced exclusively from adapter-owned runtime inputs. */
export interface CallerIdentity {
  readonly subjectId: string;
  readonly kind: CallerKind;
  readonly role: CallerRole;
}

export interface McpCallerRuntimeContext {
  readonly sessionId: string;
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };
}

export interface VersionedIdentity {
  readonly id: string;
  readonly version: string;
}

/**
 * Immutable authorization inputs captured once at a dispatch boundary.
 * Privileged handlers can persist this value later without re-reading mutable
 * session state or the current capability policy.
 */
export interface CallerAuthorizationSnapshot {
  readonly identity: CallerIdentity;
  readonly posture: AgentPosture;
  readonly capabilities: readonly Capability[];
  readonly resolver: VersionedIdentity;
  readonly policy: VersionedIdentity;
  readonly resolvedAt: string;
}

export const DISPATCH_AUTHORIZATION_POLICY_ID = 'dispatch-authorization' as const;
export const DISPATCH_AUTHORIZATION_POLICY_VERSION = '1' as const;

function opaqueSubjectId(prefix: 'mcp' | 'local', material: string): string {
  const digest = createHash('sha256')
    .update(`exarchos/caller-identity/v1\0${material}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

/**
 * Derive a session-scoped MCP identity. Client metadata contributes to the
 * digest but is never retained, logged, or exposed in the identity.
 */
export function deriveMcpCallerIdentity(
  runtime: McpCallerRuntimeContext,
): CallerIdentity {
  const clientMaterial = runtime.clientInfo === undefined
    ? ''
    : `${runtime.clientInfo.name}\0${runtime.clientInfo.version}`;
  return Object.freeze({
    subjectId: opaqueSubjectId('mcp', `${runtime.sessionId}\0${clientMaterial}`),
    kind: 'mcp-session',
    role: 'agent',
  });
}

/**
 * The grant that an MCP server gives each session. Only the launch configuration of the server sets it.
 * A connected agent cannot change it, because no tool argument and no handshake field reads it.
 */
export type McpSessionGrant = 'read-only' | 'operator';

/** The grant of an MCP session when the launch configuration names none. Absent authority fails closed. */
export const DEFAULT_MCP_SESSION_GRANT: McpSessionGrant = 'read-only';

/**
 * Returns a resolver that holds only `capabilities`. The handshake snapshot and the roots cache stay in `base`.
 * Thus a narrowed session and its process resolver agree about the client.
 */
function restrictResolver(
  base: CapabilityResolver,
  capabilities: readonly string[],
): CapabilityResolver {
  const held: ReadonlySet<string> = new Set(capabilities);
  return {
    has: (capability) => held.has(capability),
    list: () => [...held],
    snapshot: (handshake) => base.snapshot(handshake),
    isRootsDeclared: () => base.isRootsDeclared(),
    isElicitationDeclared: () => base.isElicitationDeclared(),
    isTaskSupportDeclared: () => base.isTaskSupportDeclared(),
    getCachedRoots: () => base.getCachedRoots(),
    setCachedRoots: (roots) => base.setCachedRoots(roots),
    invalidateRootsCache: () => base.invalidateRootsCache(),
  };
}

/**
 * Returns the capability resolver of one MCP session from the grant of its server.
 * The `operator` grant keeps the process resolver. The `read-only` grant holds the read-only posture
 * and the cache-hint token of the process, and nothing from the operator set.
 * Thus a read-only session holds no `mcp:exarchos`, no `fs:write`, no `shell:exec` and no policy issuer token.
 */
export function resolveMcpSessionResolver(
  grant: McpSessionGrant,
  processResolver: CapabilityResolver | undefined,
): CapabilityResolver | undefined {
  if (grant === 'operator') return processResolver;
  const capabilities: string[] = [...capabilitiesForPosture('read-only')];
  const cacheHints = processResolver === undefined
    ? process.env.EXARCHOS_DISABLE_CACHE_HINTS !== '1'
    : processResolver.has(ANTHROPIC_NATIVE_CACHING);
  if (cacheHints) capabilities.push(ANTHROPIC_NATIVE_CACHING);
  return restrictResolver(processResolver ?? createInMemoryResolver([]), capabilities);
}

/**
 * Derive the stable local-operator installation identity from the runtime's
 * configured state directory. Only an opaque digest leaves this boundary.
 */
export function deriveLocalOperatorIdentity(stateDir: string): CallerIdentity {
  const installationKey = path.normalize(path.resolve(stateDir));
  return Object.freeze({
    subjectId: opaqueSubjectId('local', installationKey),
    kind: 'local-operator',
    role: 'operator',
  });
}

/**
 * Resolves the authorization of the caller. When the resolver yields any capabilities, it decides.
 * A `local-operator` identity with an empty set gets the trusted local-operator grant. This is the
 * CLI path, where no capability resolver is wired.
 *
 * The `local-operator` identity comes from the adapter state directory, not from caller input. So
 * an `mcp-session` caller cannot get the grant. With no capabilities, it fails schema validation.
 */
function resolveTrustedCallerAuthorization(
  identity: CallerIdentity,
  resolver: CapabilityResolver | undefined,
): ReturnType<typeof resolveCapabilityAuthorization> {
  const resolved = resolveCapabilityAuthorization(resolver);
  if (identity.kind === 'local-operator' && resolved.capabilities.length === 0) {
    return localOperatorAuthorization();
  }
  return resolved;
}

/**
 * Freezes the identity and the authorization inputs that a dispatch uses. Tests can inject the
 * clock. The API takes no action payload.
 */
export function snapshotCallerAuthorization(
  identity: CallerIdentity,
  resolver: CapabilityResolver | undefined,
  clock: () => string = () => new Date().toISOString(),
): CallerAuthorizationSnapshot {
  const authorization = resolveTrustedCallerAuthorization(identity, resolver);
  const identitySnapshot = Object.freeze({ ...identity });
  const resolverIdentity = Object.freeze({
    id: CAPABILITY_RESOLVER_ID,
    version: CAPABILITY_RESOLVER_VERSION,
  });
  const policyIdentity = Object.freeze({
    id: DISPATCH_AUTHORIZATION_POLICY_ID,
    version: DISPATCH_AUTHORIZATION_POLICY_VERSION,
  });

  return Object.freeze({
    identity: identitySnapshot,
    posture: authorization.posture,
    capabilities: authorization.capabilities,
    resolver: resolverIdentity,
    policy: policyIdentity,
    resolvedAt: clock(),
  });
}
