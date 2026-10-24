// Spec Decision 3 step 11, Decisions 4 and 5: on a pull request, publish the
// GIFs to the previews branch, then create or update the one sticky comment
// keyed by `artifact-name`, and set `comment-url`.
//
// Every problem here degrades to less reporting with a single ::notice:: or
// ::warning::, and the step exits 0: only verdict.mjs decides the check.
//
//   node comment.mjs

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBoolean } from './inputs.mjs';
import { basicAuthOf, publish } from './previews.mjs';
import { commentMarkdown, contextFromEnv, gifOf, markerOf } from './report.mjs';
import { escapeCommand } from './run.mjs';

/** The login `GITHUB_TOKEN` comments as; it cannot read `GET /user` to say so. */
export const ACTIONS_BOT = 'github-actions[bot]';

export class ApiError extends Error {
  constructor(method, url, status, message) {
    super(`${method} ${url}: ${status} ${message}`);
    this.status = status;
  }
}

/** A minimal REST client over `fetch`: JSON in, JSON out, an ApiError when not ok. */
export function apiOf({ apiUrl, token, fetch }) {
  return async function request(method, target, body) {
    const url = target.startsWith('http') ? target : `${apiUrl}${target}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'demoflow-action',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        // Not JSON: the raw text is the message.
      }
      throw new ApiError(method, url, response.status, message);
    }
    return { data: text === '' ? null : JSON.parse(text), link: response.headers.get('link') ?? '' };
  };
}

/** The `rel="next"` URL of a `Link` header, if any. */
export function nextLink(link) {
  return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
}

/**
 * The login the token acts as. An installation token (`GITHUB_TOKEN`) is
 * refused `GET /user`, and it acts as github-actions[bot].
 */
export async function identityOf(request) {
  try {
    return (await request('GET', '/user')).data.login;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return ACTIONS_BOT;
    throw error;
  }
}

/** The sticky comment: first line is the marker, author is `login`; every page is read. */
export async function findComment(request, { repository, pr, marker, login }) {
  let target = `/repos/${repository}/issues/${pr}/comments?per_page=100`;
  while (target) {
    const { data, link } = await request('GET', target);
    const found = data.find(
      (comment) =>
        comment.user?.login === login && String(comment.body ?? '').split(/\r?\n/, 1)[0].trim() === marker,
    );
    if (found) return found;
    target = nextLink(link);
  }
  return undefined;
}

/** PATCH the sticky comment, or POST it when there is none (unless `updateOnly`). */
export async function upsertComment(request, { repository, pr, marker, body, updateOnly = false }) {
  const login = await identityOf(request);
  const existing = await findComment(request, { repository, pr, marker, login });
  if (existing) {
    const { data } = await request('PATCH', `/repos/${repository}/issues/comments/${existing.id}`, { body });
    return data.html_url;
  }
  if (updateOnly) return undefined;
  const { data } = await request('POST', `/repos/${repository}/issues/${pr}/comments`, { body });
  return data.html_url;
}

/** Whether a fork opened the pull request: its token is read-only (Decision 4). */
export function isFork(pullRequest, repository) {
  return pullRequest.head?.repo?.full_name !== repository;
}

/**
 * Whether GIFs are embedded for this repository. Decision 4: if `raw` branch
 * images do not render in a private repository's comments, this returns
 * false when `event.repository.private` is true. The owner's check is
 * pending, so they stay on.
 */
export function previewsAllowed(_event) {
  return true;
}

/** The GIFs to publish: slug, absolute staged file, size. */
export function gifsOf(results, stagingDir) {
  return (results.scenarios ?? []).flatMap((entry) => {
    const gif = gifOf(entry);
    return gif ? [{ slug: entry.slug, file: path.join(stagingDir, ...gif.path.split('/')), sizeBytes: gif.sizeBytes }] : [];
  });
}

/** The whole step; always resolves to 0. */
export async function main(env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const warn = (message) => log(`::warning title=demoflow-action::${escapeCommand(message)}`);
  try {
    await run(env, { log, warn, fetch: deps.fetch ?? fetch, publish: deps.publish ?? publish, now: deps.now ?? (() => new Date()) });
  } catch (error) {
    warn(`The PR comment could not be posted (${error.message}); the results are in the job summary.`);
  }
  return 0;
}

async function run(env, { log, warn, fetch, publish, now }) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    log('Not a pull request event: the results are in the job summary only.');
    return;
  }
  if (parseBoolean(env.INPUT_COMMENT) === false) return;
  const repository = env.GITHUB_REPOSITORY;
  if (isFork(pullRequest, repository)) {
    log(
      '::notice title=demoflow-action::A fork pull request gets a read-only token: no comment and no previews. The results are in the job summary and the artifact.',
    );
    return;
  }

  const results = JSON.parse(readFileSync(env.DEMOFLOW_RESULTS, 'utf8'));
  const artifactName = env.INPUT_ARTIFACT_NAME;
  const ctx = {
    ...contextFromEnv(env),
    now: now().toISOString(),
    artifactName,
    scenarios: env.INPUT_SCENARIOS,
    maxGifBytes: Number(env.INPUT_MAX_GIF_SIZE_MB) * 1_000_000,
    previewUrls: {},
  };
  const request = apiOf({ apiUrl: env.GITHUB_API_URL || 'https://api.github.com', token: env.INPUT_GITHUB_TOKEN, fetch });
  const target = { repository, pr: pullRequest.number, marker: markerOf(artifactName) };

  const gifs = gifsOf(results, path.join(env.RUNNER_TEMP, 'demoflow-artifact'));
  if (parseBoolean(env.INPUT_PREVIEWS) !== false && previewsAllowed(event) && gifs.length > 0) {
    if (env.INPUT_GITHUB_TOKEN) log(`::add-mask::${basicAuthOf(env.INPUT_GITHUB_TOKEN)}`);
    const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
    const outcome = publish({
      remoteUrl: `${serverUrl}/${repository}.git`,
      serverUrl,
      repository,
      token: env.INPUT_GITHUB_TOKEN,
      branch: env.INPUT_PREVIEWS_BRANCH,
      protectedBranches: [event.repository?.default_branch, pullRequest.base?.ref, pullRequest.head?.ref].filter(Boolean),
      pr: pullRequest.number,
      artifactName,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      sha: ctx.sha,
      gifs,
      maxGifBytes: ctx.maxGifBytes,
      retentionDays: Number(env.INPUT_PREVIEWS_RETENTION_DAYS),
      now: now(),
      tempRoot: env.RUNNER_TEMP,
    });
    if (outcome.status === 'published') {
      ctx.previewUrls = outcome.urls;
    } else {
      warn(`GIF previews were not published (${outcome.reason}); the comment links the artifact instead.`);
    }
  }

  const empty = (results.scenarios ?? []).length === 0;
  const url = await upsertComment(request, { ...target, body: commentMarkdown(results, ctx), updateOnly: empty });
  if (url) {
    appendFileSync(env.GITHUB_OUTPUT, `comment-url=${url}\n`);
    log(`Sticky comment: ${url}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env);
}
