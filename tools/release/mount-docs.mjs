// @ts-check
/**
 * Mounts relocated document subtrees back into this checkout as symlinks.
 *
 * The documents live in an external documents repository. The build, the tests and the shipped
 * package do not need them. The links let an old link or a question about a past decision
 * resolve locally.
 *
 * The links are not committed. A committed symlink stores the directory layout of one machine,
 * and it dangles on every other machine. Tooling that walks the tree then fails on read. So git
 * ignores the links, and each machine creates them on demand.
 *
 * It does not replace a real directory at `docs/<name>`. That directory holds a subtree that is
 * not relocated yet, or local work.
 *
 * Usage: node tools/release/mount-docs.mjs [--docs-repo <path>] [--unmount]
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
 * Where the documents repository is checked out. The default is a sibling of the main checkout:
 * `<workspace>/exarchos` and `<workspace>/docs`. A git worktree lives at
 * `<repo>/.claude/worktrees/<name>`, so the walk goes up to the main checkout first.
 */
function resolveDocsRepo(explicit) {
  if (explicit !== undefined) return path.resolve(explicit);
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
      console.warn(
        `[docs:mount] SKIP docs/${name} — a real directory exists there. It has either not been ` +
          `relocated yet or holds local work; refusing to replace it with a link.`,
      );
      skipped += 1;
      continue;
    }

    if (isLink) {
      if (path.resolve(path.dirname(linkPath), readlinkSync(linkPath)) === target) continue;
      unlinkSync(linkPath);
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
