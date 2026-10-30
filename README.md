# Repo Sync Action

Keep files and directories in sync across GitHub repositories.

On each run the action copies the files listed in `.github/sync.yml` into every target repository
and opens a pull request there with the changes (or updates the one it opened before).

## Quick start

1. Create a token (see [Authentication](#authentication)) and store it as a repository secret, for
   example `GH_PAT`.

2. Add a workflow:

   **.github/workflows/repo-sync.yml**

   ```yml
   name: Repo Sync
   on:
     push:
       branches: [main]
     workflow_dispatch:

   jobs:
     sync:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: vaivars/repo-sync-action@v2
           with:
             GH_PAT: ${{ secrets.GH_PAT }}
   ```

3. List what to sync where:

   **.github/sync.yml**

   ```yml
   owner/repo-a:
     - .github/workflows/lint.yml
     - LICENSE

   owner/repo-b:
     - source: shared/stale.yml
       dest: .github/workflows/stale.yml
   ```

## Authentication

`GITHUB_TOKEN` can only access the repository the workflow runs in, so the action needs a token
with access to every target repository.

| Token                         | Input                                    | Access needed on each target repository                                                                                                      |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Classic personal access token | `GH_PAT`                                 | `repo` scope, plus `workflow` to sync files under `.github/workflows/`                                                                       |
| Fine-grained access token     | `GH_PAT` with `IS_FINE_GRAINED: true`    | Contents and Pull requests: read and write. Workflows: read and write to sync workflow files                                                 |
| GitHub App installation token | `GH_INSTALLATION_TOKEN` (`GH_PAT` unset) | Contents: read and write. Metadata: read. Pull requests: read and write (unless `SKIP_PR`). Workflows: read and write to sync workflow files |

Commits are authored by the `GH_PAT` owner unless you set both `GIT_USERNAME` and `GIT_EMAIL`. With
an installation token, commits are created through the GitHub API and attributed to the App.

An installation token can be created in an earlier step, for example with
`actions/create-github-app-token`.

## Sync configuration

### Targets

Each top-level key is a target repository:

```yml
owner/repo: # default branch
  - LICENSE

owner/repo@develop: # a specific branch
  - LICENSE

https://github.example.com/owner/repo: # another host
  - LICENSE
```

- The same repository can be listed with different branches, including the repository the workflow
  runs in. This is how you sync one branch to others.
- If a repository appears more than once (as a key or in [groups](#groups)), its file lists are
  combined.
- Targets on another host only work with `SKIP_PR: true`, because pull requests are always created
  through the API of the GitHub instance the workflow runs on. On a GitHub Enterprise Server runner,
  plain `owner/repo` already points at that server.

### Files

An entry is either a path, which is synced to the same path in the target, or an object:

| Key              | Description                                                                                                                          | Default          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `source`         | File or directory in this repository                                                                                                 | required         |
| `dest`           | Path in the target repository                                                                                                        | same as `source` |
| `exclude`        | Directories only. Paths relative to `source` to skip, one per line in a block string (`\|`). End a path with `/` to skip a directory | none             |
| `deleteOrphaned` | Directories only. Delete files in `dest` that don't exist in `source`                                                                | `false`          |
| `replace`        | Set to `false` to leave `dest` untouched if it already exists. For a directory, this skips the whole directory                       | `true`           |
| `template`       | Render the file(s) as a [template](#templates): `true`, or an object of variables                                                    | `false`          |

```yml
owner/repo:
  - .gitignore
  - source: shared/workflows/
    dest: .github/workflows/
    exclude: |
      node.yml
      experimental/
    deleteOrphaned: true
  - source: shared/CODEOWNERS
    dest: .github/CODEOWNERS
    replace: false
```

### Templates

Templates use [Liquid](https://liquidjs.com/tutorials/intro-to-liquid.html) syntax:

```yml
owner/repo:
  - source: templates/CODEOWNERS
    dest: .github/CODEOWNERS
    template:
      team: '@my-org/platform'
```

**templates/CODEOWNERS**

```text
* {{ team }}
```

- Use `template: true` for templates without variables.
- `{% layout %}`, `{% include %}` and `{% render %}` paths that start with `./` are resolved relative
  to the template. Other paths are relative to the working directory, normally the root of the
  checked-out repository.
- Templates are sandboxed. They can't access JavaScript objects or read files outside the working
  directory, inside `.git` directories or in `TMP_DIR`. Unknown tags and filters fail the run, and
  parsing, memory use and render time are limited.
- Values are inserted as they are, without HTML escaping, and arrays print comma separated. Use
  `| escape` where you need escaping.
- Empty strings and `0` are false in conditions.
- Whitespace is kept as written. Use `{%-` and `-%}` to trim it around tags.
- GitHub Actions expressions like `${{ secrets.TOKEN }}` use the same braces as Liquid. Wrap them in
  `{% raw %}…{% endraw %}` to keep them in a templated workflow file. `{% endraw %}` can't take a
  `-`.

### Groups

`group` syncs the same files to several repositories. It takes a single group or a list of them:

```yml
group:
  - repos: |
      owner/repo-a
      owner/repo-b@develop
    files:
      - source: shared/workflows/
        dest: .github/workflows/

  - repos: |
      owner/repo-c
    files:
      - LICENSE
```

### Repository groups

`repo_groups` names a list of repositories once, so groups can refer to it by name:

```yml
repo_groups:
  backend:
    - owner/api
    - owner/worker
  frontend:
    - owner/web

group:
  - repos: backend
    files:
      - .github/workflows/test.yml

  - repos: |
      backend
      frontend
      owner/docs
    files:
      - LICENSE
```

`repos` accepts a repository group name, or a block string (`|`) with one repository or group name
per line. A YAML list in `repos` is used as-is, and its entries are not expanded as group names.

## Pull requests and commits

For each target repository the action:

1. Clones the target branch and creates the branch `repo-sync/<source-repo>/<target-branch>`.
   `<target-branch>` is the `@branch` of the target, or `default`. Change the first part with
   `BRANCH_PREFIX`.
2. Commits the synced files. By default each file entry gets its own commit, such as
   `🔄 synced local '<dest>' with remote '<source>'`. With `COMMIT_EACH_FILE: false` everything goes
   into one commit, `🔄 synced file(s) with <owner>/<source-repo>`.
3. Opens a pull request titled `🔄 synced file(s) with <owner>/<source-repo>` and labelled `sync`.
   If a sync pull request from an earlier run is still open, it's updated instead. Set
   `OVERWRITE_EXISTING_PR: false` to open a new one each run. The pull request lists the files that
   each file entry creates, updates, deletes or renames.

Alternatives to this flow:

- `SKIP_PR: true` commits straight to the target branch and opens no pull request.
- `FORK: <account>` pushes the branch to a fork under that account and opens the pull request from
  the fork. The token must belong to that account. Labels, assignees, reviewers and auto-merge
  aren't applied in this mode.

`SKIP_PR` and `FORK` can't be used together, and the run fails if both are set.

### Auto-merge

`PR_AUTOMERGE: true` enables [auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
on the pull request after the labels, assignees and reviewers are added, so GitHub merges it once
its required checks and reviews pass. `PR_AUTOMERGE_METHOD` picks `merge` (the default), `squash` or
`rebase`. With a merge queue, the queue's own method is used.

- Each target repository needs **Allow auto-merge** turned on in its settings, and the chosen merge
  method allowed. Otherwise the run fails for that repository after opening the pull request.
- Auto-merge waits only for what a branch protection rule or ruleset of the target branch requires.
  When it requires no checks or reviews, or they have already passed, the action merges the pull
  request right away, even while checks that aren't required are still running or have failed.
- The token needs the access it already has to open the pull request: classic tokens `repo`,
  fine-grained and App tokens write access to contents and pull requests.

A workflow step that customizes the pull request:

```yml
- uses: vaivars/repo-sync-action@v2
  with:
    GH_PAT: ${{ secrets.GH_PAT }}
    PR_LABELS: |
      sync
      dependencies
    PR_AUTOMERGE: true
    PR_AUTOMERGE_METHOD: squash
    ASSIGNEES: octocat
    TEAM_REVIEWERS: platform
    PR_BODY: Synced from the shared configuration repository.
    COMMIT_BODY: 'Change-type: patch'
```

## Inputs

One of `GH_PAT` or `GH_INSTALLATION_TOKEN` is required. All other inputs are optional.

| Input                   | Description                                                                                                                 | Default                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GH_PAT`                | Personal access token, classic or fine-grained                                                                              |                                      |
| `GH_INSTALLATION_TOKEN` | GitHub App installation token, used when `GH_PAT` isn't set                                                                 |                                      |
| `IS_FINE_GRAINED`       | Set to `true` when `GH_PAT` is a fine-grained token                                                                         | `false`                              |
| `CONFIG_PATH`           | Path to the sync configuration                                                                                              | `.github/sync.yml`                   |
| `PR_LABELS`             | Pull request labels, one per line. `false` adds none                                                                        | `sync`                               |
| `PR_BODY`               | Extra text for the pull request description                                                                                 |                                      |
| `ASSIGNEES`             | Users to assign to the pull request, one per line                                                                           |                                      |
| `REVIEWERS`             | Users to request a review from, one per line                                                                                |                                      |
| `TEAM_REVIEWERS`        | Teams to request a review from, one per line                                                                                |                                      |
| `PR_AUTOMERGE`          | Enable [auto-merge](#auto-merge) on the pull request. Not applied with `FORK`                                               | `false`                              |
| `PR_AUTOMERGE_METHOD`   | How `PR_AUTOMERGE` merges: `merge`, `squash` or `rebase`                                                                    | `merge`                              |
| `COMMIT_PREFIX`         | Prefix for commit messages and the pull request title                                                                       | `🔄`                                 |
| `COMMIT_BODY`           | Text appended to every commit message after a blank line                                                                    |                                      |
| `COMMIT_EACH_FILE`      | One commit per file entry instead of one commit for everything                                                              | `true`                               |
| `ORIGINAL_MESSAGE`      | When a push of a single commit triggers the run, reuse its message for commits and its body as the pull request description | `false`                              |
| `COMMIT_AS_PR_TITLE`    | With `ORIGINAL_MESSAGE`, use the first line of that message as the pull request title                                       | `false`                              |
| `GIT_USERNAME`          | Commit author name                                                                                                          | `GH_PAT` owner                       |
| `GIT_EMAIL`             | Commit author email                                                                                                         | `GH_PAT` owner                       |
| `BRANCH_PREFIX`         | Prefix for the pull request branch. `SOURCE_REPO_NAME` is replaced with the source repository name                          | `repo-sync/SOURCE_REPO_NAME`         |
| `OVERWRITE_EXISTING_PR` | Update an open sync pull request instead of opening a new one                                                               | `true`                               |
| `SKIP_PR`               | Commit straight to the target branch without a pull request. Can't be used together with `FORK`                             | `false`                              |
| `FORK`                  | Account whose fork the changes are pushed to before opening the pull request. Can't be used together with `SKIP_PR`         |                                      |
| `DRY_RUN`               | Do everything except push and open pull requests                                                                            | `false`                              |
| `TMP_DIR`               | Working directory for the clones. Files in it are never synced or read by templates                                         | `$RUNNER_TEMP/repo-sync-<timestamp>` |
| `SKIP_CLEANUP`          | Keep `TMP_DIR` after the run                                                                                                | `false`                              |

### Outputs

| Output              | Description                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request_urls` | JSON array of the URLs of pull requests created or updated in this run. Not set if there were none. Read it with `fromJSON(...)` |

## Versioning

Use `@v2` for the latest 2.x release, or pin an exact release tag (`@v2.x.y`) or a commit SHA.
Each release lists its changes in the [changelog](CHANGELOG.md) and on the
[releases page](https://github.com/vaivars/repo-sync-action/releases).

v1 is deprecated and no longer updated. Its final release is `v1.0.10`.

## Migrating from v1

v2 renders templates with LiquidJS instead of Nunjucks, because Nunjucks templates can run any
JavaScript with the action's token. Inputs and the rest of `sync.yml` are unchanged.

Plain `{{ variable }}` output is unchanged. Tags, filters and expressions need these changes:

| v1 (Nunjucks)                          | v2 (Liquid)                                           |
| -------------------------------------- | ----------------------------------------------------- |
| `{% extends './base.yml' %}`           | `{% layout './base.yml' %}`                           |
| `{% set x = 1 %}`                      | `{% assign x = 1 %}`                                  |
| `{# comment #}`                        | `{% comment %}…{% endcomment %}` or `{% # comment %}` |
| `{{ a + b }}`                          | `{{ a \| plus: b }}`                                  |
| `{{ a if cond else b }}`               | `{% if cond %}{{ a }}{% else %}{{ b }}{% endif %}`    |
| `{% if x is defined %}`                | `{% if x != nil %}`                                   |
| `{% if x in list %}`                   | `{% if list contains x %}`                            |
| `{% for i in range(3) %}`              | `{% for i in (0..2) %}`                               |
| `loop.index`, `loop.first`             | `forloop.index`, `forloop.first`                      |
| `{{ s \| upper }}`, `{{ s \| lower }}` | `{{ s \| upcase }}`, `{{ s \| downcase }}`            |
| `{{ list \| length }}`                 | `{{ list \| size }}`                                  |
| `{{ x \| default('y') }}`              | `{{ x \| default: 'y' }}`                             |
| `{% macro %}`                          | `{% render './partial.txt', arg: value %}`            |
| `{{ x \| safe }}`                      | `{{ x }}`                                             |

Unknown tags and filters fail the run with an error. These don't, and render differently without
any error, so search your templates for them before upgrading:

- **Inline `if`:** `{{ a if cond else b }}` always renders `a`.
- **`is defined` / `is not defined`:** the test is ignored, so `{% if x is not defined %}` is true
  when `x` _is_ set.
- **`in`:** `{% if x in list %}` is always true.
- **`range()` and `loop.*`:** render nothing.
- **`{# comments #}`:** are copied into the output as text.
- **`==`:** compares strictly, so `version: 1` from `sync.yml` doesn't equal `"1"`.
- **`default`:** replaces `false`, `0` and empty strings too. In v1 it only replaced missing
  values.
- **Whitespace:** v1 removed the line break after block tags and the indentation before them. v2
  keeps it; trim it with `{%-` and `-%}`.

## Development

Bug reports go to [issues](https://github.com/vaivars/repo-sync-action/issues), and questions
and ideas to [discussions](https://github.com/vaivars/repo-sync-action/discussions). Pull requests
are welcome.

The tooling is managed with [mise](https://mise.jdx.dev):

```sh
mise run install       # install dependencies
mise run lint          # eslint
mise run typecheck     # tsc on src/ and tests/
mise run lint:actions  # actionlint, zizmor and shellcheck on the workflows and scripts
mise run format        # dprint
mise run test          # build, then run the unit and local integration tests
mise run build         # bundle src/ into dist/
mise run ci            # everything CI checks
```

The source in `src/` and the tests in `tests/` are TypeScript, which Node 24 runs directly: `npm start`
runs `src/index.ts`, and `node --test 'tests/*.test.ts'` the tests. The action runs the bundled
`dist/index.js`. Rebuild and commit `dist/` together with every change to `src/`.

Releases are made from the [Conventional Commits](https://www.conventionalcommits.org) on `main`:
a breaking change (`feat!:`) bumps the major version, `feat:` the minor and other commits the
patch, while dependency updates alone don't make a release. Every push to `main` opens or updates a
release PR that sets the version and regenerates `CHANGELOG.md` with
[git-cliff](https://git-cliff.org), and merging it tags `vX.Y.Z`, moves `vX` and publishes the
GitHub release. `scripts/release-pr.sh` previews the next release locally without changing anything.

## Credits

Originally created by Maximilian Schiller ([@BetaHuhn](https://github.com/BetaHuhn)). Inspired by
`varunsridharan/action-github-workflow-sync` and `adrianjost/files-sync-action`.

## License

MIT. See [LICENSE](LICENSE).

---

> **Note**: This project originally started as a hard fork of
> [BetaHuhn/repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action).
