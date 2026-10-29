#!/usr/bin/env bash
# Publishes a merged release PR: tags the release commit vX.Y.Z, creates the GitHub release with its
# git-cliff notes and moves the major tag (v2) to it. A step that is already done is skipped, so a
# failed run can be re-run.
#
#   scripts/release.sh                prints the release of HEAD, at its package.json version
#   VERSION=2.0.0 scripts/release.sh  the same for the "chore: release v2.0.0" commit before HEAD
#   DRY_RUN=0 ...                     tags, pushes and publishes it
#
# DRY_RUN=0 runs in CI with GH_TOKEN (contents write) and GITHUB_REPOSITORY set.
set -euo pipefail
export RUST_LOG="${RUST_LOG:-error}"

dry_run="${DRY_RUN:-1}"
semver='^v[0-9]+\.[0-9]+\.[0-9]+$'

version_tags() {
	git tag --list 'v*' "$@" | { grep -E "$semver" || true; } | sort -V
}

if [ -n "${VERSION:-}" ]; then
	# Find the release commit on HEAD's history. A squash merge appends the PR number to it
	VERSION="v${VERSION#v}"
	if [[ ! "$VERSION" =~ $semver ]]; then
		echo "::error::VERSION must look like 1.2.3, not ${VERSION#v}"
		exit 1
	fi
	subject="^[0-9a-f]+ chore: release ${VERSION//./\\.}( |\$)"
	commits=$(git log --format='%H %s' HEAD | { grep -E "$subject" || true; } | cut -d ' ' -f 1)
	count=$(grep -c . <<<"$commits" || true)
	if [ "$count" != 1 ]; then
		echo "::error::Expected one 'chore: release $VERSION' commit in the history of HEAD, found $count"
		exit 1
	fi
	sha=$commits
else
	sha=$(git rev-parse HEAD)
fi

tag="v$(git show "$sha:package.json" | jq -r .version)"
if [[ ! "$tag" =~ $semver ]]; then
	echo "::error::package.json at $sha has no X.Y.Z version"
	exit 1
fi
if [ -n "${VERSION:-}" ] && [ "$tag" != "$VERSION" ]; then
	echo "::error::package.json at $sha is ${tag#v}, not ${VERSION#v}"
	exit 1
fi
major="${tag%%.*}"

# An existing tag must be this commit. Otherwise the version wasn't bumped, so don't release it
tagged=$(git rev-parse --quiet --verify "refs/tags/$tag^{commit}" || true)
if [ -n "$tagged" ] && [ "$tagged" != "$sha" ]; then
	echo "::error::$tag already tags $tagged, not $sha"
	exit 1
fi

previous=$(version_tags --merged "$sha^" | tail -n 1)
if [ -z "$previous" ]; then
	echo "::error::No vX.Y.Z tag before $sha to take the release notes from"
	exit 1
fi
notes=$(git cliff "$previous..$sha" --tag "$tag" --strip all)

# Mark it latest unless a higher version is already released, as for a backport
highest=$({
	version_tags
	echo "$tag"
} | sort -V | tail -n 1)
make_latest=$([ "$highest" = "$tag" ] && echo true || echo false)

if [ "$dry_run" != 0 ]; then
	echo "Commit:  $sha"
	echo "Tag:     $tag$([ -n "$tagged" ] && echo ' (exists)'), after $previous"
	echo "Release: $tag, latest: $make_latest"
	echo "Major:   $major"
	echo
	echo "$notes"
	exit 0
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set, e.g. vaivars/repo-sync-action}"
gh auth setup-git

if [ -z "$tagged" ]; then
	git tag "$tag" "$sha"
fi
# A no-op when the remote tag is already this commit. Rejected when it is another one
git push origin "refs/tags/$tag"

if gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json tagName >/dev/null 2>&1; then
	echo "::notice::Release $tag already exists"
else
	gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" \
		--latest="$make_latest" --notes-file - <<<"$notes"
fi

# Releases made with GITHUB_TOKEN don't trigger workflows, so the major tag moves here, not on a
# release event. Only move forward, so a backport release doesn't pull the major tag back
latest=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$major." --paginate \
	--jq '.[].ref | ltrimstr("refs/tags/")' | { grep -E "$semver" || true; } | sort -V | tail -n 1)
if [ "$latest" != "$tag" ]; then
	echo "::notice::$latest is newer than $tag, leaving $major alone"
	exit 0
fi

sha=$(gh api "repos/$GITHUB_REPOSITORY/commits/$tag" --jq .sha)
# git/ref (singular) matches exactly; git/refs would also match v2.0.0 when v2 is missing
if gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$major" --silent 2>/dev/null; then
	gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/$major" -f sha="$sha" -F force=true --silent
else
	gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$major" -f sha="$sha" --silent
fi
echo "::notice::Moved $major to $tag ($sha)"
