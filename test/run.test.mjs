import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  checkFailureMessage,
  entryOf,
  main,
  parseJsonObject,
  runArgs,
  slugOf,
  stagedNameOf,
  tailLines,
} from '../scripts/run.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'demoflow-run-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('helpers', () => {
  it('slugOf drops demoflow/ and .demo.json and flattens directories', () => {
    assert.equal(slugOf('demoflow/passing.demo.json'), 'passing');
    assert.equal(slugOf('demoflow/admin/users.demo.json'), 'admin__users');
    assert.equal(slugOf('demoflow\\admin\\users.demo.json'), 'admin__users');
  });

  it('parseJsonObject accepts one object only', () => {
    assert.deepEqual(parseJsonObject(' {"a":1}\n'), { a: 1 });
    assert.equal(parseJsonObject('[1]'), undefined);
    assert.equal(parseJsonObject('null'), undefined);
    assert.equal(parseJsonObject('error: bad\n'), undefined);
    assert.equal(parseJsonObject(''), undefined);
  });

  it('tailLines keeps the last non-empty lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const tail = tailLines(`${text}\n\n`).split('\n');
    assert.equal(tail.length, 20);
    assert.equal(tail[0], 'line 10');
    assert.equal(tail.at(-1), 'line 29');
  });

  it('stagedNameOf keeps a crop apart from the plain file', () => {
    assert.equal(stagedNameOf({ format: 'mp4', file: 'render/ffmpeg.mp4' }), 'demo.mp4');
    assert.equal(stagedNameOf({ format: 'gif', file: 'render/ffmpeg.gif' }), 'demo.gif');
    assert.equal(
      stagedNameOf({ format: 'mp4-vertical', file: 'render/ffmpeg-vertical.mp4' }),
      'demo-vertical.mp4',
    );
  });

  it('runArgs repeats --format and adds --port only when set', () => {
    assert.deepEqual(runArgs('/p/a.demo.json', { home: '/h', formats: ['gif', 'mp4'], port: '' }), [
      'run', '/p/a.demo.json', '--json', '--out', '/h', '--format', 'gif', '--format', 'mp4',
    ]);
    assert.deepEqual(runArgs('a', { home: '/h', formats: [], port: '4173' }), [
      'run', 'a', '--json', '--out', '/h', '--port', '4173',
    ]);
  });

  it('checkFailureMessage carries the CLI message and what is missing', () => {
    assert.equal(
      checkFailureMessage({ exitCode: 2, stdout: '', stderr: 'no demoflow.config.json\nhint: run demoflow init\n' }),
      'demoflow check failed (exit 2): no demoflow.config.json\nhint: run demoflow init',
    );
    assert.equal(
      checkFailureMessage({ exitCode: 1, stdout: '{"ffmpeg":"bundled","browser":"missing"}', stderr: '' }),
      'demoflow check failed (exit 1): the browser is missing (demoflow setup)',
    );
  });
});

describe('entryOf', () => {
  const runDir = path.join(scratch, 'runs', 'r1');
  mkdirSync(path.join(runDir, 'render'), { recursive: true });
  writeFileSync(path.join(runDir, 'render', 'ffmpeg.mp4'), 'mp4 bytes');
  writeFileSync(path.join(runDir, 'render', 'ffmpeg.gif'), 'gif bytes');
  const result = {
    scenarioId: 'demoflow/admin/users.demo.json',
    status: 'failed',
    renders: [
      { format: 'mp4', file: 'render/ffmpeg.mp4' },
      { format: 'gif', file: 'render/ffmpeg.gif' },
    ],
  };

  it('stages the renders and result.json under <slug>/', () => {
    const staging = path.join(scratch, 'staging-1');
    const entry = entryOf(
      {
        scenarioId: 'demoflow/admin/users.demo.json',
        exitCode: 1,
        stdout: JSON.stringify({ ...result, runDir }),
        stderr: 'progress\n',
      },
      staging,
    );
    assert.deepEqual(entry, {
      scenarioId: 'demoflow/admin/users.demo.json',
      slug: 'admin__users',
      exitCode: 1,
      result,
      message: null,
      files: { mp4: 'admin__users/demo.mp4', gif: 'admin__users/demo.gif' },
    });
    assert.equal(readFileSync(path.join(staging, 'admin__users', 'demo.mp4'), 'utf8'), 'mp4 bytes');
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(staging, 'admin__users', 'result.json'), 'utf8')),
      result,
    );
  });

  it('turns non-JSON stdout into a failed entry with the stderr tail', () => {
    const entry = entryOf(
      { scenarioId: 'demoflow/bad.demo.json', exitCode: 2, stdout: 'oops', stderr: 'a\nerror: invalid step\n' },
      path.join(scratch, 'staging-2'),
    );
    assert.deepEqual(entry, {
      scenarioId: 'demoflow/bad.demo.json',
      slug: 'bad',
      exitCode: 2,
      result: null,
      message: 'a\nerror: invalid step',
      files: {},
    });
  });

  it('never counts a run without a result as passed', () => {
    const entry = entryOf(
      { scenarioId: 'demoflow/x.demo.json', exitCode: 0, stdout: '', stderr: '' },
      path.join(scratch, 'staging-3'),
    );
    assert.equal(entry.exitCode, 1);
    assert.match(entry.message, /printed no result/);
  });
});

// main() against a fake `demoflow` that lists three scenarios and fails the
// second one: every scenario still runs, in order, and the outputs add up.
describe('main', () => {
  const temp = path.join(scratch, 'runner-temp');
  const prefix = path.join(temp, 'demoflow-cli');
  const project = path.join(scratch, 'project');
  const log = path.join(scratch, 'calls.log');
  const output = path.join(scratch, 'github-output');

  beforeEach(() => {
    rmSync(temp, { recursive: true, force: true });
    rmSync(log, { force: true });
    writeFileSync(output, '');
    mkdirSync(project, { recursive: true });
    const pkgDir = path.join(prefix, 'node_modules', 'demoflow');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(prefix, 'package.json'), '{}');
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'demoflow', bin: { demoflow: 'bin.mjs' } }));
    writeFileSync(path.join(pkgDir, 'bin.mjs'), FAKE_CLI);
  });

  const env = (overrides = {}) => ({
    RUNNER_TEMP: temp,
    GITHUB_OUTPUT: output,
    FAKE_LOG: log,
    FAKE_ROOT: project,
    INPUT_WORKING_DIRECTORY: project,
    INPUT_SCENARIOS: 'demoflow/**/*.demo.json',
    INPUT_FORMATS: 'mp4',
    INPUT_PORT: '4999',
    INPUT_VERSION: '0.6.0',
    ...overrides,
  });

  it('runs every scenario in order, even after a failure, and writes results.json', async (t) => {
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(console, 'log', () => {});
    assert.equal(await main({ ...process.env, ...env() }), 0);
    t.mock.restoreAll();

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'check --json',
      `run ${path.join(project, 'demoflow', 'a.demo.json')} --json --out ${path.join(temp, 'demoflow-home')} --format mp4 --port 4999`,
      `run ${path.join(project, 'demoflow', 'b.demo.json')} --json --out ${path.join(temp, 'demoflow-home')} --format mp4 --port 4999`,
      `run ${path.join(project, 'demoflow', 'sub', 'c.demo.json')} --json --out ${path.join(temp, 'demoflow-home')} --format mp4 --port 4999`,
    ]);

    const results = JSON.parse(readFileSync(path.join(temp, 'demoflow-results.json'), 'utf8'));
    assert.equal(results.schemaVersion, 1);
    assert.equal(results.demoflowVersion, '0.6.0');
    assert.deepEqual(
      results.scenarios.map((e) => [e.scenarioId, e.slug, e.exitCode, e.files]),
      [
        ['demoflow/a.demo.json', 'a', 0, { mp4: 'a/demo.mp4' }],
        ['demoflow/b.demo.json', 'b', 1, { mp4: 'b/demo.mp4' }],
        ['demoflow/sub/c.demo.json', 'sub__c', 0, { mp4: 'sub__c/demo.mp4' }],
      ],
    );
    assert.ok(existsSync(path.join(temp, 'demoflow-artifact', 'b', 'demo.mp4')));
    assert.ok(existsSync(path.join(temp, 'demoflow-artifact', 'b', 'result.json')));
    const outputs = readFileSync(output, 'utf8');
    assert.match(outputs, /^total=3$/m);
    assert.match(outputs, /^passed=2$/m);
    assert.match(outputs, /^failed=1$/m);
    assert.match(outputs, /^staged=true$/m);
  });

  it('filters with the scenarios globs and clears an earlier staging directory', async (t) => {
    mkdirSync(path.join(temp, 'demoflow-artifact', 'stale'), { recursive: true });
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(console, 'log', () => {});
    assert.equal(await main({ ...process.env, ...env({ INPUT_SCENARIOS: 'demoflow/sub/**\n' }) }), 0);
    t.mock.restoreAll();
    const results = JSON.parse(readFileSync(path.join(temp, 'demoflow-results.json'), 'utf8'));
    assert.deepEqual(results.scenarios.map((e) => e.scenarioId), ['demoflow/sub/c.demo.json']);
    assert.ok(!existsSync(path.join(temp, 'demoflow-artifact', 'stale')));
  });

  it('zero matches: a notice, total=0, success', async (t) => {
    const logged = [];
    t.mock.method(console, 'log', (line) => logged.push(line));
    assert.equal(await main({ ...process.env, ...env({ INPUT_SCENARIOS: 'nothing/*' }) }), 0);
    t.mock.restoreAll();
    assert.ok(logged.some((line) => line.startsWith('::notice')));
    assert.match(readFileSync(output, 'utf8'), /^total=0$/m);
    assert.match(readFileSync(output, 'utf8'), /^staged=false$/m);
  });

  it('a failed check fails the step before any scenario runs', async (t) => {
    const logged = [];
    t.mock.method(console, 'log', (line) => logged.push(line));
    assert.equal(await main({ ...process.env, ...env({ FAKE_CHECK_EXIT: '2' }) }), 1);
    t.mock.restoreAll();
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['check --json']);
    assert.ok(logged.some((line) => line.startsWith('::error') && line.includes('no demoflow.config.json')));
  });
});

const FAKE_CLI = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, args.join(' ') + '\\n');
if (args[0] === 'check') {
  if (process.env.FAKE_CHECK_EXIT) {
    process.stderr.write('no demoflow.config.json found\\n');
    process.exit(Number(process.env.FAKE_CHECK_EXIT));
  }
  console.log(JSON.stringify({
    root: process.env.FAKE_ROOT,
    configValid: true,
    scenarios: ['demoflow/a.demo.json', 'demoflow/b.demo.json', 'demoflow/sub/c.demo.json'],
    ffmpeg: 'bundled',
    browser: 'installed',
  }));
  process.exit(0);
}
const file = args[1];
const failed = file.endsWith('b.demo.json');
const runDir = path.join(args[args.indexOf('--out') + 1], 'runs', path.basename(file));
mkdirSync(path.join(runDir, 'render'), { recursive: true });
writeFileSync(path.join(runDir, 'render', 'ffmpeg.mp4'), 'video');
process.stderr.write('running ' + file + '\\n');
console.log(JSON.stringify({
  scenarioId: file,
  status: failed ? 'failed' : 'completed',
  renders: [{ format: 'mp4', file: 'render/ffmpeg.mp4', sizeBytes: 5 }],
  runDir,
}));
process.exit(failed ? 1 : 0);
`;
