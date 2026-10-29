#!/usr/bin/env bash
# Opens or updates the release PR. git-cliff computes the next version from the Conventional
# Commits since the last vX.Y.Z tag. This sets package.json to it, regenerates CHANGELOG.md, commits
# that on top of main to the release branch and opens a PR from it, labelled release. Merging the
# PR runs release.yml, which tags and publishes the release.
#
#   scripts/release-pr.sh            prints the release PR it would open, and changes nothing
#   DRY_RUN=0 scripts/release-pr.sh  commits, force-pushes the branch and opens or updates the PR
#
# DRY_RUN=0 runs in CI, with GITHUB_REPOSITORY and GH_TOKEN (contents, pull-requests and actions
# write) set.
set -euo pipefail
export RUST_LOG="${RUST_LOG:-error}"

dry_run="${DRY_RUN:-1}"
base=main
branch=release
label=release

last_tag=$(git tag --list 'v*' --merged HEAD | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -n 1)
if [ -z "$last_tag" ]; then
	echo '::error::No vX.Y.Z tag in the history of HEAD to bump the version from'
	exit 1
fi

# A merged release PR that release.yml hasn't tagged yet. Its tag will be the base for the next one
pending=$(git log --format=%s "$last_tag..HEAD" | { grep -oE '^chore: release v[0-9]+\.[0-9]+\.[0-9]+' || true; })
if [ -n "$pending" ]; then
	echo "::notice::'$(head -n 1 <<<"$pending")' isn't tagged yet, so this waits for its release." \
		'If the Release workflow failed, run it again or start it with that version'
	exit 0
fi

# git-cliff prints the last tag again when no commit since it is releasable, e.g. only chore(deps)
version=$(git cliff --bumped-version)
if git rev-parse --quiet --verify "refs/tags/$version" >/dev/null; then
	echo "::notice::Nothing to release since $last_tag"
	exit 0
fi

notes=$(git cliff --unreleased --tag "$version" --strip all)
title="chore: release $version"
body="Merging this PR tags \`$version\`, moves \`${version%%.*}\` to it and publishes the GitHub release.

$notes"

if [ "$dry_run" != 0 ]; then
	echo "Version: $version (last release $last_tag)"
	echo "Branch:  $branch = $(git rev-parse --short HEAD) + '$title'"
	echo "PR:      $branch -> $base, '$title', labelled $label"
	echo
	echo "$notes"
	exit 0
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set, e.g. vaivars/repo-sync-action}"
base_sha=$(git rev-parse HEAD)

npm version "${version#v}" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null
git cliff --tag "$version" --output CHANGELOG.md
git switch --quiet --force-create "$branch"
git add package.json package-lock.json CHANGELOG.md
git -c user.name='github-actions[bot]' \
	-c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
	commit --quiet -m "$title"

gh auth setup-git
# A re-run with nothing new finds this exact commit content on the branch already
pushed=false
if git fetch --quiet origin "refs/heads/$branch" 2>/dev/null &&
	[ "$(git rev-parse 'FETCH_HEAD^{tree}')" = "$(git rev-parse 'HEAD^{tree}')" ] &&
	[ "$(git rev-parse 'FETCH_HEAD^')" = "$base_sha" ]; then
	echo "::notice::$branch already has $version on $base_sha"
else
	git push --force origin "HEAD:refs/heads/$branch"
	pushed=true
fi

if ! gh api "repos/$GITHUB_REPOSITORY/labels/$label" --silent 2>/dev/null; then
	gh label create "$label" --repo "$GITHUB_REPOSITORY" --color '0e8a16' \
		--description 'Merging this PR publishes a release'
fi

# Only a PR from this repository's own release branch, never one from a fork
number=$(gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&base=$base&head=${GITHUB_REPOSITORY%%/*}:$branch" \
	--jq '.[0].number // empty')
if [ -n "$number" ]; then
	gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$number" -f title="$title" -f body="$body" --silent
	echo "::notice::Updated #$number for $version"
else
	number=$(gh api "repos/$GITHUB_REPOSITORY/pulls" -f base="$base" -f head="$branch" \
		-f title="$title" -f body="$body" --jq .number)
	echo "::notice::Opened #$number for $version"
fi
gh api "repos/$GITHUB_REPOSITORY/issues/$number/labels" -f "labels[]=$label" --silent

# Pushes and PRs made with GITHUB_TOKEN don't trigger workflows, so start CI for the release commit
if [ "$pushed" = true ]; then
	gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$branch"
fi
