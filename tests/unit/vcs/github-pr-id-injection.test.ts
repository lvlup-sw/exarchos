/**
 * A pull request id must not change the `gh api` path for a comment read.
 * A safe id is a positive decimal integer.
 * Any other id stops before `gh` sends a request.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { vcsActions } from '../../../src/registry/actions/orchestrate/vcs.js';
import { handleGetPrComments } from '../../../src/verbs/vcs/get-pr-comments.js';

const execFileAsync = promisify(execFile);

/**
 * Go `net/http` ServeMux redirects a path that contains `..`.
 * `gh` follows that redirect and sends the caller token on both requests.
 * The stand-in records each request and serves one fixed body per path.
 */
const SINK_SOURCE = `package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
)

func main() {
	socketPath := os.Args[1]
	logPath := os.Args[2]
	_ = os.Remove(socketPath)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		panic(err)
	}
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		panic(err)
	}
	write := func(line string) {
		_, _ = fmt.Fprintln(logFile, line)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		authKind := "absent"
		if r.Header.Get("Authorization") != "" {
			authKind = "present"
		}
		write(fmt.Sprintf("HANDLER method=%s path=%s auth=%s", r.Method, r.URL.Path, authKind))
		w.Header().Set("Content-Type", "application/json")
		body := "[]"
		switch r.URL.Path {
		case "/repos/other/private/issues/5/comments":
			body = "[{\\"id\\":5,\\"user\\":{\\"login\\":\\"other\\"},\\"body\\":\\"FOREIGN_COMMENT_BODY\\",\\"created_at\\":\\"2020-01-01T00:00:00Z\\"}]"
		case "/repos/other/private/contents/.env":
			body = "{\\"type\\":\\"file\\",\\"encoding\\":\\"base64\\",\\"content\\":\\"PLACEHOLDER_FILE_BODY\\",\\"path\\":\\".env\\"}"
		case "/repos/intended/repo/issues/42/comments", "/repos/intended/repo/pulls/42/comments", "/repos/intended/repo/pulls/42/reviews":
			body = "[{\\"id\\":42,\\"user\\":{\\"login\\":\\"intended\\"},\\"body\\":\\"intended comment\\",\\"created_at\\":\\"2020-01-01T00:00:00Z\\"}]"
		}
		_, _ = fmt.Fprint(w, body)
	})
	outer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authKind := "absent"
		if r.Header.Get("Authorization") != "" {
			authKind = "present"
		}
		write(fmt.Sprintf("RAW method=%s uri=%s auth=%s", r.Method, r.URL.RequestURI(), authKind))
		mux.ServeHTTP(w, r)
	})
	if err := http.Serve(ln, outer); err != nil {
		panic(err)
	}
}
`;

/** Parent-segment id that resolves to another repository's issue comments. */
const COMMENT_ESCAPE = '1/../../../../../repos/other/private/issues/5/comments?x=';

/** Parent-segment id that resolves to another repository's contents route. */
const FILE_ESCAPE = '1/../../../../../repos/other/private/contents/.env?ref=main&x=';

/** The same contents route with one fewer parent segment. */
const SHORT_FILE_ESCAPE = '1/../../../../repos/other/private/contents/.env?ref=main&x=';

const INTENDED_PATHS = [
  '/repos/intended/repo/issues/42/comments',
  '/repos/intended/repo/pulls/42/comments',
  '/repos/intended/repo/pulls/42/reviews',
] as const;

/** Returns the raw request targets in one slice of the sink log. */
function rawUris(chunk: string): string[] {
  const uris: string[] = [];
  for (const line of chunk.split('\n')) {
    const match = /^RAW method=\S+ uri=(\S+) auth=(\S+)$/.exec(line);
    if (match?.[1] !== undefined) uris.push(match[1]);
  }
  return uris;
}

describe('GitHub comment reads keep the pull request id inside one route', () => {
  let root: string;
  let socketPath: string;
  let logPath: string;
  let sink: ChildProcess;

  function ctx(): DispatchContext {
    return {
      stateDir: root,
      eventStore: {} as DispatchContext['eventStore'],
      enableTelemetry: false,
      projectConfig: {
        vcs: { provider: 'github', settings: {} },
      } as DispatchContext['projectConfig'],
    };
  }

  function logStart(): number {
    return statSync(logPath).size;
  }

  function logSlice(start: number): string {
    return readFileSync(logPath).subarray(start).toString('utf8');
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'gh-pr-id-'));
    socketPath = path.join(root, 'api.sock');
    logPath = path.join(root, 'requests.log');
    writeFileSync(logPath, '');
    const sourcePath = path.join(root, 'sink.go');
    const binaryPath = path.join(root, 'sink');
    writeFileSync(sourcePath, SINK_SOURCE);
    writeFileSync(
      path.join(root, 'config.yml'),
      [
        'git_protocol: https',
        'prompt: disabled',
        'pager: ""',
        `http_unix_socket: ${socketPath}`,
        '',
      ].join('\n'),
    );
    await execFileAsync('go', ['build', '-o', binaryPath, sourcePath]);
    sink = spawn(binaryPath, [socketPath, logPath], { stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (!exists(socketPath)) {
      if (Date.now() > deadline) throw new Error('local API socket did not appear');
      await delay(50);
    }
    process.env.GH_CONFIG_DIR = root;
    process.env.GH_HOST = 'github.localhost';
    process.env.GH_TOKEN = 'placeholder-token';
    process.env.GH_REPO = 'intended/repo';
    process.env.GH_PROMPT_DISABLED = '1';
    process.env.GH_PAGER = '';
    process.env.PAGER = 'cat';
  }, 60_000);

  afterAll(() => {
    sink.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * `get_pr_comments` declares `prId` as any non-empty string.
   * A parent segment or a question mark is not a pull request id.
   */
  it('rejects a pull request id that can retarget the API path', () => {
    const action = vcsActions.find((item) => item.name === 'get_pr_comments');
    expect(action).toBeDefined();
    expect(action?.schema.safeParse({ prId: '42' }).success).toBe(true);
    expect(action?.schema.safeParse({ prId: COMMENT_ESCAPE }).success).toBe(false);
    expect(action?.schema.safeParse({ prId: FILE_ESCAPE }).success).toBe(false);
    expect(action?.schema.safeParse({ prId: SHORT_FILE_ESCAPE }).success).toBe(false);
  });

  /**
   * A numeric id reads the issue comments, the review comments, and the reviews.
   * Each request stays on `intended/repo` and carries the caller token.
   */
  it('reads only the three comment routes for a numeric id', async () => {
    const start = logStart();
    const result = await handleGetPrComments({ prId: '42' }, ctx());
    const chunk = logSlice(start);
    const paths = rawUris(chunk).map((uri) => uri.split('?')[0]);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).toContain('intended comment');
    expect(paths).toEqual(expect.arrayContaining([...INTENDED_PATHS]));
    for (const requestPath of paths) {
      expect(requestPath?.startsWith('/repos/intended/repo/')).toBe(true);
    }
    expect(chunk).toContain('auth=present');
    expect(chunk).not.toContain('auth=absent');
  });

  /**
   * Issue comments, review comments, and reviews all interpolate `prId`.
   * The foreign comment body must not come back, and `gh` must not run.
   */
  it('does not read another repository when the id climbs out of the route', async () => {
    const start = logStart();
    const result = await handleGetPrComments({ prId: COMMENT_ESCAPE }, ctx());
    const chunk = logSlice(start);
    expect(rawUris(chunk)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('FOREIGN_COMMENT_BODY');
    expect(result.success).toBe(false);
  });

  /**
   * A contents route is not a comment route.
   * The file body must not come back, and `gh` must not run.
   */
  it('does not read a file when the id climbs out of the route', async () => {
    const start = logStart();
    const result = await handleGetPrComments({ prId: FILE_ESCAPE }, ctx());
    const chunk = logSlice(start);
    expect(rawUris(chunk)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER_FILE_BODY');
    expect(result.success).toBe(false);
  });

  /**
   * One fewer parent segment still leaves `intended/repo`.
   * `gh` must not run for that id either.
   */
  it('does not follow a short parent-segment id', async () => {
    const start = logStart();
    const result = await handleGetPrComments({ prId: SHORT_FILE_ESCAPE }, ctx());
    const chunk = logSlice(start);
    expect(rawUris(chunk)).toEqual([]);
    expect(result.success).toBe(false);
  });
});

/** True when the socket path exists. */
function exists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
