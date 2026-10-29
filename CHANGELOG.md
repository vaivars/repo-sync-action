# Changelog

All notable changes to this project are documented in this file. It is generated from
[Conventional Commits](https://www.conventionalcommits.org) by [git-cliff](https://git-cliff.org).

## [Unreleased](https://github.com/vaivars/repo-sync-action/compare/v1.0.10...main)

### Features

- **Breaking:** Render templates with LiquidJS instead of Nunjucks (v2) ([#45](https://github.com/vaivars/repo-sync-action/pull/45))

### Bug Fixes

- Run git without a shell and keep the token out of .git/config ([#51](https://github.com/vaivars/repo-sync-action/pull/51))

### Documentation

- Describe how releases are made
- Regenerate CHANGELOG.md with git-cliff

### CI

- Lint the whole repo, format YAML, and lint workflows with actionlint and zizmor ([#46](https://github.com/vaivars/repo-sync-action/pull/46))
- Open a release PR from the Conventional Commits on main
- Publish the release when the release PR is merged

### Miscellaneous

- Restructure CI, Dependabot updates and tests ([#52](https://github.com/vaivars/repo-sync-action/pull/52))
- Configure git-cliff for the changelog and release notes

## [1.0.10](https://github.com/vaivars/repo-sync-action/compare/v1.0.9...v1.0.10) - 2026-10-29

### Bug Fixes

- Tolerate an existing sync branch when pushing with an installation token ([#41](https://github.com/vaivars/repo-sync-action/pull/41))
- Address codebase review findings ([#44](https://github.com/vaivars/repo-sync-action/pull/44))

### Documentation

- Rename to Repo Sync Action and restructure the README ([#43](https://github.com/vaivars/repo-sync-action/pull/43))

## [1.0.9](https://github.com/vaivars/repo-sync-action/compare/v1.0.8...v1.0.9) - 2026-02-26

### Bug Fixes

- Fix multi-group parsing in sync.yml specification ([#21](https://github.com/vaivars/repo-sync-action/pull/21))

## [1.0.8](https://github.com/vaivars/repo-sync-action/compare/v1.0.7...v1.0.8) - 2026-02-26

### Features

- Extend ORIGINAL_MESSAGE to also prepend the original commit body not just title ([#20](https://github.com/vaivars/repo-sync-action/pull/20))

## [1.0.7](https://github.com/vaivars/repo-sync-action/compare/v1.0.6...v1.0.7) - 2026-02-25

### Bug Fixes

- Fix state change not working

## [1.0.6](https://github.com/vaivars/repo-sync-action/compare/v1.0.5...v1.0.6) - 2026-02-25

### Features

- Rework PR message structure ([#19](https://github.com/vaivars/repo-sync-action/pull/19))

## [1.0.5](https://github.com/vaivars/repo-sync-action/compare/v1.0.4...v1.0.5) - 2026-02-25

### Features

- useOriginalMessage now works with multiple files changed ([#18](https://github.com/vaivars/repo-sync-action/pull/18))

### Miscellaneous

- **formatting:** Formatting

## [1.0.4](https://github.com/vaivars/repo-sync-action/compare/v1.0.3...v1.0.4) - 2026-02-24

### Miscellaneous

- **fix:** Adjust references

## [1.0.3](https://github.com/vaivars/repo-sync-action/compare/v1.0.2...v1.0.3) - 2026-02-24

### Features

- add blns text files for tests

### Bug Fixes

- Changed the logic to pass undefined (instead of false) to fs.copy when no exclusions are present
- sync execution logic and add local integration test

## [1.0.2](https://github.com/vaivars/repo-sync-action/compare/v1.0.1...v1.0.2) - 2026-02-24

### Bug Fixes

- remove dependency on node-readfiles

## [1.0.1](https://github.com/vaivars/repo-sync-action/releases/tag/v1.0.1) - 2026-02-24

### Features

- Add repository groups feature to hard fork ([#1](https://github.com/vaivars/repo-sync-action/pull/1))
- Modernize to Node.js 24 LTS and update dependencies ([#13](https://github.com/vaivars/repo-sync-action/pull/13))
- Add dprint for formatting/add copilot fix ([#17](https://github.com/vaivars/repo-sync-action/pull/17))

### Bug Fixes

- Update action.yml name/description
- don't minify index.js

Releases before the fork: [BetaHuhn/repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action/releases).
