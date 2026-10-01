/**
 * Skill-source vocabulary: the placeholder tokens that a skill can reference, and the skill class that they give.
 * The renderer and `placeholder-lint.ts` must see the same tokens. The renderer also calls the lint.
 * Thus this module owns the vocabulary, and both depend on it without an import cycle.
 */
import type { RuntimeTokenName } from './runtimes/types.js';
import { RuntimeTokenKey } from './runtimes/types.js';

/**
 * Matches `{{TOKEN}}` and `{{TOKEN arg1="..." arg2="..."}}`. Group 1 is the token name. Group 2 is the raw arg string, or undefined.
 * The arg body `[^}]*` forbids `}`, so a stray `}}` cannot go into an arg string.
 * The renderer and the placeholder lint share this one pattern, so the two cannot drift.
 *
 * WARNING: this is a stateful `/g` instance. A caller must use a local `.matchAll()` iterator,
 * or reset `lastIndex = 0` before and after an `.exec()` loop.
 */
export const PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+([^}]*))?\}\}/g;

/**
 * Matches `{{CALL tool action {json}}}` macros. Group 1 is `tool action {json}`, the `raw` input of `parseCallMacro()`.
 * The inner `.+` is greedy, so a JSON arg that holds `}` does not end the capture too early.
 * Thus two CALL macros on one line give one match, so put each CALL macro on its own line. The placeholder lint and the renderer share this pattern.
 *
 * WARNING: this is a stateful `/g` instance, with the same rules as `PLACEHOLDER_REGEX`.
 */
export const CALL_MACRO_REGEX = /\{\{CALL\s+(.+)\}\}/g;

export const REQUIRES_OPEN_REGEX = /<!--\s*requires:(native:)?([a-z0-9:-]+)\s*-->/g;

/**
 * The class of a skill, from the placeholder tokens that its source uses.
 * A `procedural` skill uses no orchestration token and has one render for all runtimes.
 * An `orchestration` skill uses at least one, so it keeps a render for each runtime.
 */
export type SkillClass = 'procedural' | 'orchestration';

/**
 * Prefix tokens. Each runtime YAML declares them, and their values differ only in the MCP or command prefix.
 * Thus a source that references only these tokens stays procedural.
 */
export const PREFIX_TOKENS: ReadonlySet<RuntimeTokenName> = new Set<RuntimeTokenName>([
  'MCP_PREFIX',
  'COMMAND_PREFIX',
]);

/**
 * Orchestration tokens: the agent-spawning primitives whose values differ per harness.
 * The set is `RuntimeTokenKey` minus `PREFIX_TOKENS`. Thus a new canonical token is an orchestration token unless it is also a prefix token.
 */
export const ORCHESTRATION_TOKENS: ReadonlySet<RuntimeTokenName> =
  new Set<RuntimeTokenName>(
    RuntimeTokenKey.filter((token) => !PREFIX_TOKENS.has(token)),
  );

/** O(1) membership set of the canonical `RuntimeTokenKey` names. */
const RUNTIME_TOKEN_SET: ReadonlySet<string> = new Set<string>(RuntimeTokenKey);

/** Narrow an arbitrary `{{...}}` identifier to a canonical `RuntimeTokenName`. */
function isRuntimeToken(name: string): name is RuntimeTokenName {
  return RUNTIME_TOKEN_SET.has(name);
}

/** True when `body` contains a `<!-- requires:* -->` capability guard. It uses a new regex, because `REQUIRES_OPEN_REGEX` is a stateful `/g` singleton. */
function hasRequiresGuard(body: string): boolean {
  return new RegExp(REQUIRES_OPEN_REGEX.source).test(body);
}

/** The per-skill model of the renderer: the skill class and the evidence for it, so that consumers do not scan the source again. */
export interface SkillModel {
  /** Canonical `RuntimeTokenKey` tokens the source references. */
  readonly tokensUsed: ReadonlySet<RuntimeTokenName>;
  /** Subset of `tokensUsed` that are orchestration tokens. */
  readonly orchestrationTokensUsed: ReadonlySet<RuntimeTokenName>;
  /** Whether the source contains any `<!-- requires:* -->` capability guard. */
  readonly hasCapabilityGuard: boolean;
  /** Derived class: `orchestration` iff any orchestration token is referenced. */
  readonly skillClass: SkillClass;
}

/**
 * Classify a skill source body by its placeholder tokens. A source with an orchestration token is `orchestration`, and other sources are `procedural`.
 * Only canonical `RuntimeTokenKey` names count. Handlebar literals such as `{{next}}` and unknown `{{...}}` names do not count.
 *
 * The model also records a `<!-- requires:* -->` capability guard. `assertProceduralSkill` rejects a guard in a procedural source, but a guard does not change the class.
 * The function uses a new regex, because `PLACEHOLDER_REGEX` is a stateful `/g` singleton.
 *
 * @param body - Raw skill source body (SKILL.md or a Markdown reference).
 * @returns The derived `SkillModel`.
 */
export function classifySkill(body: string): SkillModel {
  const tokensUsed = new Set<RuntimeTokenName>();
  const orchestrationTokensUsed = new Set<RuntimeTokenName>();

  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    if (name === undefined || !isRuntimeToken(name)) continue;
    tokensUsed.add(name);
    if (ORCHESTRATION_TOKENS.has(name)) orchestrationTokensUsed.add(name);
  }

  const skillClass: SkillClass =
    orchestrationTokensUsed.size > 0 ? 'orchestration' : 'procedural';

  return {
    tokensUsed,
    orchestrationTokensUsed,
    hasCapabilityGuard: hasRequiresGuard(body),
    skillClass,
  };
}
