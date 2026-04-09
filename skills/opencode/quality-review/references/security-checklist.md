# Security Review Checklist

Security review criteria based on OWASP Top 10 patterns. Used during Step 2 of the quality review process.

## Security Basics

| Check | Verify |
|-------|--------|
| Input sanitization | User input validated |
| No secrets in code | Use environment variables |
| SQL injection | Parameterized queries |
| XSS prevention | Output encoding |

## OWASP Top 10 (2021) Patterns

When reviewing code that handles user input, authentication, or data access, check for these common vulnerability patterns:

### Broken Access Control (A01)
- Authorization checks on every endpoint
- No direct object references without access validation
- Default deny for permissions

### Cryptographic Failures (A02)
- No secrets, API keys, or credentials in source code
- Sensitive data encrypted at rest and in transit
- PII properly handled per data classification

### Injection (A03)
- SQL queries use parameterized statements, never string concatenation
- Shell commands use safe APIs, never template strings with user input
- Output encoding applied to all user-controlled data (XSS)
- Content Security Policy headers set

### Insecure Design (A04)
- Threat modeling performed for critical flows
- Business logic validated server-side
- Rate limiting and resource controls in place

### Security Misconfiguration (A05)
- No debug mode in production config
- Error messages don't leak stack traces or internal details
- Security headers configured (CORS, CSP, HSTS)

### Vulnerable and Outdated Components (A06)
- Dependencies checked for known vulnerabilities
- No end-of-life frameworks or libraries
- Component versions tracked and updated

### Identification and Authentication Failures (A07)
- Passwords are hashed with bcrypt/argon2, never stored in plaintext
- Session tokens have sufficient entropy
- Rate limiting on authentication endpoints

### Software and Data Integrity Failures (A08)
- User input is validated before deserialization
- Type checking enforced on deserialized objects
- No eval() or equivalent on untrusted data
- CI/CD pipeline integrity verified

### Security Logging and Monitoring Failures (A09)
- Security-relevant events are logged
- Logs do not contain sensitive data
- Alerting configured for suspicious activity

### Server-Side Request Forgery (A10)
- URL inputs validated against allowlists
- Internal network access restricted from user-controlled requests
- DNS rebinding protections in place

## Detection Checklist

- [ ] No hardcoded secrets or API keys
- [ ] All user input validated at system boundaries
- [ ] SQL/NoSQL queries use parameterized statements
- [ ] Output encoding applied for XSS prevention
- [ ] Authentication uses secure hashing algorithms
- [ ] Authorization checks present on all endpoints
- [ ] Error messages do not expose internal details
- [ ] Dependencies checked for known vulnerabilities
