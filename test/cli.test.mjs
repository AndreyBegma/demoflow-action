import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { cliPrefix, resolveDemoflowBin, resolvePlaywrightCli } from '../scripts/cli.mjs';

// A fake `npm install --prefix` tree: demoflow with its own nested playwright,
// and another playwright at the top that must not be picked.
const prefix = mkdtempSync(path.join(tmpdir(), 'demoflow-cli-'));
after(() => rmSync(prefix, { recursive: true, force: true }));

function pkg(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

const modules = path.join(prefix, 'node_modules');
pkg(prefix, { name: 'prefix' });
pkg(path.join(modules, 'demoflow'), {
  name: 'demoflow',
  bin: { demoflow: 'dist/bin/main.js' },
});
pkg(path.join(modules, 'demoflow', 'node_modules', 'playwright'), {
  name: 'playwright',
  version: '1.64.1',
});
pkg(path.join(modules, 'playwright'), { name: 'playwright', version: '1.0.0' });

describe('cli', () => {
  it('resolves the demoflow bin from the prefix', () => {
    assert.equal(
      resolveDemoflowBin(prefix),
      path.join(modules, 'demoflow', 'dist', 'bin', 'main.js'),
    );
  });

  it("resolves the Playwright demoflow pins, not the prefix's own", () => {
    assert.equal(
      resolvePlaywrightCli(prefix),
      path.join(modules, 'demoflow', 'node_modules', 'playwright', 'cli.js'),
    );
  });

  it('defaults the prefix to $RUNNER_TEMP/demoflow-cli', () => {
    assert.equal(cliPrefix({ RUNNER_TEMP: '/r' }), path.join('/r', 'demoflow-cli'));
    assert.equal(cliPrefix({ DEMOFLOW_CLI_PREFIX: '/p', RUNNER_TEMP: '/r' }), '/p');
    assert.throws(() => cliPrefix({}), /RUNNER_TEMP/);
  });
});
