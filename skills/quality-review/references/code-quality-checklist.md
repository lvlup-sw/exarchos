# Code Quality Checklist

Detailed review criteria for code quality, SOLID principles, DRY enforcement, and structural standards. Used during Step 2 of the quality review process.

## 1. Code Quality

| Aspect | Check For |
|--------|-----------|
| Readability | Clear variable/function names |
| Complexity | Functions <30 lines, single responsibility |
| Duplication | DRY - no copy-paste code |
| Comments | Only where logic isn't self-evident |
| Formatting | Consistent with project style |

## 1.1 DRY Enforcement

| Pattern | Threshold | Priority |
|---------|-----------|----------|
| Identical code blocks | 3+ occurrences OR 5+ lines | HIGH (3+), MEDIUM (2) |
| Similar code (literals differ) | 3+ occurrences | MEDIUM |
| Repeated validation logic | 2+ locations | HIGH |
| Repeated business rules | 2+ locations | HIGH |
| Copy-pasted tests | 3+ similar tests | LOW |
| Magic literals | Same value 3+ times | MEDIUM |

**Detection approach (prefer MCP tools):**
- Use `search_for_pattern` to find duplicate code blocks
- Use `find_referencing_symbols` to trace dependency usage
- Use `get_symbols_overview` to understand module structure

**Detection checklist:**
- [ ] Search for identical multi-line blocks (5+ lines duplicated)
- [ ] Flag validation code outside designated validation layer
- [ ] Trace business rule conditionals - must have single source
- [ ] Check for repeated string/number literals without constants

## 2. SOLID Principles

| Principle | Verify | Specific Checks |
|-----------|--------|-----------------|
| **S**RP | One reason to change | Max 1 public type/file; class name matches responsibility |
| **O**CP | Extensible without modification | No switch/if-else on types; uses strategy/polymorphism |
| **L**SP | Subtypes substitutable | No `NotImplementedException`; no precondition strengthening |
| **I**SP | No forced dependencies | Interface <= 5 methods; no empty implementations |
| **D**IP | Depend on abstractions | No `new` for services; constructor injection only |

### ISP Violation Patterns

| Pattern | Detection | Priority |
|---------|-----------|----------|
| Fat interface (> 5 methods) | Count methods on interface | MEDIUM |
| Mixed read/write interface | Check for getters + mutators together | MEDIUM |
| Empty/throw implementations | Scan for `NotImplementedException`, empty bodies | HIGH |
| Vague interface names | `IService`, `IManager`, `IHandler` without qualifier | LOW |
| Partial interface usage | Client uses < 50% of interface methods | MEDIUM |

**ISP Checklist:**
- [ ] No interface has more than 5 methods
- [ ] Interfaces are role-specific (IReadable, IWritable, not IDataAccess)
- [ ] No classes implement interfaces with NotImplementedException
- [ ] Interface names describe a single capability

## 2.1 Control Flow Standards

| Standard | Check For |
|----------|-----------|
| Guard clauses | Validate at method entry, not nested |
| Early returns | Exit as soon as result is known |
| No arrow code | Deeply nested if/else is a smell |
| Conditional abstraction | Large switch/if-else extracted to helper |

### Guard Clause Pattern

**Preferred:**
```
if (input == null) return;
// Main logic flat
```

**Avoid:**
```
if (input != null) {
  // Entire body nested
}
```

## 2.2 Structural Standards

| Standard | Check For | Priority |
|----------|-----------|----------|
| One responsibility per file | Public types in dedicated files | HIGH |
| Composition over inheritance | See checklist below | MEDIUM-HIGH |
| Sealed by default | `sealed` unless designed for extension | LOW |

### Composition Over Inheritance Checklist

| Smell | Detection | Priority | Fix |
|-------|-----------|----------|-----|
| Inheritance depth > 2 | Count hierarchy levels | MEDIUM | Refactor to delegation |
| Base class, multiple concerns | Base has unrelated methods | MEDIUM | Split into interfaces + composition |
| `protected` for code sharing | Many protected methods (> 2/class) | MEDIUM | Extract to utility or inject strategy |
| Override that only extends | `super.method()` + additions | MEDIUM | Use decorator pattern |
| Inherit for one method | Extends to reuse single method | HIGH | Compose with delegation |

**Composition Checklist:**
- [ ] Inheritance represents true "is-a" relationship, not code reuse
- [ ] Class hierarchy depth <= 2
- [ ] `protected` methods rare (< 2 per class)
- [ ] No override methods that just call super + add logic

**Language-specific rules:** See `~/.claude/rules/coding-standards-{language}.md`

## 3. Error Handling

| Check | Verify |
|-------|--------|
| Errors caught | Try/catch where needed |
| Errors meaningful | Clear error messages |
| Errors propagated | Proper error bubbling |
| No silent failures | All errors handled or logged |
| Input validation | At system boundaries |

## 4. Test Quality

| Aspect | Verify |
|--------|--------|
| Arrange-Act-Assert | Clear test structure |
| Test isolation | No shared state issues |
| Meaningful assertions | Not just "expect(true)" |
| Edge cases | Boundary conditions tested |
| Error paths | Failure scenarios covered |

## 5. Performance

| Check | Verify |
|-------|--------|
| No N+1 queries | Batch operations used |
| Efficient algorithms | No obvious O(n^2) when O(n) works |
| Memory management | No leaks, proper cleanup |
| Async patterns | Proper await usage |

## 6. Frontend Aesthetics (if applicable)

For frontend code (React, Vue, HTML/CSS, etc.), verify distinctive design:

| Check | Verify |
|-------|--------|
| Distinctive typography | Not using Inter, Roboto, Arial, or system defaults |
| Intentional color palette | CSS variables defined, not ad-hoc colors |
| Purposeful motion | Orchestrated animations, not scattered micro-interactions |
| Atmospheric backgrounds | Layered/textured, not flat solid colors |
| Overall distinctiveness | Doesn't exhibit "AI slop" patterns |

**Anti-patterns to flag:**
- Purple gradients on white backgrounds
- Perfectly centered symmetric layouts
- Generic font choices
- Flat #f5f5f5 or pure white/black backgrounds
- Animation without purpose
