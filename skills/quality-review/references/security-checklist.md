# Security Review Checklist

Security review criteria based on OWASP Top 10 patterns. Used during Step 2 of the quality review process.

## Security Basics

| Check | Verify |
|-------|--------|
| Input sanitization | User input validated |
| No secrets in code | Use environment variables |
| SQL injection | Parameterized queries |
| XSS prevention | Output encoding |

## OWASP Top 10 Patterns

When reviewing code that handles user input, authentication, or data access, check for these common vulnerability patterns:

### Injection (A03)
- SQL queries use parameterized statements, never string concatenation
- Shell commands use safe APIs, never template strings with user input
- LDAP/XPath queries are parameterized

### Broken Authentication (A07)
- Passwords are hashed with bcrypt/argon2, never stored in plaintext
- Session tokens have sufficient entropy
- Rate limiting on authentication endpoints

### Sensitive Data Exposure (A02)
- No secrets, API keys, or credentials in source code
- Sensitive data encrypted at rest and in transit
- PII properly handled per data classification

### Broken Access Control (A01)
- Authorization checks on every endpoint
- No direct object references without access validation
- Default deny for permissions

### Security Misconfiguration (A05)
- No debug mode in production config
- Error messages don't leak stack traces or internal details
- Security headers configured (CORS, CSP, HSTS)

### Cross-Site Scripting (A03)
- Output encoding applied to all user-controlled data
- Content Security Policy headers set
- DOM manipulation uses safe APIs

### Insecure Deserialization (A08)
- User input is validated before deserialization
- Type checking enforced on deserialized objects
- No eval() or equivalent on untrusted data

## Detection Checklist

- [ ] No hardcoded secrets or API keys
- [ ] All user input validated at system boundaries
- [ ] SQL/NoSQL queries use parameterized statements
- [ ] Output encoding applied for XSS prevention
- [ ] Authentication uses secure hashing algorithms
- [ ] Authorization checks present on all endpoints
- [ ] Error messages do not expose internal details
- [ ] Dependencies checked for known vulnerabilities
