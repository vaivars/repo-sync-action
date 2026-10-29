import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
	hasStatusChanges,
	parseGitDiffOutput,
	parseNameStatus,
	parseStatus,
	parseTreeDiff,
	parseTreeId,
} from '../src/git-output.ts'

describe('parseGitDiffOutput', () => {
	test('maps each changed and removed file to its diff, and leaves out binary files', () => {
		const output = [
			'diff --git a/a.txt b/a.txt',
			'index 1111111..2222222 100644',
			'--- a/a.txt',
			'+++ b/a.txt',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'diff --git a/gone.txt b/gone.txt',
			'deleted file mode 100644',
			'index 3333333..0000000',
			'--- a/gone.txt',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-gone',
			'diff --git a/bin.dat b/bin.dat',
			'index 4444444..5555555 100644',
			'Binary files a/bin.dat and b/bin.dat differ',
		].join('\n')

		assert.deepEqual(parseGitDiffOutput(output), {
			'a.txt': '@@ -1 +1 @@\n-old\n+new',
			'gone.txt': '@@ -1 +0,0 @@\n-gone',
		})
	})

	test('finds no files in empty output', () => {
		assert.deepEqual(parseGitDiffOutput(''), {})
	})
})

describe('parseNameStatus', () => {
	test('reads changes and renames, with their paths verbatim', () => {
		const output = 'M\0conf/change.txt\0'
			+ 'R100\0conf/old place.txt\0conf/dir with space/new place.txt\0'
			+ 'R087\0conf/a\nb.txt\0conf/ünï.txt\0'
			+ 'D\0conf/gone.txt\0A\0 leading space.txt\0T\0conf/link\0'

		assert.deepEqual(parseNameStatus(output), [
			{ status: 'M', path: 'conf/change.txt' },
			{ status: 'R100', from: 'conf/old place.txt', path: 'conf/dir with space/new place.txt' },
			{ status: 'R087', from: 'conf/a\nb.txt', path: 'conf/ünï.txt' },
			{ status: 'D', path: 'conf/gone.txt' },
			{ status: 'A', path: ' leading space.txt' },
			{ status: 'T', path: 'conf/link' },
		])
	})

	test('finds no changes in empty output', () => {
		assert.deepEqual(parseNameStatus(''), [])
	})
})

describe('parseTreeId', () => {
	test('reads the tree header of a commit', () => {
		const output = [
			'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
			'parent 0123456789012345678901234567890123456789',
			'author A <a@example.com> 1700000000 +0000',
			'committer A <a@example.com> 1700000000 +0000',
			'',
			'tree in the message',
		].join('\n')

		assert.equal(parseTreeId(output), '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
	})
})

describe('parseTreeDiff', () => {
	test('reads NUL-separated entries with their paths verbatim', () => {
		const output = ':100644 000000 aaa 000 D\0dir with space/new.txt\0'
			+ ':100755 100644 bbb ccc M\0ünï\ncödé\0'

		assert.deepEqual(parseTreeDiff(output), [
			{
				newMode: '100644',
				previousMode: '000000',
				newBlob: 'aaa',
				previousBlob: '000',
				change: 'D',
				path: 'dir with space/new.txt',
			},
			{
				newMode: '100755',
				previousMode: '100644',
				newBlob: 'bbb',
				previousBlob: 'ccc',
				change: 'M',
				path: 'ünï\ncödé',
			},
		])
	})

	test('finds no entries in empty output', () => {
		assert.deepEqual(parseTreeDiff(''), [])
	})
})

describe('git status --porcelain -z', () => {
	// The paths are verbatim, and a rename is followed by the path it came from
	const output = ' M a.txt\0?? new file.txt\0D  ünï\ncödé.txt\0R  renamed.txt\0old name.txt\0'
		+ 'A   leading space.txt\0'

	test('reads each path with its status letters', () => {
		assert.deepEqual(parseStatus(output), [
			{ status: ' M', path: 'a.txt' },
			{ status: '??', path: 'new file.txt' },
			{ status: 'D ', path: 'ünï\ncödé.txt' },
			{ status: 'R ', path: 'renamed.txt' },
			{ status: 'A ', path: ' leading space.txt' },
		])
	})

	test('has changes when it lists any file', () => {
		assert.equal(hasStatusChanges(output), true)
		assert.equal(hasStatusChanges(''), false)
	})
})
