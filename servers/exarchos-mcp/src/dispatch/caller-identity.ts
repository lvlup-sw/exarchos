import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { CapabilityResolver } from '../capabilities/resolver.js';
import {
  CAPABILITY_RESOLVER_ID,
  CAPABILITY_RESOLVER_VERSION,
  resolveCapabilityAuthorization,
} from '../capabilities/resolver.js';
import type { AgentPosture } from '../agents/spec.js';
import type { Capability } from '../agents/capabilities.js';

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
 * Freeze the exact identity and resolver-authoritative authorization inputs
 * used by a dispatch. The clock is injectable for deterministic tests; action
 * payloads are deliberately absent from this API.
 */
export function snapshotCallerAuthorization(
  identity: CallerIdentity,
  resolver: CapabilityResolver | undefined,
  clock: () => string = () => new Date().toISOString(),
): CallerAuthorizationSnapshot {
  const authorization = resolveCapabilityAuthorization(resolver);
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
