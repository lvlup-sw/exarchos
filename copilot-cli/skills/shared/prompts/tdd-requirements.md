# TDD Requirements

## The Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

## Process

1. **RED**: Write a failing test
   - Test must fail for the expected reason
   - Run tests to confirm failure
   - Verify the failure message matches expectations

2. **GREEN**: Write minimum code to pass
   - Only implement what's needed to pass the test
   - No extra features or "nice to have" code
   - Run tests to confirm passing

3. **REFACTOR**: Clean up (optional)
   - Improve code quality while keeping tests green
   - Apply SOLID principles where beneficial
   - Run tests after each refactor

## Test Naming

Follow: `MethodName_Scenario_ExpectedOutcome`

Examples:
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`

## Verification

Before marking complete:
- [ ] Test failed first (witnessed the RED)
- [ ] Test passes after implementation (confirmed GREEN)
- [ ] No extra code beyond test requirements
- [ ] All related tests still pass
