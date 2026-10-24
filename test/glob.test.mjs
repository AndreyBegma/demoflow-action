import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compileGlob,
  filterPaths,
  parseGlobs,
  toPosix,
} from '../scripts/glob.mjs';

const list = [
  'demoflow/login.demo.json',
  'demoflow/customers.demo.json',
  'demoflow/admin/users.demo.json',
  'demoflow/admin/deep/roles.demo.json',
  'demoflow/a1.demo.json',
  'demoflow/a22.demo.json',
];

describe('compileGlob', () => {
  it('`*` stays inside one directory', () => {
    const glob = compileGlob('demoflow/*.demo.json');
    assert.ok(glob.test('demoflow/login.demo.json'));
    assert.ok(!glob.test('demoflow/admin/users.demo.json'));
  });

  it('`**` crosses directories and `**/` matches zero of them', () => {
    const glob = compileGlob('demoflow/**/*.demo.json');
    assert.ok(glob.test('demoflow/login.demo.json'));
    assert.ok(glob.test('demoflow/admin/users.demo.json'));
    assert.ok(glob.test('demoflow/admin/deep/roles.demo.json'));
    assert.ok(!glob.test('other/login.demo.json'));
  });

  it('`**` at the end matches everything below', () => {
    const glob = compileGlob('demoflow/admin/**');
    assert.ok(glob.test('demoflow/admin/users.demo.json'));
    assert.ok(glob.test('demoflow/admin/deep/roles.demo.json'));
    assert.ok(!glob.test('demoflow/login.demo.json'));
  });

  it('`?` is exactly one character, never `/`', () => {
    const glob = compileGlob('demoflow/a?.demo.json');
    assert.ok(glob.test('demoflow/a1.demo.json'));
    assert.ok(!glob.test('demoflow/a22.demo.json'));
    assert.ok(!compileGlob('demoflow?a1.demo.json').test('demoflow/a1.demo.json'));
  });

  it('treats regular-expression characters literally', () => {
    const glob = compileGlob('demoflow/a.b+(c).demo.json');
    assert.ok(glob.test('demoflow/a.b+(c).demo.json'));
    assert.ok(!glob.test('demoflow/aXb+(c).demo.json'));
  });

  it('is anchored at both ends', () => {
    const glob = compileGlob('login.demo.json');
    assert.ok(!glob.test('demoflow/login.demo.json'));
    assert.ok(!glob.test('login.demo.json.bak'));
  });

  it('accepts a Windows-style or `./`-prefixed pattern', () => {
    assert.ok(
      compileGlob('demoflow\\**\\*.demo.json').test('demoflow/admin/users.demo.json'),
    );
    assert.ok(compileGlob('./demoflow/*.demo.json').test('demoflow/login.demo.json'));
  });
});

describe('parseGlobs', () => {
  it('splits on newlines, trims, drops blank lines and tolerates CRLF', () => {
    assert.deepEqual(parseGlobs('  a/*.json \r\n\r\n b/**\n'), ['a/*.json', 'b/**']);
    assert.deepEqual(parseGlobs(''), []);
    assert.deepEqual(parseGlobs(undefined), []);
  });
});

describe('filterPaths', () => {
  it('returns the sorted union of every glob', () => {
    assert.deepEqual(
      filterPaths(list, ['demoflow/login.demo.json', 'demoflow/admin/**']),
      [
        'demoflow/admin/deep/roles.demo.json',
        'demoflow/admin/users.demo.json',
        'demoflow/login.demo.json',
      ],
    );
  });

  it('lists a path matched by two globs once', () => {
    assert.deepEqual(
      filterPaths(['demoflow/login.demo.json'], ['demoflow/*', 'demoflow/**']),
      ['demoflow/login.demo.json'],
    );
  });

  it('normalises Windows-style input paths', () => {
    assert.deepEqual(
      filterPaths(
        ['demoflow\\admin\\users.demo.json', '.\\demoflow\\login.demo.json'],
        ['demoflow/**/*.demo.json'],
      ),
      ['demoflow/admin/users.demo.json', 'demoflow/login.demo.json'],
    );
    assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  });

  it('matches nothing without a glob', () => {
    assert.deepEqual(filterPaths(list, []), []);
  });
});
