# ADR: Installation Hardening Plan

## Status
Proposed

## Context

The Exarchos installer (`src/install.ts`) uses a symlink-based model to install commands, skills, rules, and settings into `~/.claude/`, plus registers MCP servers in `~/.claude.json`. While functional and idempotent for the common case, the installer has several robustness gaps identified during an optimization sweep (refactor-optimization-sweep).

The current installer is 322 lines with 37 passing tests, but lacks error recovery, atomic writes, and cross-platform handling.

## Findings

### 1. Atomic JSON Writes (Priority: High)

**Problem:** `configureMcpServers()` writes `~/.claude.json` via `writeFileSync(configPath, ...)`. If the process is interrupted mid-write, the file can be left in a corrupted state — breaking all MCP server configuration.

**Proposed Solution:**
```typescript
const tmpPath = `${configPath}.tmp.${Date.now()}`;
writeFileSync(tmpPath, JSON.stringify(config, null, 2));
renameSync(tmpPath, configPath); // Atomic on POSIX
```

**Effort:** ~30 minutes. Single function change.

### 2. Rollback on Partial Failure (Priority: High)

**Problem:** If symlinks are created successfully but the MCP server build fails (`npm install` or `npm run build`), the installer leaves a broken state: symlinks exist pointing to the repo, but `~/.claude.json` references an unbuilt MCP server binary.

**Proposed Solution:**
```typescript
const created: string[] = [];
try {
  // Track each symlink as created
  for (const dir of dirs) {
    const result = createSymlink(source, target);
    if (result !== 'skipped') created.push(target);
  }
  buildMcpServer(serverPath);
  configureMcpServers(configPath, repoRoot);
} catch (error) {
  // Rollback: remove created symlinks
  for (const target of created) {
    removeSymlink(target);
  }
  throw error;
}
```

**Effort:** ~1 hour. Wrap install() in try/catch with tracking.

### 3. Source Validation (Priority: Medium)

**Problem:** `createSymlink()` does not verify the source path exists before creating the symlink. If the repo is in an incomplete state (e.g., missing `commands/` directory), a symlink to a nonexistent target is created.

**Proposed Solution:**
```typescript
if (!existsSync(source)) {
  throw new Error(`Source does not exist: ${source}`);
}
```

**Effort:** ~15 minutes. Single guard clause.

### 4. Graphite Availability Check (Priority: Medium)

**Problem:** The installer configures a Graphite MCP server (`gt mcp` command) but does not verify that `gt` is installed. If missing, the MCP server silently fails to start.

**Proposed Solution:**
```typescript
try {
  execSync('which gt', { stdio: 'pipe' });
} catch {
  console.warn('  [warn] `gt` not found in PATH. Graphite MCP server may not work.');
  console.warn('  Install: https://graphite.dev/docs/installing-the-cli');
}
```

**Effort:** ~15 minutes. Add check before config write.

### 5. Backup Consolidation (Priority: Low)

**Problem:** Each install creates a new timestamped backup of `~/.claude.json` (e.g., `.backup.1770839704877`). After several installs, 7+ backup files accumulate. No cleanup mechanism exists.

**Proposed Solution:** Keep only the 2 most recent backups. After creating a new backup:
```typescript
const backups = readdirSync(dir)
  .filter(f => f.startsWith('claude.json.backup'))
  .sort()
  .reverse();
for (const old of backups.slice(2)) {
  rmSync(join(dir, old));
}
```

**Effort:** ~30 minutes. Add cleanup after backup creation.

### 6. Cross-Platform Symlink Fallback (Priority: Low)

**Problem:** Symlinks require `SeCreateSymbolicLinkPrivilege` on native Windows. WSL works fine (both WSL1 and WSL2), but a plain Windows install would fail silently.

**Proposed Solution:** Detect platform and warn:
```typescript
if (process.platform === 'win32') {
  console.warn('  [warn] Symlinks may require admin privileges on Windows.');
  console.warn('  Consider running from WSL for best compatibility.');
}
```

Full Windows support (using junctions or file copies as fallback) is deferred unless there's demand.

**Effort:** ~15 minutes for warning. ~2 hours for junction fallback.

### 7. Install Lock File (Priority: Low)

**Problem:** Concurrent installations (e.g., two terminal sessions running install simultaneously) can race on symlink creation and config file writes.

**Proposed Solution:** Simple lock file:
```typescript
const lockPath = join(claudeHome, '.install.lock');
if (existsSync(lockPath)) {
  const age = Date.now() - statSync(lockPath).mtimeMs;
  if (age < 60000) throw new Error('Installation already in progress');
}
writeFileSync(lockPath, Date.now().toString());
try { /* install */ } finally { unlinkSync(lockPath); }
```

**Effort:** ~30 minutes.

### 8. Multi-Clone Support (Priority: Low)

**Problem:** Only one clone of the repo can be "active" at a time. Installing from a second clone overwrites the first clone's symlinks and MCP config.

**Proposed Solution:** This is a design limitation of the symlink model. Options:
- Accept single-clone constraint (current behavior, document it)
- Support named installations (`exarchos install --name dev2`) with separate symlink targets
- Use a registry file tracking active installations

**Recommendation:** Document the single-clone constraint for now. Multi-clone is an edge case and the complexity isn't justified.

**Effort:** Documentation only: ~15 minutes. Full multi-clone: ~4 hours.

## Decision

Defer all implementation to a future refactor. This ADR documents the findings and priorities for when installation hardening is undertaken.

**Recommended implementation order:**
1. Atomic JSON writes (#1) + Source validation (#3) — quick wins, high impact
2. Rollback on partial failure (#2) — most impactful safety improvement
3. Graphite availability check (#4) — improves first-run experience
4. Backup consolidation (#5) + Lock file (#7) — cleanup
5. Cross-platform warning (#6) — only if Windows users appear
6. Multi-clone (#8) — only if needed

**Total estimated effort:** ~4-5 hours for items 1-5.

## Consequences

- Installation remains fragile to mid-write interruptions until #1 is implemented
- Partial install states require manual cleanup until #2 is implemented
- First-time users without Graphite see cryptic MCP errors until #4 is implemented
- These are acceptable risks for a developer tool primarily used on Linux/macOS with single-clone setups
