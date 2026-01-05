---
description: Plan implementation following strict TDD (Red-Green-Refactor)
---

# TDD Implementation Plan

Create a detailed TDD implementation plan for: "$ARGUMENTS"

## Skill Reference

Follow the implementation-planning skill: `@skills/implementation-planning/SKILL.md`

## TDD Workflow Reference

Follow the strict TDD workflow from @docs/prompts/tdd-workflow.mdc

## Plan Requirements

Generate a step-by-step implementation plan where:

1. **Every implementation step starts with a failing test**
2. **Each step is labeled with its TDD phase**: [RED], [GREEN], or [REFACTOR]
3. **Include test verification after each implementation**

## Plan Format

```
## Implementation Plan: [Feature Name]

### Step 1: [RED] Write failing test for [behavior]
- Create test file at [path]
- Test: `MethodName_Scenario_ExpectedOutcome`
- Expected failure reason: [reason]
- Run: `npm run test:run` or `dotnet test`

### Step 2: [GREEN] Implement minimum code
- Modify [file]
- Implementation: [brief description]
- Run: `npm run test:run` - verify test passes

### Step 3: [REFACTOR] Clean up
- Apply: [SOLID principle or improvement]
- Run: `npm run test:run` - verify tests stay green

### Step 4: [RED] Write failing test for [next behavior]
...
```

## Test Patterns

### TypeScript (Vitest)
```typescript
describe('Component', () => {
  it('should do expected behavior when condition', async () => {
    // Arrange
    const input = createTestData();
    // Act
    const result = await component.method(input);
    // Assert
    expect(result).toBe(expected);
  });
});
```

### C# (TUnit)
```csharp
[Test]
public async Task Method_Scenario_Outcome()
{
    // Arrange
    var sut = new SystemUnderTest();
    // Act
    var result = sut.Method();
    // Assert (MUST await)
    await Assert.That(result).IsEqualTo(expected);
}
```

## Deliverables

The plan MUST include:
- [ ] Test file locations
- [ ] Test method names following naming convention
- [ ] Expected failure reasons for RED phase
- [ ] Minimal implementation description for GREEN phase
- [ ] Specific refactoring actions for REFACTOR phase
- [ ] Verification commands after each step
