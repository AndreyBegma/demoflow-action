import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTIONS_BOT, isFork, main, nextLink } from '../scripts/comment.mjs';

const API = 'https://api.github.test';
const REPO = 'o/r';
const MARKER = '<!-- demoflow-action:demoflow-videos -->';

/** An in-memory GitHub: issue comments of one PR, paginated by `per_page`. */
function fakeGitHub({ user = 403, refuse = {}, perPage } = {}) {
  const state = { comments: [], calls: [], nextId: 1 };
  state.fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method;
    state.calls.push(`${method} ${pathname}`);
    const reply = (status, data, headers = {}) =>
      new Response(data === undefined ? '' : JSON.stringify(data), { status, headers });
    if (refuse[method]) return reply(refuse[method], { message: 'Resource not accessible by integration' });
    if (method === 'GET' && pathname === '/user') {
      return typeof user === 'number' ? reply(user, { message: 'no' }) : reply(200, { login: user });
    }
    const list = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(pathname);
    if (list && method === 'GET') {
      const size = perPage ?? Number(searchParams.get('per_page'));
      const page = Number(searchParams.get('page') ?? 1);
      const slice = state.comments.slice((page - 1) * size, page * size);
      const more = page * size < state.comments.length;
      const link = more ? `<${API}${pathname}?per_page=${size}&page=${page + 1}>; rel="next"` : '';
      return reply(200, slice, link ? { link } : {});
    }
    if (list && method === 'POST') {
      const id = state.nextId++;
      const comment = { id, body: JSON.parse(init.body).body, user: { login: ACTIONS_BOT }, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}` };
      state.comments.push(comment);
      return reply(201, comment);
    }
    const one = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(pathname);
    if (one && method === 'PATCH') {
      const comment = state.comments.find((c) => c.id === Number(one[1]));
      comment.body = JSON.parse(init.body).body;
      return reply(200, comment);
    }
    return reply(404, { message: 'Not Found' });
  };
  return state;
}

const fixtureFile = (name) => fileURLToPath(new URL(`./fixtures/results/${name}.json`, import.meta.url));

describe('comment.mjs main', () => {
  let dir;
  let output;
  const event = (overrides = {}) => {
    const file = path.join(dir, `event-${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({
      repository: { default_branch: 'main', private: false },
      pull_request: {
        number: 7,
        head: { sha: 'feedfacecafe', ref: 'feature', repo: { full_name: REPO } },
        base: { ref: 'main' },
      },
      ...overrides,
    }));
    return file;
  };
  const env = (overrides = {}) => ({
    GITHUB_EVENT_PATH: event(),
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: API,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '100',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: dir,
    DEMOFLOW_RESULTS: fixtureFile('mixed'),
    ARTIFACT_URL: 'https://github.com/o/r/actions/runs/100/artifacts/9',
    INPUT_ARTIFACT_NAME: 'demoflow-videos',
    INPUT_SCENARIOS: 'demoflow/**/*.demo.json',
    INPUT_COMMENT: 'true',
    INPUT_PREVIEWS: 'true',
    INPUT_PREVIEWS_BRANCH: 'demoflow-previews',
    INPUT_MAX_GIF_SIZE_MB: '10',
    INPUT_PREVIEWS_RETENTION_DAYS: '30',
    INPUT_GITHUB_TOKEN: 'ghs_test',
    INPUT_WORKING_DIRECTORY: '.',
    ...overrides,
  });
  const published = (opts) => ({
    status: 'published',
    urls: Object.fromEntries(opts.gifs.map((gif) => [gif.slug, `https://github.com/o/r/raw/demoflow-previews/x/${gif.slug}.gif`])),
  });
  const deps = (github, extra = {}) => {
    const lines = [];
    return { lines, fetch: github.fetch, publish: published, log: (line) => lines.push(line), ...extra };
  };

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'comment-test-'));
    output = path.join(dir, 'output');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('two runs on one PR leave exactly one comment, updated in place', async () => {
    const github = fakeGitHub();
    writeFileSync(output, '');
    assert.equal(await main(env(), deps(github)), 0);
    assert.equal(await main(env({ DEMOFLOW_RESULTS: fixtureFile('all-passed') }), deps(github)), 0);
    assert.equal(github.comments.length, 1);
    assert.ok(github.comments[0].body.startsWith(`${MARKER}\n### DemoFlow: 2 of 2 scenarios passed`));
    assert.ok(github.comments[0].body.includes('<img src="https://github.com/o/r/raw/demoflow-previews/x/passing.gif" width="400">'));
    assert.deepEqual(github.calls.filter((call) => !call.startsWith('GET')), [
      'POST /repos/o/r/issues/7/comments',
      'PATCH /repos/o/r/issues/comments/1',
    ]);
    const outputs = readFileSync(output, 'utf8').trim().split('\n');
    assert.deepEqual(outputs, Array(2).fill('comment-url=https://github.com/o/r/pull/7#issuecomment-1'));
  });

  it('finds its comment on a later page, ignoring other authors and markers not on line 1', async () => {
    const github = fakeGitHub({ user: 'a-pat-user', perPage: 2 });
    github.comments.push(
      { id: 50, body: `${MARKER}\nby someone else`, user: { login: 'mallory' } },
      { id: 51, body: `quote:\n${MARKER}`, user: { login: 'a-pat-user' } },
      { id: 52, body: 'hello', user: { login: 'a-pat-user' } },
      { id: 53, body: `${MARKER}\nold`, user: { login: 'a-pat-user' } },
    );
    await main(env(), deps(github));
    assert.equal(github.comments.length, 4);
    assert.ok(github.comments[3].body.includes('1 of 3 scenarios passed'));
    assert.equal(github.comments[0].body, `${MARKER}\nby someone else`);
    assert.ok(github.calls.includes('GET /repos/o/r/issues/7/comments'));
  });

  it('a fork PR: one notice, no push and no API call', async () => {
    const github = fakeGitHub();
    let pushed = false;
    const d = deps(github, { publish: () => { pushed = true; } });
    const forkEvent = event({ pull_request: { number: 7, head: { repo: { full_name: 'fork/r' } }, base: { ref: 'main' } } });
    assert.equal(await main(env({ GITHUB_EVENT_PATH: forkEvent }), d), 0);
    assert.equal(github.calls.length, 0);
    assert.equal(pushed, false);
    assert.equal(d.lines.length, 1);
    assert.match(d.lines[0], /^::notice title=demoflow-action::A fork pull request/);
  });

  it('a fork whose repository was deleted counts as a fork', () => {
    assert.equal(isFork({ head: { repo: null } }, REPO), true);
    assert.equal(isFork({ head: { repo: { full_name: REPO } } }, REPO), false);
  });

  it('not a pull request, or comment: false: nothing is posted', async () => {
    const github = fakeGitHub();
    const push = event({ pull_request: undefined });
    await main(env({ GITHUB_EVENT_PATH: push }), deps(github));
    await main(env({ INPUT_COMMENT: 'false' }), deps(github));
    assert.equal(github.calls.length, 0);
  });

  it('a refused push: one warning, the comment links the artifact instead of images', async () => {
    const github = fakeGitHub();
    const d = deps(github, { publish: () => ({ status: 'refused', reason: 'pushing demoflow-previews was refused: 403' }) });
    assert.equal(await main(env(), d), 0);
    const warnings = d.lines.filter((line) => line.startsWith('::warning'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /GIF previews were not published \(pushing demoflow-previews was refused: 403\)/);
    assert.ok(!github.comments[0].body.includes('<img'));
    assert.ok(github.comments[0].body.includes('[GIF, 3.0 MB](https://github.com/o/r/actions/runs/100/artifacts/9)'));
  });

  it('a refused comment API: one warning, exit 0, no comment-url', async () => {
    const github = fakeGitHub({ refuse: { POST: 403 } });
    writeFileSync(output, '');
    const d = deps(github);
    assert.equal(await main(env(), d), 0);
    const warnings = d.lines.filter((line) => line.startsWith('::warning'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not be posted \(POST .* 403 Resource not accessible by integration\); the results are in the job summary/);
    assert.equal(readFileSync(output, 'utf8'), '');
  });

  it('previews: false publishes nothing; the token header is masked before a push', async () => {
    const github = fakeGitHub();
    let calls = 0;
    const counting = (opts) => { calls += 1; return published(opts); };
    await main(env({ INPUT_PREVIEWS: 'false' }), deps(github, { publish: counting }));
    assert.equal(calls, 0);
    const d = deps(github, { publish: counting });
    await main(env(), d);
    assert.equal(calls, 1);
    assert.ok(d.lines.includes(`::add-mask::${Buffer.from('x-access-token:ghs_test').toString('base64')}`));
  });

  it('passes the default, base and head branches as protected, and the staged GIF paths', async () => {
    const github = fakeGitHub();
    let seen;
    await main(env(), deps(github, { publish: (opts) => { seen = opts; return published(opts); } }));
    assert.deepEqual(seen.protectedBranches, ['main', 'main', 'feature']);
    assert.deepEqual(seen.gifs.map((gif) => gif.slug), ['customers', 'failing']);
    assert.equal(seen.gifs[0].file, path.join(dir, 'demoflow-artifact', 'customers', 'demo.gif'));
    assert.equal(seen.maxGifBytes, 10_000_000);
    assert.equal(seen.remoteUrl, 'https://github.com/o/r.git');
  });

  it('zero matched: updates an existing comment, never creates one', async () => {
    const none = path.join(dir, 'none.json');
    writeFileSync(none, JSON.stringify({ schemaVersion: 1, demoflowVersion: '0.6.0', scenarios: [] }));
    const fresh = fakeGitHub();
    await main(env({ DEMOFLOW_RESULTS: none }), deps(fresh));
    assert.equal(fresh.comments.length, 0);

    const github = fakeGitHub();
    await main(env(), deps(github));
    await main(env({ DEMOFLOW_RESULTS: none, INPUT_SCENARIOS: 'demoflow/x.demo.json' }), deps(github));
    assert.equal(github.comments.length, 1);
    assert.ok(github.comments[0].body.startsWith(`${MARKER}\n### DemoFlow: No scenarios matched \`demoflow/x.demo.json\``));
  });
});

describe('nextLink', () => {
  it('reads rel="next" among other relations', () => {
    assert.equal(nextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=5>; rel="last"'), 'https://a/x?page=2');
    assert.equal(nextLink('<https://a/x?page=1>; rel="prev"'), undefined);
    assert.equal(nextLink(''), undefined);
  });
});
