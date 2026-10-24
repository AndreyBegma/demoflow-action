# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-24

First release.

### Added

- Composite action that installs an exact `demoflow` version, sets up Chromium
  (cached with `actions/cache`) and runs every matching scenario sequentially,
  never stopping at a failure.
- Videos, GIFs and `result.json` of every scenario uploaded as one workflow
  artifact; `results.json` and the `results`, `total`, `passed`, `failed`,
  `artifact-url` and `comment-url` outputs.
- Job summary with a results table on every event.
- One sticky pull request comment per `artifact-name`, updated in place, with
  inline GIF previews, redacted failure messages and a fallback to artifact
  links.
- GIF previews published to an orphan `demoflow-previews` branch, rewritten as
  a single commit and pruned by age and per pull request.
- Fork pull requests: runs, artifact, summary and verdict work; the comment and
  the previews branch are skipped with a notice.
- Verdict step: the check fails when any scenario exited non-zero
  (`fail-on-error`), with one `::error::` annotation per failed scenario.
- Marketplace metadata: name `DemoFlow Demo Videos`, `film` icon, `purple` color.
- Release workflow that force-moves the major tag (`v1`) to the commit of a
  published `vX.Y.Z` release.

[Unreleased]: https://github.com/AndreyBegma/demoflow-action/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AndreyBegma/demoflow-action/releases/tag/v1.0.0
