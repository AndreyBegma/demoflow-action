// Spec Decision 4: publish the GIFs of a pull request to the previews branch
// of the same repository, as one orphan commit that also prunes what is no
// longer shown, so the comment can embed them by `raw` URL.
//
// Layout: `pr-<n>/<artifact-name>/<run_id>-<run_attempt>/<slug>.gif`, a
// `meta.json` in each run directory, a `README.md` at the root. The artifact
// name is part of the key because the legs of a matrix share one run id.
//
// The work happens in a throwaway repository under $RUNNER_TEMP: the token is
// an `http.extraheader` in that repository's own config, never the user's
// checkout, and the directory is removed whatever happens.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

/** The line `README.md` carries: a branch without it is not ours to rewrite. */
export const README_MARKER = '<!-- demoflow-action:previews-branch -->';

/** Retries after a lost `--force-with-lease` race (Decision 4). */
export const LEASE_RETRIES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const AUTHOR = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

export function readmeText(branch) {
  return `${README_MARKER}
# ${branch}

GIF previews for pull request comments, published by
[demoflow-action](https://github.com/AndreyBegma/demoflow-action).

This branch is rewritten as a single commit on every publish: older previews
of a pull request and previews past their retention are removed. Do not
commit to it. In a public repository it is public too.
`;
}

/** `pr-7/demoflow-videos/123-1`: where one run of one artifact puts its GIFs. */
export function runDirOf({ pr, artifactName, runId, runAttempt }) {
  return `pr-${pr}/${artifactName}/${runId}-${runAttempt}`;
}

/** The value of the `AUTHORIZATION` extraheader for a token (also to be masked). */
export function basicAuthOf(token) {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/** `https://github.com/o/r/raw/<branch>/<path>`, every segment URL-encoded. */
export function rawUrlOf({ serverUrl, repository, branch, file }) {
  const encode = (text) => text.split('/').map(encodeURIComponent).join('/');
  return `${serverUrl}/${repository}/raw/${encode(branch)}/${encode(file)}`;
}

/**
 * The paths of the previous tree to drop: every run directory of this pull
 * request and artifact (the new one included, it is written again), every run
 * directory whose `meta.json` is missing, unreadable or older than
 * `retentionDays`, and anything outside the layout. `metas` maps a run
 * directory to its parsed `meta.json`.
 */
export function planPrune(paths, metas, { pr, artifactName, now, retentionDays }) {
  const own = `pr-${pr}/${artifactName}/`;
  const drop = new Set();
  for (const file of paths) {
    if (file === 'README.md') continue;
    const dir = runDirOfPath(file);
    if (dir === undefined) {
      drop.add(file);
      continue;
    }
    if (drop.has(dir)) continue;
    const created = Date.parse(metas.get(dir)?.createdAt ?? '');
    if (dir.startsWith(own) || Number.isNaN(created) || now - created > retentionDays * DAY_MS) {
      drop.add(dir);
    }
  }
  return [...drop].sort();
}

/** `pr-7/a/1-1/x.gif` → `pr-7/a/1-1`; undefined outside the layout. */
export function runDirOfPath(file) {
  const parts = file.split('/');
  if (parts.length < 4 || !/^pr-\d+$/.test(parts[0])) return undefined;
  return parts.slice(0, 3).join('/');
}

function git(args, { cwd, env, input }) {
  const run = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return { code: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function gitOk(args, options) {
  const run = git(args, options);
  if (run.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`);
  }
  return run.stdout;
}

/** Why the branch must not be rewritten, or undefined when it may be. */
function refusalOf(cwd, sha, branch) {
  const commit = gitOk(['cat-file', 'commit', sha], { cwd });
  if (/^parent /m.test(commit)) {
    return `${branch} has history, so it is not a previews branch this action wrote`;
  }
  const readme = git(['cat-file', 'blob', `${sha}:README.md`], { cwd });
  if (readme.code !== 0 || !readme.stdout.startsWith(README_MARKER)) {
    return `${branch} has no README.md written by this action`;
  }
  return undefined;
}

/**
 * Fetch the branch, build the new tree and push it with a lease on the
 * fetched commit. Returns `{ pushed: true }`, `{ stale: true }` when another
 * push won the race, or `{ refusal }`.
 */
function attempt(cwd, opts, gifs) {
  const { branch, pr, artifactName, now, retentionDays } = opts;
  const ref = `refs/heads/${branch}`;
  const fetch = git(['fetch', '--depth=1', '--no-tags', 'origin', `+${ref}:refs/previews/base`], { cwd });
  let base = '';
  if (fetch.code === 0) {
    base = gitOk(['rev-parse', 'refs/previews/base'], { cwd }).trim();
    const refusal = refusalOf(cwd, base, branch);
    if (refusal) return { refusal };
  } else if (!/couldn't find remote ref/i.test(fetch.stderr)) {
    return { refusal: `fetching ${branch} failed: ${fetch.stderr.trim()}` };
  }

  const index = { GIT_INDEX_FILE: path.join(cwd, '.git', 'previews-index') };
  rmSync(index.GIT_INDEX_FILE, { force: true });
  if (base) {
    gitOk(['read-tree', base], { cwd, env: index });
    const paths = gitOk(['ls-tree', '-r', '--name-only', '-z', base], { cwd }).split('\0').filter(Boolean);
    const metas = new Map();
    for (const dir of new Set(paths.map(runDirOfPath).filter(Boolean))) {
      const blob = git(['cat-file', 'blob', `${base}:${dir}/meta.json`], { cwd });
      try {
        if (blob.code === 0) metas.set(dir, JSON.parse(blob.stdout));
      } catch {
        // An unreadable meta.json is pruned like a missing one.
      }
    }
    const drop = planPrune(paths, metas, { pr, artifactName, now: now.getTime(), retentionDays });
    if (drop.length > 0) {
      gitOk(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...drop], { cwd, env: index });
    }
  } else {
    gitOk(['read-tree', '--empty'], { cwd, env: index });
  }

  const add = (file, oid) =>
    gitOk(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], { cwd, env: index });
  const blobOf = (text) => gitOk(['hash-object', '-w', '--stdin'], { cwd, input: text }).trim();
  const dir = runDirOf(opts);
  const meta = {
    createdAt: now.toISOString(),
    pr,
    artifactName,
    runId: opts.runId,
    runAttempt: opts.runAttempt,
    sha: opts.sha,
  };
  add('README.md', blobOf(readmeText(branch)));
  add(`${dir}/meta.json`, blobOf(`${JSON.stringify(meta, null, 2)}\n`));
  for (const gif of gifs) {
    add(`${dir}/${gif.slug}.gif`, gitOk(['hash-object', '-w', '--', gif.file], { cwd }).trim());
  }
  const tree = gitOk(['write-tree'], { cwd, env: index }).trim();
  const commit = gitOk(
    ['commit-tree', '--no-gpg-sign', tree, '-m', `previews: ${dir}`],
    { cwd, env: AUTHOR },
  ).trim();

  opts.beforePush?.();
  const push = git(
    ['push', '--no-verify', '--porcelain', `--force-with-lease=${ref}:${base}`, 'origin', `${commit}:${ref}`],
    { cwd },
  );
  if (push.code === 0) return { pushed: true };
  const output = `${push.stdout}\n${push.stderr}`;
  if (/stale info|fetch first|non-fast-forward/i.test(output)) return { stale: true };
  return { refusal: `pushing ${branch} was refused: ${push.stderr.trim() || push.stdout.trim()}` };
}

/**
 * Publish `gifs` (`{ slug, file, sizeBytes }`, `file` absolute) for one run.
 * GIFs above `maxGifBytes` are left out. Returns `{ status: 'published',
 * urls }` (slug → raw URL) or `{ status: 'refused', reason }`; it never throws
 * for a git failure, and it never writes outside its own temporary directory.
 */
export function publish(opts) {
  const gifs = opts.gifs.filter((gif) => !(gif.sizeBytes > opts.maxGifBytes));
  if (gifs.length === 0) return { status: 'published', urls: {} };
  if (opts.protectedBranches?.includes(opts.branch)) {
    return { status: 'refused', reason: `${opts.branch} is the default, base or head branch` };
  }
  const cwd = mkdtempSync(path.join(opts.tempRoot, 'demoflow-previews-'));
  try {
    gitOk(['init', '-q'], { cwd });
    gitOk(['remote', 'add', 'origin', opts.remoteUrl], { cwd });
    if (opts.token) {
      gitOk(
        ['config', '--local', `http.${opts.serverUrl}/.extraheader`, `AUTHORIZATION: basic ${basicAuthOf(opts.token)}`],
        { cwd },
      );
    }
    for (let tries = 0; tries <= LEASE_RETRIES; tries += 1) {
      const outcome = attempt(cwd, opts, gifs);
      if (outcome.refusal) return { status: 'refused', reason: outcome.refusal };
      if (outcome.pushed) {
        const dir = runDirOf(opts);
        const urls = Object.fromEntries(
          gifs.map((gif) => [gif.slug, rawUrlOf({ ...opts, file: `${dir}/${gif.slug}.gif` })]),
        );
        return { status: 'published', urls };
      }
    }
    return {
      status: 'refused',
      reason: `${opts.branch} kept moving: the lease failed ${LEASE_RETRIES + 1} times`,
    };
  } catch (error) {
    return { status: 'refused', reason: error.message };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
