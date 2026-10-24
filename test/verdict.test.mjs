import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { verdict } from '../scripts/verdict.mjs';

const redaction = { root: '/work/app', home: '/home/runner', pathApi: path.posix };

const passed = { scenarioId: 'demoflow/passing.demo.json', exitCode: 0, result: { stages: {} }, message: null };
const failed = {
  scenarioId: 'demoflow/failing.demo.json',
  exitCode: 1,
  result: {
    stages: {
      readiness: { status: 'passed' },
      verification: {
        status: 'failed',
        error: { message: 'Expected "Clients"\nat /work/app/x', stepIndex: 2 },
      },
    },
  },
  message: null,
};
const invalid = {
  scenarioId: 'demoflow/broken.demo.json',
  exitCode: 2,
  result: null,
  message: 'error: steps[0] is invalid',
};

describe('verdict', () => {
  it('fails with one ::error:: per failed scenario when fail-on-error', () => {
    const { exitCode, lines } = verdict(
      { scenarios: [passed, failed, invalid] },
      { failOnError: true, redaction },
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(lines, [
      '::error title=DemoFlow scenario failed::demoflow/failing.demo.json: verification: Expected "Clients"%0Aat <project>/x',
      '::error title=DemoFlow scenario failed::demoflow/broken.demo.json: input error: error: steps[0] is invalid',
    ]);
  });

  it('passes with a warning when fail-on-error is false', () => {
    const { exitCode, lines } = verdict({ scenarios: [passed, failed] }, { failOnError: false, redaction });
    assert.equal(exitCode, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^::warning .*1 of 2 scenarios failed/);
  });

  it('passes when every scenario passed, or none matched', () => {
    assert.equal(verdict({ scenarios: [passed] }, { failOnError: true, redaction }).exitCode, 0);
    assert.equal(verdict({ scenarios: [] }, { failOnError: true, redaction }).exitCode, 0);
  });

  it('counts exit 3 (another stage) as failed', () => {
    const rendering = { ...passed, exitCode: 3 };
    assert.equal(verdict({ scenarios: [rendering] }, { failOnError: true, redaction }).exitCode, 1);
  });
});
