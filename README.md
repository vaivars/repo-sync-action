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
         - uses: vaivars/repo-sync-action@v1
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

Templates are rendered with [Nunjucks](https://mozilla.github.io/nunjucks/templating.html), which
uses Jinja-style syntax:

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
- `{% extends './base.yml' %}` and `{% include %}` paths that start with `./` are resolved relative
  to the template.
- GitHub Actions expressions like `${{ secrets.TOKEN }}` use the same braces as Nunjucks. Wrap them
  in `{% raw %}…{% endraw %}` to keep them in a templated workflow file.

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
   `OVERWRITE_EXISTING_PR: false` to open a new one each run.

Alternatives to this flow:

- `SKIP_PR: true` commits straight to the target branch and opens no pull request.
- `FORK: <account>` pushes the branch to a fork under that account and opens the pull request from
  the fork. The token must belong to that account. Labels, assignees and reviewers aren't applied in
  this mode.

A workflow step that customizes the pull request:

```yml
- uses: vaivars/repo-sync-action@v1
  with:
    GH_PAT: ${{ secrets.GH_PAT }}
    PR_LABELS: |
      sync
      automerge
    ASSIGNEES: octocat
    TEAM_REVIEWERS: platform
    PR_BODY: Synced from the shared configuration repository.
    COMMIT_BODY: 'Change-type: patch'
```

## Inputs

One of `GH_PAT` or `GH_INSTALLATION_TOKEN` is required. All other inputs are optional.

| Input                   | Description                                                                                                                 | Default                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `GH_PAT`                | Personal access token, classic or fine-grained                                                                              |                              |
| `GH_INSTALLATION_TOKEN` | GitHub App installation token, used when `GH_PAT` isn't set                                                                 |                              |
| `IS_FINE_GRAINED`       | Set to `true` when `GH_PAT` is a fine-grained token                                                                         | `false`                      |
| `CONFIG_PATH`           | Path to the sync configuration                                                                                              | `.github/sync.yml`           |
| `PR_LABELS`             | Pull request labels, one per line. `false` adds none                                                                        | `sync`                       |
| `PR_BODY`               | Extra text for the pull request description                                                                                 |                              |
| `ASSIGNEES`             | Users to assign to the pull request, one per line                                                                           |                              |
| `REVIEWERS`             | Users to request a review from, one per line                                                                                |                              |
| `TEAM_REVIEWERS`        | Teams to request a review from, one per line                                                                                |                              |
| `COMMIT_PREFIX`         | Prefix for commit messages and the pull request title                                                                       | `🔄`                         |
| `COMMIT_BODY`           | Text appended to every commit message after a blank line                                                                    |                              |
| `COMMIT_EACH_FILE`      | One commit per file entry instead of one commit for everything                                                              | `true`                       |
| `ORIGINAL_MESSAGE`      | When a push of a single commit triggers the run, reuse its message for commits and its body as the pull request description | `false`                      |
| `COMMIT_AS_PR_TITLE`    | With `ORIGINAL_MESSAGE`, use the first line of that message as the pull request title                                       | `false`                      |
| `GIT_USERNAME`          | Commit author name                                                                                                          | `GH_PAT` owner               |
| `GIT_EMAIL`             | Commit author email                                                                                                         | `GH_PAT` owner               |
| `BRANCH_PREFIX`         | Prefix for the pull request branch. `SOURCE_REPO_NAME` is replaced with the source repository name                          | `repo-sync/SOURCE_REPO_NAME` |
| `OVERWRITE_EXISTING_PR` | Update an open sync pull request instead of opening a new one                                                               | `true`                       |
| `SKIP_PR`               | Commit straight to the target branch without a pull request                                                                 | `false`                      |
| `FORK`                  | Account whose fork the changes are pushed to before opening the pull request                                                |                              |
| `DRY_RUN`               | Do everything except push and open pull requests                                                                            | `false`                      |
| `TMP_DIR`               | Working directory for the clones                                                                                            | `tmp-<timestamp>`            |
| `SKIP_CLEANUP`          | Keep `TMP_DIR` after the run                                                                                                | `false`                      |

### Outputs

| Output              | Description                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request_urls` | JSON array of the URLs of pull requests created or updated in this run. Not set if there were none. Read it with `fromJSON(...)` |

## Versioning

Use `@v1` for the latest 1.x release, or pin an exact release tag (`@v1.x.y`) or a commit SHA.

## Development

Bug reports go to [issues](https://github.com/vaivars/repo-sync-action/issues), and questions
and ideas to [discussions](https://github.com/vaivars/repo-sync-action/discussions). Pull requests
are welcome.

The tooling is managed with [mise](https://mise.jdx.dev):

```sh
mise run install  # install dependencies
mise run lint     # eslint
mise run format   # dprint
mise run test     # build, then run the unit and local integration tests
mise run build    # bundle src/ into dist/
```

The action runs the bundled `dist/index.js`. Rebuild and commit `dist/` together with every change
to `src/`.

## Credits

Originally created by Maximilian Schiller ([@BetaHuhn](https://github.com/BetaHuhn)). Inspired by
`varunsridharan/action-github-workflow-sync` and `adrianjost/files-sync-action`.

## License

MIT. See [LICENSE](LICENSE).

---

> **Note**: This project originally started as a hard fork of
> [BetaHuhn/repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action).
