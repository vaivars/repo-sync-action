import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
	formatChangedFiles,
	PR_BODY_MAX_LENGTH,
	PR_WARNING,
	prBody,
	prBranchName,
	prHead,
	renderPrBody,
	withoutPrWarning,
	withPrWarning,
} from '../src/pull-request.ts'

const options = {
	sourceRepository: 'owner/source',
	serverUrl: 'https://github.com',
	prBody: 'Extra:\n  - item',
	runId: '4321',
}

const FOOTER = '\n\n---\n\nThis PR was created automatically by the '
	+ '[repo-sync-action](https://github.com/vaivars/repo-sync-action) workflow run '
	+ '[#4321](https://github.com/owner/source/actions/runs/4321)'

const sections = [
	{
		header: 'From remote directory <code>a/</code>, synced the following files:',
		files: ['`1` - created', '`2` - updated'],
	},
	{
		header: 'From remote file <code>b</code>, synced the following files:',
		files: ['`b` - deleted'],
	},
]

describe('prBranchName', () => {
	test('puts the source repository name into the prefix and appends the branch', () => {
		assert.equal(
			prBranchName('repo-sync/SOURCE_REPO_NAME', 'owner/source', 'default'),
			'repo-sync/source/default',
		)
	})

	test('keeps a branch with slashes and drops dots at the start of a component', () => {
		assert.equal(
			prBranchName('sync/SOURCE_REPO_NAME/', 'owner/source', 'release/.v1'),
			'sync/source/release/v1',
		)
	})

	test('appends the timestamp when there is one', () => {
		assert.equal(prBranchName('sync', 'owner/source', 'main', 1700000000), 'sync/main-1700000000')
	})
})

describe('prHead', () => {
	test('names the fork owner with FORK, the repository owner otherwise', () => {
		assert.equal(prHead('forker', 'owner', 'sync/main'), 'forker:sync/main')
		assert.equal(prHead(false, 'owner', 'sync/main'), 'owner:sync/main')
		assert.equal(prHead(undefined, 'owner', 'sync/main'), 'owner:sync/main')
	})
})

describe('PR warning', () => {
	test('goes on top of the body, which keeps its indentation', () => {
		assert.equal(withPrWarning('Line\n  indented'), `${PR_WARNING}\n\nLine\n  indented`)
	})

	test('treats a missing body as empty', () => {
		assert.equal(withPrWarning(null), `${PR_WARNING}\n\n`)
		assert.equal(withoutPrWarning(null), '')
	})

	test('comes off again', () => {
		assert.equal(withoutPrWarning(withPrWarning('Body')), '\n\nBody')
		assert.equal(withoutPrWarning('Body'), 'Body')
	})
})

describe('renderPrBody', () => {
	test('puts the description, PR_BODY and the changed files around the link to the run', () => {
		assert.equal(
			renderPrBody('<files>', 'Body\n    code', options),
			'Body\n    code\n\nsynced local file(s) with [owner/source](https://github.com/owner/source).'
				+ '\n\nExtra:\n  - item\n\n<files>'
				+ FOOTER,
		)
	})

	test('leaves out an empty description', () => {
		assert.equal(
			renderPrBody('', '', { ...options, prBody: '' }),
			'synced local file(s) with [owner/source](https://github.com/owner/source).\n\n\n\n'
				+ FOOTER,
		)
	})
})

describe('prBody', () => {
	test('lists the changed files of each source', () => {
		assert.equal(
			prBody(sections, undefined, options),
			renderPrBody(formatChangedFiles(sections), undefined, options),
		)
	})

	test("shortens the file list so that the body and the warning fit GitHub's limit", () => {
		const many = [{
			header: 'From remote directory <code>big/</code>:',
			files: Array.from({ length: 5000 }, (_, i) => `\`some/nested/file-${i}.txt\` - unchanged`),
		}]

		const body = prBody(many, 'Line one\nLine two', { ...options, prBody: 'x'.repeat(1000) })

		assert.ok(withPrWarning(body).length <= PR_BODY_MAX_LENGTH, `body is ${body.length} characters`)
		assert.match(body, /\n\.\.\.and \d+ more<\/li>\n<\/ul>\n<\/details>\n\n---\n/)
	})
})

describe('formatChangedFiles', () => {
	test('renders nothing without sections', () => {
		assert.equal(formatChangedFiles([]), '')
	})

	test('renders all files when they fit', () => {
		assert.equal(
			formatChangedFiles(sections),
			'<details>\n<summary>Changed files</summary>\n<ul>\n'
				+ '<li>From remote directory <code>a/</code>, synced the following files:\n\n'
				+ '`1` - created\n`2` - updated</li>'
				+ '<li>From remote file <code>b</code>, synced the following files:\n\n`b` - deleted</li>'
				+ '\n</ul>\n</details>',
		)
	})

	test('sums up the files that do not fit', () => {
		const full = formatChangedFiles(sections)
		const text = formatChangedFiles(sections, full.length - 1)

		assert.ok(text.length <= full.length - 1)
		assert.match(text, /\.\.\.and [1-3] more<\/li>\n<\/ul>\n<\/details>$/)
	})

	test('ends a section with the number of its files that did not change', () => {
		const section = (unchanged?: number) =>
			formatChangedFiles([{ header: 'H', files: ['`a` - created'], unchanged }])
		const list = (lines: string) =>
			`<details>\n<summary>Changed files</summary>\n<ul>\n<li>H\n\n${lines}</li>\n</ul>\n</details>`

		assert.equal(section(undefined), list('`a` - created'))
		assert.equal(section(0), list('`a` - created'))
		assert.equal(section(1), list('`a` - created\n...and 1 unchanged file'))
		assert.equal(section(3), list('`a` - created\n...and 3 unchanged files'))
	})

	test('counts only changed files in the files it sums up', () => {
		const withUnchanged = [
			{ header: 'H1', files: ['`1` - created', '`2` - created'], unchanged: 5 },
			{ header: 'H2', files: ['`3` - created'], unchanged: 2 },
		]
		const start =
			'<details>\n<summary>Changed files</summary>\n<ul>\n<li>H1\n\n`1` - created\n`2` - created'
		const end = '\n...and 1 more</li>\n</ul>\n</details>'
		const fits = `${start}\n...and 5 unchanged files${end}`
		// What it keeps free for the last line, "<li>...and 3 more</li>", is longer than the line
		// "\n...and 1 more</li>" that ends this list
		const room = '<li>'.length - '\n'.length

		assert.equal(formatChangedFiles(withUnchanged, fits.length + room), fits)
		// The unchanged line goes when it does not fit
		assert.equal(formatChangedFiles(withUnchanged, fits.length + room - 1), `${start}${end}`)
	})

	test('sums up all files when not even the first header fits', () => {
		assert.equal(
			formatChangedFiles(sections, 10),
			'<details>\n<summary>Changed files</summary>\n<ul>\n<li>...and 3 more</li>\n</ul>\n</details>',
		)
	})
})
