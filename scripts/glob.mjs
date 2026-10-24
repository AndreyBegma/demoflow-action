// Spec Decision 2, `scenarios`: `*`, `**` and `?` globs, several separated by
// newlines, matched against `demoflow check`'s scenario list. No dependency.

/** `\` to `/`, so a Windows-style path or pattern matches like a POSIX one. */
export function toPosix(text) {
  return text.replace(/\\/g, '/');
}

/** The non-blank lines of a multi-line input, trimmed (CRLF tolerated). */
export function parseGlobs(input) {
  return String(input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// One glob as an anchored RegExp. `*` is any run of characters but `/`, `?`
// one character but `/`, `**` any run including `/`; `**/` also matches no
// directory at all, so `demoflow/**/*.demo.json` matches `demoflow/a.demo.json`.
export function compileGlob(glob) {
  const pattern = toPosix(glob).replace(/^\.\//, '');
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** The paths matching any of the globs, `/`-separated, sorted, unique. */
export function filterPaths(paths, globs) {
  const matchers = globs.map(compileGlob);
  const matched = new Set();
  for (const raw of paths) {
    const candidate = toPosix(raw).replace(/^\.\//, '');
    if (matchers.some((matcher) => matcher.test(candidate))) {
      matched.add(candidate);
    }
  }
  return [...matched].sort();
}
