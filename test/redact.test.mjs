// The cases of DemoFlow's `apps/cli/test/runs-report/redact.spec.ts`, ported.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cleanMessage, neutraliseBackticks, redactMessage } from '../scripts/report.mjs';

const posix = { root: '/home/ann/shop', home: '/home/ann', pathApi: path.posix };
const windows = { root: 'C:\\Users\\Ann\\app', home: 'C:\\Users\\Ann', pathApi: path.win32 };

describe('redactMessage', () => {
  it('drops the query string and fragment of a URL', () => {
    assert.equal(redactMessage('https://host/p?token=x#y', posix), 'https://host/p');
    assert.equal(
      redactMessage('goto http://a.test/#/admin failed', posix),
      'goto http://a.test/ failed',
    );
  });

  it('ends the URL at a quote, a parenthesis or an angle bracket', () => {
    assert.equal(
      redactMessage('navigation to "https://h/p?s=1" timed out', posix),
      'navigation to "https://h/p" timed out',
    );
    assert.equal(redactMessage("at 'http://h/?a=b' now", posix), "at 'http://h/' now");
    assert.equal(redactMessage('page (https://h/x?q=1) closed', posix), 'page (https://h/x) closed');
    assert.equal(redactMessage('<https://h/x#frag>', posix), '<https://h/x>');
  });

  it('leaves a URL without a query alone', () => {
    assert.equal(redactMessage('see https://h/docs/run.', posix), 'see https://h/docs/run.');
  });

  it('replaces the root, then the home', () => {
    assert.equal(
      redactMessage('missing /home/ann/shop/demoflow/a.json; cache /home/ann/.cache/ms', posix),
      'missing <project>/demoflow/a.json; cache ~/.cache/ms',
    );
    assert.equal(redactMessage('in /home/ann/shop', posix), 'in <project>');
  });

  it('does not take a path for the prefix of a longer name', () => {
    assert.equal(
      redactMessage('/home/anna/x and /home/ann/shop2', posix),
      '/home/anna/x and ~/shop2',
    );
  });

  it('matches a POSIX path case-sensitively', () => {
    assert.equal(redactMessage('/HOME/ANN/x', posix), '/HOME/ANN/x');
  });

  it('matches a Windows path with either separator and any case', () => {
    assert.equal(redactMessage('at c:/users/ann/app/src/x.ts', windows), 'at <project>/src/x.ts');
    assert.equal(
      redactMessage('C:\\Users\\Ann\\app\\a.png and C:/USERS/ANN/AppData', windows),
      '<project>\\a.png and ~/AppData',
    );
  });

  it('ignores a trailing separator on the root and home', () => {
    assert.equal(
      redactMessage('/srv/app/x and /home/u/y', {
        root: '/srv/app/',
        home: '/home/u/',
        pathApi: path.posix,
      }),
      '<project>/x and ~/y',
    );
  });

  it('never replaces a filesystem root', () => {
    assert.equal(redactMessage('/tmp/x', { root: '/', home: '/', pathApi: path.posix }), '/tmp/x');
    assert.equal(
      redactMessage('C:\\tmp', { root: 'C:\\', home: '', pathApi: path.win32 }),
      'C:\\tmp',
    );
  });

  it('keeps other absolute paths', () => {
    assert.equal(redactMessage('wrote /tmp/demoflow-1/x', posix), 'wrote /tmp/demoflow-1/x');
  });

  it('trims, and cuts a long message to 1000 characters ending in …', () => {
    assert.equal(redactMessage('  boom \n', posix), 'boom');
    assert.equal(redactMessage(' \n\t ', posix), '');
    const cut = redactMessage('x'.repeat(5_000), posix);
    assert.equal(cut.length, 1_000);
    assert.equal(cut, `${'x'.repeat(999)}…`);
    assert.equal(redactMessage('x'.repeat(1_000), posix), 'x'.repeat(1_000));
  });

  it('never splits a surrogate pair when it cuts', () => {
    const whole = redactMessage(`${'x'.repeat(997)}😀${'y'.repeat(9)}`, posix);
    assert.equal(whole, `${'x'.repeat(997)}😀…`);
    const split = redactMessage(`${'x'.repeat(998)}😀${'y'.repeat(9)}`, posix);
    assert.equal(split, `${'x'.repeat(998)}…`);
  });
});

describe('neutraliseBackticks', () => {
  it('leaves no backtick that could close a fence', () => {
    assert.equal(neutraliseBackticks('a ``` b `c`'), 'a ˋˋˋ b ˋcˋ');
    assert.equal(
      cleanMessage('```\nfailed at /home/ann/shop/x on https://h/p?k=1', posix),
      'ˋˋˋ\nfailed at <project>/x on https://h/p',
    );
  });
});
