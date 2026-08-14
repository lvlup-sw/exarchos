// @ts-check
/**
 * Mount relocated document subtrees back into this checkout as symlinks.
 *
 * Documents that left this repository live in an external documents
 * repository. Nothing here needs them — the build, the tests and the shipped
 * package are all indifferent — but a reader following an old link, or an
 * agent asked about a past decision, benefits from having them resolve
 * locally.
 *
 * ── WHY THE SYMLINKS ARE NOT COMMITTED ──────────────────────────────────────
 * A committed symlink stores its TARGET as file content, so it hard-codes one
 * machine's directory layout into everyone's checkout. It would resolve for
 * whoever created it and dangle for everyone else, and a dangling symlink is
 * worse than an absent directory: tooling that walks the tree sees an entry
 * and fails on read rather than skipping it cleanly.
 *
 * So the links are IGNORED and created on demand. The repository stays
 * portable, and the mount is a local convenience that each machine opts into.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * It will not overwrite a real directory. If `docs/<name>` exists and is not
 * already a symlink, that is either a subtree that has not been relocated yet
 * or a local edit someone has not pushed, and silently replacing it with a
 * link to somewhere else would destroy it.
 *
 * Usage:
 *   node tools/release/mount-docs.mjs [--docs-repo <path>] [--unmount]
 *
 * The destination defaults to a sibling checkout (`../docs`), which is how the
 * lvlup-sw repositories are normally laid out.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The key the destination repository files this project's documents under. */
const DESTINATION_KEY = 'exarchos';

function parseArgs(argv) {
  const out = { docsRepo: undefined, unmount: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--unmount') out.unmount = true;
    else if (argv[i] === '--docs-repo') out.docsRepo = argv[++i];
  }
  return out;
}

/**
 * Where the documents repository is checked out. A sibling by default —
 * `<workspace>/exarchos` and `<workspace>/docs` — resolved from the REPO ROOT
 * rather than from this file, so a git worktree (which nests several levels
 * deeper) still finds the same sibling.
 */
function resolveDocsRepo(explicit) {
  if (explicit !== undefined) return path.resolve(explicit);
  // A worktree lives at `<repo>/.claude/worktrees/<name>`, so walk up to the
  // real repository before stepping sideways.
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = REPO_ROOT.indexOf(marker);
  const mainCheckout = idx === -1 ? REPO_ROOT : REPO_ROOT.slice(0, idx);
  return path.resolve(path.dirname(mainCheckout), 'docs');
}

function main() {
  const { docsRepo: explicit, unmount } = parseArgs(process.argv.slice(2));
  const docsRepo = resolveDocsRepo(explicit);
  const sourceRoot = path.join(docsRepo, DESTINATION_KEY, 'docs');

  if (!unmount && !existsSync(sourceRoot)) {
    console.error(
      `[docs:mount] no relocated documents at ${sourceRoot}.\n` +
        `Clone the documents repository beside this one, or pass --docs-repo <path>.`,
    );
    process.exit(1);
  }

  const names = unmount
    ? readdirSync(path.join(REPO_ROOT, 'docs'), { withFileTypes: true })
        .filter((e) => e.isSymbolicLink())
        .map((e) => e.name)
    : readdirSync(sourceRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

  let mounted = 0;
  let skipped = 0;

  for (const name of names.sort()) {
    const linkPath = path.join(REPO_ROOT, 'docs', name);
    const target = path.join(sourceRoot, name);

    const existing = existsSync(linkPath) || isDanglingLink(linkPath);
    const isLink = existing && lstatSync(linkPath).isSymbolicLink();

    if (unmount) {
      if (isLink) {
        unlinkSync(linkPath);
        console.log(`[docs:mount] unmounted docs/${name}`);
        mounted += 1;
      }
      continue;
    }

    if (existing && !isLink) {
      // A real directory. Not ours to replace.
      console.warn(
        `[docs:mount] SKIP docs/${name} — a real directory exists there. It has either not been ` +
          `relocated yet or holds local work; refusing to replace it with a link.`,
      );
      skipped += 1;
      continue;
    }

    if (isLink) {
      if (path.resolve(path.dirname(linkPath), readlinkSync(linkPath)) === target) continue;
      unlinkSync(linkPath); // repoint a link aimed somewhere else
    }

    symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
    console.log(`[docs:mount] docs/${name} -> ${path.relative(REPO_ROOT, target)}`);
    mounted += 1;
  }

  console.log(
    unmount
      ? `[docs:mount] removed ${mounted} link(s)`
      : `[docs:mount] mounted ${mounted} subtree(s) from ${docsRepo}` +
          (skipped > 0 ? `, skipped ${skipped}` : ''),
  );
}

/** `existsSync` follows links, so a dangling one reads as absent. */
function isDanglingLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

main();
