# Property-Based Testing Patterns

When a task has `testingStrategy.propertyTests: true`, write property tests alongside example tests during the TDD RED phase. Property tests use generators to produce random inputs and invariant assertions to verify that properties hold across the entire input space.

## Roundtrip Pattern

For any encode/decode, serialize/deserialize, or transform/inverse-transform pair, the roundtrip property ensures no data is lost.

**TypeScript (fast-check):**

```typescript
import { fc } from '@fast-check/vitest';

describe('codec', () => {
  it.prop([fc.anything()], (input) => {
    expect(decode(encode(input))).toEqual(input);
  });

  // Or with fc.assert:
  it('roundtrip for strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(decode(encode(s))).toBe(s);
      })
    );
  });
});
```

**C# (FsCheck):**

```csharp
using FsCheck;

[Property]
public void Roundtrip_EncodeDecode(string input)
{
    var encoded = Encode(input);
    var decoded = Decode(encoded);
    Assert.Equal(input, decoded);
}

// Or with Prop.ForAll:
[Test]
public void Roundtrip_SerializeDeserialize()
{
    Prop.ForAll<MyRecord>(record =>
    {
        var json = Serialize(record);
        var result = Deserialize(json);
        return result.Equals(record);
    }).QuickCheck();
}
```

## Invariant Pattern

For operations with mathematical or business invariants that must hold for all inputs.

**TypeScript (fast-check):**

```typescript
describe('scoring', () => {
  it.prop([fc.integer(), fc.integer()], (a, b) => {
    const result = calculateScore(a, b);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it.prop([fc.array(fc.integer())], (items) => {
    const result = computeTotal(items);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
```

**C# (FsCheck):**

```csharp
[Property]
public void Score_AlwaysInRange(int a, int b)
{
    var score = CalculateScore(a, b);
    Assert.InRange(score, 0.0, 1.0);
}

[Property]
public void Collection_SizeNeverNegative(List<int> items)
{
    var result = ProcessItems(items);
    Assert.True(result.Count >= 0);
}
```

## Idempotence Pattern

For operations where applying the function twice produces the same result as applying it once: `f(f(x)) === f(x)`.

**TypeScript (fast-check):**

```typescript
describe('normalization', () => {
  it.prop([fc.array(fc.integer())], (arr) => {
    expect(sort(sort(arr))).toEqual(sort(arr));
  });

  it.prop([fc.string()], (input) => {
    expect(normalize(normalize(input))).toBe(normalize(input));
  });
});
```

**C# (FsCheck):**

```csharp
[Property]
public void Sort_Idempotent(List<int> items)
{
    var once = Sort(items);
    var twice = Sort(once);
    Assert.Equal(once, twice);
}

[Property]
public void Normalize_Idempotent(string input)
{
    var once = Normalize(input);
    var twice = Normalize(once);
    Assert.Equal(once, twice);
}
```

## Commutativity Pattern

For operations where order should not affect the result.

**TypeScript (fast-check):**

```typescript
describe('event materialization', () => {
  it.prop(
    [fc.array(eventArb()), fc.array(eventArb())],
    (eventsA, eventsB) => {
      const resultAB = materialize([...eventsA, ...eventsB]);
      const resultBA = materialize([...eventsB, ...eventsA]);
      expect(resultAB).toEqual(resultBA);
    }
  );
});
```

**C# (FsCheck):**

```csharp
[Property]
public void Merge_Commutative(List<int> a, List<int> b)
{
    var resultAB = Merge(a, b);
    var resultBA = Merge(b, a);
    Assert.Equal(resultAB, resultBA);
}
```

## Integration with TDD RED Phase

Property tests are written as part of the TDD RED phase, alongside example tests:

1. **RED:** Write example test (specific case) AND property test (general invariant)
2. **GREEN:** Implement minimum code to pass both
3. **REFACTOR:** Extract generators, improve property descriptions

Property tests complement example tests -- they do not replace them. Example tests document specific behaviors; property tests verify invariants across the input domain.
