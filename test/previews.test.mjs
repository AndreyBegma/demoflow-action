import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  basicAuthOf,
  planPrune,
  publish,
  rawUrlOf,
  README_MARKER,
  runDirOfPath,
} from '../scripts/previews.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

describe('planPrune', () => {
  const metas = new Map([
    ['pr-7/demoflow-videos/100-1', { createdAt: '2026-10-24T10:00:00.000Z' }],
    ['pr-7/other-leg/100-1', { createdAt: '2026-10-24T10:00:00.000Z' }],
    ['pr-8/demoflow-videos/90-1', { createdAt: '2026-10-20T10:00:00.000Z' }],
    ['pr-9/demoflow-videos/10-1', { createdAt: '2026-09-01T10:00:00.000Z' }],
    ['pr-10/demoflow-videos/11-1', { createdAt: 'yesterday' }],
  ]);
  const paths = [
    'README.md',
    'pr-7/demoflow-videos/100-1/meta.json',
    'pr-7/demoflow-videos/100-1/a.gif',
    'pr-7/other-leg/100-1/a.gif',
    'pr-8/demoflow-videos/90-1/a.gif',
    'pr-9/demoflow-videos/10-1/a.gif',
    'pr-10/demoflow-videos/11-1/a.gif',
    'pr-11/demoflow-videos/12-1/a.gif',
    'stray.txt',
    'pr-12/old-layout.gif',
  ];
  const drop = planPrune(paths, metas, { pr: 7, artifactName: 'demoflow-videos', now: NOW, retentionDays: 30 });

  it("drops this PR's directories of the same artifact, keeps the other matrix leg", () => {
    assert.ok(drop.includes('pr-7/demoflow-videos/100-1'));
    assert.ok(!drop.includes('pr-7/other-leg/100-1'));
  });

  it('keeps other PRs within retention, drops expired ones and those without a readable meta.json', () => {
    assert.ok(!drop.includes('pr-8/demoflow-videos/90-1'));
    assert.ok(drop.includes('pr-9/demoflow-videos/10-1'));
    assert.ok(drop.includes('pr-10/demoflow-videos/11-1'));
    assert.ok(drop.includes('pr-11/demoflow-videos/12-1'));
  });

  it('drops anything outside the layout but never README.md', () => {
    assert.ok(drop.includes('stray.txt'));
    assert.ok(drop.includes('pr-12/old-layout.gif'));
    assert.ok(!drop.includes('README.md'));
  });

  it('retention 0 drops every other directory', () => {
    const all = planPrune(paths, metas, { pr: 1, artifactName: 'x', now: NOW, retentionDays: 0 });
    assert.ok(all.includes('pr-8/demoflow-videos/90-1'));
  });
});

describe('helpers', () => {
  it('runDirOfPath, rawUrlOf, basicAuthOf', () => {
    assert.equal(runDirOfPath('pr-3/a/1-2/x.gif'), 'pr-3/a/1-2');
    assert.equal(runDirOfPath('pr-3/a/x.gif'), undefined);
    assert.equal(runDirOfPath('docs/a/b/c'), undefined);
    assert.equal(
      rawUrlOf({ serverUrl: 'https://github.com', repository: 'o/r', branch: 'ci/previews', file: 'pr-1/my videos/1-1/a#b.gif' }),
      'https://github.com/o/r/raw/ci/previews/pr-1/my%20videos/1-1/a%23b.gif',
    );
    assert.equal(Buffer.from(basicAuthOf('t0k'), 'base64').toString(), 'x-access-token:t0k');
  });
});

describe('publish against a local bare repository', () => {
  let root;
  let remote;
  let gifA;
  let gifB;
  const branch = 'demoflow-previews';
  const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const tree = () =>
    sh(['--git-dir', remote, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).split('\n').filter(Boolean);
  const show = (file) => sh(['--git-dir', remote, 'show', `refs/heads/${branch}:${file}`]);

  const options = (overrides = {}) => ({
    remoteUrl: remote,
    serverUrl: 'https://github.com',
    repository: 'o/r',
    branch,
    pr: 7,
    artifactName: 'demoflow-videos',
    runId: '100',
    runAttempt: '1',
    sha: 'abc1234',
    gifs: [
      { slug: 'passing', file: gifA, sizeBytes: 5 },
      { slug: 'failing', file: gifB, sizeBytes: 5 },
    ],
    maxGifBytes: 10_000_000,
    retentionDays: 30,
    now: new Date(NOW),
    tempRoot: root,
    ...overrides,
  });

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'previews-test-'));
    remote = path.join(root, 'remote.git');
    sh(['init', '-q', '--bare', remote]);
    gifA = path.join(root, 'a.gif');
    gifB = path.join(root, 'b.gif');
    writeFileSync(gifA, 'GIF89a-passing');
    writeFileSync(gifB, 'GIF89a-failing');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('creates the branch as an orphan commit with README, meta.json and the GIFs', () => {
    const outcome = publish(options());
    assert.equal(outcome.status, 'published', outcome.reason);
    assert.equal(
      outcome.urls.passing,
      'https://github.com/o/r/raw/demoflow-previews/pr-7/demoflow-videos/100-1/passing.gif',
    );
    assert.deepEqual(tree(), [
      'README.md',
      'pr-7/demoflow-videos/100-1/failing.gif',
      'pr-7/demoflow-videos/100-1/meta.json',
      'pr-7/demoflow-videos/100-1/passing.gif',
    ]);
    assert.ok(show('README.md').startsWith(README_MARKER));
    assert.equal(JSON.parse(show('pr-7/demoflow-videos/100-1/meta.json')).createdAt, '2026-10-24T12:00:00.000Z');
    assert.equal(show('pr-7/demoflow-videos/100-1/passing.gif'), 'GIF89a-passing');
    const commit = sh(['--git-dir', remote, 'cat-file', 'commit', `refs/heads/${branch}`]);
    assert.ok(!/^parent /m.test(commit));
  });

  it('a later run of the same PR replaces the older directory; other PRs and legs stay', () => {
    assert.equal(publish(options({ pr: 8 })).status, 'published');
    assert.equal(publish(options({ artifactName: 'leg-windows' })).status, 'published');
    assert.equal(publish(options({ runId: '101', gifs: [{ slug: 'passing', file: gifA, sizeBytes: 5 }] })).status, 'published');
    const dirs = [...new Set(tree().map(runDirOfPath).filter(Boolean))];
    assert.deepEqual(dirs, ['pr-7/demoflow-videos/101-1', 'pr-7/leg-windows/100-1', 'pr-8/demoflow-videos/100-1']);
    const commit = sh(['--git-dir', remote, 'cat-file', 'commit', `refs/heads/${branch}`]);
    assert.ok(!/^parent /m.test(commit), 'still a single commit');
  });

  it('prunes directories past their retention', () => {
    const later = new Date(NOW + 31 * DAY);
    assert.equal(publish(options({ pr: 9, now: later })).status, 'published');
    const dirs = [...new Set(tree().map(runDirOfPath).filter(Boolean))];
    assert.deepEqual(dirs, ['pr-9/demoflow-videos/100-1']);
  });

  it('leaves out GIFs above max-gif-size-mb, and pushes nothing when none is left', () => {
    const before = sh(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]);
    const none = publish(options({ pr: 9, gifs: [{ slug: 'big', file: gifA, sizeBytes: 11 }], maxGifBytes: 10 }));
    assert.deepEqual(none, { status: 'published', urls: {} });
    assert.equal(sh(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), before);
    const some = publish(options({
      pr: 9,
      gifs: [{ slug: 'big', file: gifA, sizeBytes: 11 }, { slug: 'small', file: gifB, sizeBytes: 5 }],
      maxGifBytes: 10,
    }));
    assert.deepEqual(Object.keys(some.urls), ['small']);
    assert.ok(!tree().some((file) => file.endsWith('big.gif')));
  });

  it('retries a lost lease race and keeps the winner', () => {
    let raced = false;
    const outcome = publish(options({
      pr: 20,
      beforePush: () => {
        if (raced) return;
        raced = true;
        assert.equal(publish(options({ pr: 21 })).status, 'published');
      },
    }));
    assert.equal(outcome.status, 'published', outcome.reason);
    const dirs = new Set(tree().map(runDirOfPath));
    assert.ok(dirs.has('pr-20/demoflow-videos/100-1'));
    assert.ok(dirs.has('pr-21/demoflow-videos/100-1'));
  });

  it('gives up after the retries when the branch keeps moving', () => {
    let n = 0;
    const outcome = publish(options({
      pr: 30,
      beforePush: () => {
        n += 1;
        publish(options({ pr: 100 + n }));
      },
    }));
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.reason, /lease failed 4 times/);
    assert.equal(n, 4);
  });

  it('refuses to rewrite a branch it did not write', () => {
    const work = path.join(root, 'work');
    sh(['init', '-q', work]);
    writeFileSync(path.join(work, 'README.md'), '# app\n');
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'README.md'], work);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-gpg-sign', '-m', 'app'], work);
    sh(['push', '-q', remote, 'HEAD:refs/heads/main'], work);
    const outcome = publish(options({ branch: 'main' }));
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.reason, /no README\.md written by this action/);
    assert.match(sh(['--git-dir', remote, 'show', 'refs/heads/main:README.md']), /# app/);
  });

  it('refuses a protected branch name without touching git', () => {
    const outcome = publish(options({ branch: 'main', protectedBranches: ['main'], remoteUrl: path.join(root, 'nope') }));
    assert.equal(outcome.status, 'refused');
    assert.match(outcome.reason, /default, base or head/);
  });

  it('reports a refused push (a hook standing in for a ruleset or a 403)', { skip: process.platform === 'win32' }, () => {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "denied by ruleset" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    try {
      const outcome = publish(options({ pr: 40 }));
      assert.equal(outcome.status, 'refused');
      assert.match(outcome.reason, /refused/);
    } finally {
      rmSync(hook);
    }
  });

  it('never leaves its temporary clone behind', () => {
    const left = readdirSync(root);
    assert.ok(!left.some((name) => name.startsWith('demoflow-previews-')), left.join(' '));
  });
});
