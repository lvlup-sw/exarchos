# Contract Testing

Guide for detecting and preventing contract drift between schemas, types, APIs, and their runtime consumers. Covers DIM-3 (Contracts) detection approaches and verification strategies.

## Schema Drift Detection Approach

Schema drift occurs when the declared shape of data diverges from how data is actually used at runtime. The most dangerous form: a field removed from a schema definition but still read by consuming code, which silently receives `undefined` instead of failing loudly.

### How to Find Fields Removed from Schema but Still Read at Runtime

1. **Identify schema changes:** Diff the schema file (Zod schema, JSON Schema, TypeScript interface) against its previous version. List all removed, renamed, or type-changed fields.

2. **Trace field usage:** For each removed field, search the codebase for all read sites — property access, destructuring, spread operations, and serialization paths.

3. **Check for guards:** At each read site, determine whether the code handles the field being absent (`undefined` check, optional chaining, default value). If not, the code will silently receive `undefined` and may produce incorrect behavior.

4. **Verify test coverage of the change:** Confirm that at least one test exercises the code path with the field absent. If tests still provide the field (via old factories or fixtures), they mask the drift.

**Detection heuristics:**
- `git diff` on schema files shows removed fields
- `grep -r 'fieldName'` across consuming code reveals read sites
- Compare Zod `.shape` keys against TypeScript interface members
- Check test factories and fixtures for removed fields that are still being set

### Common Schema Drift Vectors

| Vector | Example | Detection |
|--------|---------|-----------|
| Field removal | `_events` removed from Zod schema but guard code reads `state._events` | Grep for field name after schema change |
| Field rename | `userId` renamed to `user_id` but old name still used in some modules | Grep for old field name |
| Type narrowing | Field changes from `string` to `string literal union` but consumers use broad type | TypeScript compilation (if strict) |
| Optional to required | Field becomes required but consumers still use `?.` | Code review for unnecessary optional chaining |

---

## API Versioning Patterns

### Semantic Versioning for APIs

Apply semantic versioning principles to API boundaries:
- **MAJOR:** Removing fields, changing field types, removing endpoints — breaking changes
- **MINOR:** Adding optional fields, adding endpoints — backward-compatible additions
- **PATCH:** Documentation, description changes — no behavioral change

### Backward Compatibility Checks

Before merging API changes, verify:
1. **No removed fields** in response schemas (MAJOR change)
2. **No type changes** on existing fields (MAJOR change)
3. **New required fields** in request schemas have defaults or migration path (MAJOR change)
4. **Added optional fields** in responses do not break consumers that ignore unknown fields (MINOR change)

### Breaking Change Protocol

When a breaking change is necessary:
1. Introduce new version alongside old version
2. Mark old version as deprecated with sunset date
3. Migrate consumers to new version
4. Remove old version only after all consumers migrate

---

## Type Safety Verification

### Where Type Assertions Bypass Safety

Type assertions (`as Type`, `!` non-null assertion) tell the TypeScript compiler to trust the developer instead of verifying the type. Each assertion is a potential contract violation — the compiler cannot check the claim at runtime.

**High-risk assertion patterns:**

| Pattern | Risk | Alternative |
|---------|------|------------|
| `value as Type` without guard | Silently wrong if value doesn't match | Type guard function + assertion |
| `value!` (non-null assertion) | Runtime null if assertion wrong | Explicit null check with error |
| `JSON.parse(str) as Type` | Unvalidated external data | Zod/schema validation |
| `(event as any).field` | Bypasses all type checking | Proper type narrowing |
| `response.data as ApiResponse` | Trusts external service | Runtime validation |

### How to Find Unvalidated Casts

1. **Search for `as` keyword:** `grep -rn ' as [A-Z]' src/` — find all type assertions
2. **Check preceding lines:** Is there a type guard (`typeof`, `instanceof`, Zod `.parse()`) before the assertion? If not, the assertion is unvalidated.
3. **Prioritize external boundaries:** Assertions on data crossing trust boundaries (API responses, user input, file reads, database results) are highest risk.
4. **Check `!` assertions:** `grep -rn '!\.' src/` — find non-null assertions followed by property access.

---

## Contract Testing Fundamentals

### Consumer-Driven Contracts

In a consumer-driven contract model, the consumer defines what it needs from a provider. This inverts the traditional approach where the provider defines the API and consumers adapt.

**How it works:**
1. **Consumer writes a contract:** "I need field X of type Y from endpoint Z"
2. **Contract is shared with provider:** Via a contract broker or repository
3. **Provider verifies the contract:** Provider tests confirm they satisfy all consumer contracts
4. **Breaking changes are caught:** If a provider change violates a consumer contract, the provider's tests fail

**Benefits:**
- Consumers only depend on what they actually use
- Providers know exactly which fields are consumed and by whom
- Breaking changes are caught at the provider, before deployment

### Provider Verification

Provider verification is the provider-side complement to consumer contracts. The provider runs consumer contracts against its actual implementation to verify compatibility.

**Verification modes:**
- **Live verification:** Run consumer contracts against a running provider instance
- **Replay verification:** Record provider responses and verify contract against recordings
- **Schema verification:** Verify provider schema satisfies consumer contract schema

### Pact-Style Patterns

Pact is the canonical implementation of consumer-driven contracts. Key patterns applicable even without the Pact framework:

1. **Interaction recording:** Record actual consumer-provider interactions as the source of truth
2. **Contract broker:** Central repository for contracts, enabling cross-team visibility
3. **Can-I-Deploy:** Automated check that verifies compatibility before deployment
4. **Pending pacts:** New consumer contracts that don't yet break provider builds, giving providers time to adapt

**Applying Pact principles without Pact:**
- Write integration tests that exercise actual API calls (not mocked)
- Capture the request/response shape as a contract artifact
- Run provider tests against the captured contracts
- Fail the build if a provider change breaks a captured contract

---

## Runtime-Schema Alignment

Strategies for keeping runtime validation schemas (Zod, JSON Schema) in sync with TypeScript types.

### The Dual-Source Problem

TypeScript types exist only at compile time. Runtime validation schemas (Zod, io-ts, JSON Schema) exist only at runtime. When both describe the same data shape, they can drift independently — the TypeScript type says one thing, the Zod schema says another.

### Alignment Strategies

#### Zod-First (Recommended)

Define the Zod schema as the single source of truth. Derive the TypeScript type from it:

```typescript
const UserSchema = z.object({ id: z.string(), name: z.string() });
type User = z.infer<typeof UserSchema>;
```

**Advantage:** Types and runtime validation are guaranteed to match. Changes to the schema automatically update the type.

**Risk:** Zod schemas can express constraints (`.min()`, `.regex()`) that TypeScript types cannot represent. The type is always looser than the schema.

#### TypeScript-First with Validation

Define the TypeScript type first, then write a Zod schema that must satisfy it:

```typescript
interface User { id: string; name: string; }
const UserSchema: z.ZodType<User> = z.object({ id: z.string(), name: z.string() });
```

**Advantage:** TypeScript type is the design artifact; Zod schema must conform.

**Risk:** The `z.ZodType<User>` annotation catches structural mismatches but not constraint differences.

#### JSON Schema Generation

Generate JSON Schema from TypeScript types or Zod schemas, rather than maintaining it separately:

- `zod-to-json-schema` — generates JSON Schema from Zod
- `typescript-json-schema` — generates JSON Schema from TypeScript types
- `ts-json-schema-generator` — alternative TypeScript-to-JSON-Schema tool

**Advantage:** Single source of truth, generated artifacts always match.

**Risk:** Generated schemas may not capture all constraints. Custom validators need manual attention.

### Drift Detection Checklist

- [ ] Every Zod schema has a corresponding TypeScript type (or derives one via `z.infer`)
- [ ] Every TypeScript interface that crosses a trust boundary has a runtime validator
- [ ] Schema changes trigger a search for all consuming code
- [ ] Test fixtures and factories use schema-validated data, not hand-crafted objects
- [ ] API response types match their Zod validators
