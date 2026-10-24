import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { statusOf, summaryMarkdown, tookOf, videoOf } from '../scripts/report.mjs';

const stages = (overrides = {}) => {
  const all = {};
  for (const name of ['readiness', 'execution', 'verification', 'recording', 'rendering', 'storage']) {
    all[name] = { status: 'passed' };
  }
  return { ...all, ...overrides };
};

const passing = {
  scenarioId: 'demoflow/customers.demo.json',
  slug: 'customers',
  exitCode: 0,
  result: {
    scenarioId: 'demoflow/customers.demo.json',
    scenarioName: 'Customers',
    startedAt: '2026-10-24T10:00:00.000Z',
    finishedAt: '2026-10-24T10:00:14.200Z',
    status: 'completed',
    stages: stages(),
    renders: [
      { format: 'gif', file: 'render/ffmpeg.gif', sizeBytes: 3_000_000 },
      { format: 'mp4', file: 'render/ffmpeg.mp4', sizeBytes: 1_800_000 },
    ],
    warnings: [],
  },
  message: null,
  files: { gif: 'customers/demo.gif', mp4: 'customers/demo.mp4' },
};

const failing = {
  scenarioId: 'demoflow/failing.demo.json',
  slug: 'failing',
  exitCode: 1,
  result: {
    ...passing.result,
    scenarioId: 'demoflow/failing.demo.json',
    scenarioName: 'Failing | assertion',
    finishedAt: '2026-10-24T10:00:06.100Z',
    status: 'failed',
    stages: stages({
      verification: {
        status: 'failed',
        error: {
          message: 'Expected "Clients" at /home/ann/shop/x on https://h/p?token=s ```',
          stepIndex: 2,
        },
      },
    }),
    renders: [{ format: 'mp4', file: 'render/ffmpeg.mp4', sizeBytes: 900_000 }],
  },
  message: null,
  files: { mp4: 'failing/demo.mp4' },
};

const invalid = {
  scenarioId: 'demoflow/broken.demo.json',
  slug: 'broken',
  exitCode: 2,
  result: null,
  message: 'error: steps[0].action: invalid',
  files: {},
};

const ctx = {
  artifactUrl: 'https://github.com/o/r/actions/runs/1/artifacts/2',
  runUrl: 'https://github.com/o/r/actions/runs/1',
  sha: '0123456789abcdef',
  now: '2026-10-24T10:01:00.000Z',
  redaction: { root: '/home/ann/shop', home: '/home/ann', pathApi: path.posix },
};

describe('statusOf', () => {
  it('passed, passed with warnings, failed stage, input error', () => {
    assert.equal(statusOf(passing), 'passed');
    assert.equal(
      statusOf({ ...passing, result: { ...passing.result, status: 'completed_with_warnings' } }),
      'passed with warnings',
    );
    assert.equal(statusOf(failing), 'failed: verification');
    assert.equal(statusOf(invalid), 'failed: input error');
  });

  it('names the first failed stage in pipeline order', () => {
    const entry = {
      ...failing,
      result: {
        ...failing.result,
        stages: stages({ rendering: { status: 'failed' }, readiness: { status: 'failed' } }),
      },
    };
    assert.equal(statusOf(entry), 'failed: readiness');
  });

  it('a non-zero exit without a failed stage is still failed', () => {
    assert.equal(statusOf({ ...passing, exitCode: 3 }), 'failed: exit 3');
  });
});

describe('cells', () => {
  it('Took and Video', () => {
    assert.equal(tookOf(passing.result), '14.2 s');
    assert.equal(tookOf(null), '-');
    assert.equal(videoOf(passing, ctx.artifactUrl), `[MP4, 1.8 MB](${ctx.artifactUrl})`);
    assert.equal(videoOf(passing, undefined), 'MP4, 1.8 MB');
    assert.equal(videoOf(invalid, ctx.artifactUrl), '-');
  });
});

describe('summaryMarkdown', () => {
  const results = { schemaVersion: 1, demoflowVersion: '0.6.0', scenarios: [passing, failing, invalid] };

  it('renders the Decision 5 table without previews or marker', () => {
    const body = summaryMarkdown(results, ctx);
    assert.ok(body.startsWith('### DemoFlow: 1 of 3 scenarios passed\n'));
    assert.ok(!body.includes('<!--'));
    assert.ok(!body.includes('<img'));
    assert.ok(body.includes('| Scenario | Status | Took | Video |'));
    assert.ok(
      body.includes(
        `| Customers (\`demoflow/customers.demo.json\`) | passed | 14.2 s | [MP4, 1.8 MB](${ctx.artifactUrl}) |`,
      ),
    );
    assert.ok(
      body.includes('| Failing \\| assertion (`demoflow/failing.demo.json`) | failed: verification | 6.1 s |'),
    );
    assert.ok(body.includes('| `demoflow/broken.demo.json` | failed: input error | - | - |'));
    assert.ok(body.trimEnd().endsWith(
      'demoflow 0.6.0 · run https://github.com/o/r/actions/runs/1 · updated 2026-10-24T10:01:00.000Z for 0123456',
    ));
  });

  it('lists failures with stage, step and a redacted, fence-safe message', () => {
    const body = summaryMarkdown(results, ctx);
    const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
    assert.ok(details.includes('**`demoflow/failing.demo.json`**: verification, step 2'));
    assert.ok(details.includes('Expected "Clients" at <project>/x on https://h/p ˋˋˋ'));
    assert.ok(!details.includes('token='));
    assert.ok(details.includes('**`demoflow/broken.demo.json`**: input error'));
    assert.ok(details.includes('error: steps[0].action: invalid'));
    assert.ok(!details.includes('customers'));
  });

  it('says so when no scenario matched', () => {
    const body = summaryMarkdown({ demoflowVersion: '0.6.0', scenarios: [] }, ctx);
    assert.ok(body.startsWith('### DemoFlow: no scenarios matched'));
    assert.ok(!body.includes('| Scenario |'));
  });

  it('drops rows beyond the cap behind an "... and N more" line', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...failing,
      scenarioId: `demoflow/s${String(i).padStart(2, '0')}.demo.json`,
    }));
    const body = summaryMarkdown(
      { demoflowVersion: '0.6.0', scenarios: many },
      { ...ctx, maxLength: 5_000, moreHint: 'see the artifact' },
    );
    assert.ok(body.length <= 5_000);
    assert.match(body, /\| \.\.\. and \d+ more: see the artifact \| \| \| \|/);
    assert.ok(body.includes('demoflow/s00.demo.json'));
    assert.ok(!body.includes('demoflow/s49.demo.json'));
  });
});
