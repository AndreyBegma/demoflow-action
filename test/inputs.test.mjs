import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareVersions,
  isBranchName,
  needsSetupNode,
  parseBoolean,
  parseFormats,
  validate,
} from '../scripts/inputs.mjs';

const valid = {
  INPUT_VERSION: '0.6.0',
  INPUT_FORMATS: 'gif,mp4',
  INPUT_PORT: '',
  INPUT_RETENTION_DAYS: '14',
  INPUT_ARTIFACT_NAME: 'demoflow-videos',
  INPUT_FAIL_ON_ERROR: 'true',
  INPUT_CACHE_BROWSERS: 'true',
  INPUT_INSTALL_SYSTEM_DEPS: 'false',
  INPUT_COMMENT: 'true',
  INPUT_PREVIEWS: 'true',
  INPUT_PREVIEWS_BRANCH: 'demoflow-previews',
  INPUT_MAX_GIF_SIZE_MB: '10',
  INPUT_PREVIEWS_RETENTION_DAYS: '30',
};

describe('validate', () => {
  it('accepts the defaults', () => {
    assert.deepEqual(validate(valid), []);
  });

  for (const version of ['0.6.0', '0.6.1', '0.10.0', '1.0.0', '0.7.0-rc.1']) {
    it(`accepts version ${version}`, () => {
      assert.deepEqual(validate({ ...valid, INPUT_VERSION: version }), []);
    });
  }

  for (const version of ['latest', '^0.6', '~0.6.0', '0.6', 'v0.6.0', '', '>=0.6.0']) {
    it(`rejects version "${version}" as not exact`, () => {
      const [error] = validate({ ...valid, INPUT_VERSION: version });
      assert.match(error, /not an exact version/);
    });
  }

  for (const version of ['0.5.0', '0.5.9', '0.6.0-rc.1']) {
    it(`rejects version ${version} as too old`, () => {
      const [error] = validate({ ...valid, INPUT_VERSION: version });
      assert.match(error, /older than 0\.6\.0/);
    });
  }

  it('accepts an empty formats and every known format', () => {
    assert.deepEqual(validate({ ...valid, INPUT_FORMATS: '' }), []);
    assert.deepEqual(
      validate({ ...valid, INPUT_FORMATS: ' mp4 , webm-square,gif-vertical ' }),
      [],
    );
  });

  it('rejects an unknown or empty format', () => {
    assert.equal(validate({ ...valid, INPUT_FORMATS: 'mp4,avi' }).length, 1);
    assert.equal(validate({ ...valid, INPUT_FORMATS: 'mp4,,gif' }).length, 1);
  });

  it('checks port, retention-days, artifact-name and booleans', () => {
    assert.deepEqual(validate({ ...valid, INPUT_PORT: '4173' }), []);
    for (const port of ['0', '65536', 'abc', '80.5']) {
      assert.equal(validate({ ...valid, INPUT_PORT: port }).length, 1, port);
    }
    assert.equal(validate({ ...valid, INPUT_RETENTION_DAYS: 'x' }).length, 1);
    assert.equal(validate({ ...valid, INPUT_ARTIFACT_NAME: ' ' }).length, 1);
    assert.equal(validate({ ...valid, INPUT_FAIL_ON_ERROR: 'yes' }).length, 1);
    assert.deepEqual(validate({ ...valid, INPUT_CACHE_BROWSERS: 'false' }), []);
    assert.equal(validate({ ...valid, INPUT_CACHE_BROWSERS: 'FALSE' }).length, 1);
  });

  it('checks the comment and previews inputs', () => {
    assert.deepEqual(validate({ ...valid, INPUT_COMMENT: 'false', INPUT_PREVIEWS: 'false' }), []);
    assert.equal(validate({ ...valid, INPUT_COMMENT: 'no' }).length, 1);
    assert.equal(validate({ ...valid, INPUT_PREVIEWS: '' }).length, 1);
    assert.deepEqual(validate({ ...valid, INPUT_MAX_GIF_SIZE_MB: '2.5' }), []);
    for (const size of ['0', '-1', 'ten', '', '1e3']) {
      assert.equal(validate({ ...valid, INPUT_MAX_GIF_SIZE_MB: size }).length, 1, size);
    }
    assert.deepEqual(validate({ ...valid, INPUT_PREVIEWS_RETENTION_DAYS: '0' }), []);
    assert.equal(validate({ ...valid, INPUT_PREVIEWS_RETENTION_DAYS: '1.5' }).length, 1);
    assert.equal(validate({ ...valid, INPUT_PREVIEWS_BRANCH: 'bad name' }).length, 1);
  });
});

describe('isBranchName', () => {
  for (const name of ['demoflow-previews', 'ci/previews', 'a.b', 'v1']) {
    it(`accepts ${name}`, () => assert.equal(isBranchName(name), true));
  }
  for (const name of ['', '@', '-x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b',
    'a@{1}', '/a', 'a/', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', 'a\tb']) {
    it(`rejects ${JSON.stringify(name)}`, () => assert.equal(isBranchName(name), false));
  }
});

describe('helpers', () => {
  it('compareVersions orders cores and puts a prerelease first', () => {
    assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('0.6.0-rc.1', '0.6.0'), -1);
    assert.equal(compareVersions('0.6.0', '0.6.0-rc.1'), 1);
  });

  it('parseFormats and parseBoolean', () => {
    assert.deepEqual(parseFormats(''), []);
    assert.deepEqual(parseFormats('gif, mp4'), ['gif', 'mp4']);
    assert.equal(parseBoolean('true'), true);
    assert.equal(parseBoolean('True'), undefined);
    assert.equal(parseBoolean('false'), false);
    assert.equal(parseBoolean('1'), undefined);
  });

  it('needsSetupNode: node-version set, or Node older than 22', () => {
    assert.equal(needsSetupNode({}, '22.11.0'), false);
    assert.equal(needsSetupNode({ INPUT_NODE_VERSION: '' }, '24.1.0'), false);
    assert.equal(needsSetupNode({}, '20.18.0'), true);
    assert.equal(needsSetupNode({ INPUT_NODE_VERSION: '24' }, '22.11.0'), true);
  });
});
