import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { changedFiles, statusText } from '../src/changes.ts'

describe('statusText', () => {
	const cases = [
		['A  ', 'created'],
		['?', 'created'],
		[' M ', 'updated'],
		['AM ', 'updated'],
		['D  ', 'deleted'],
		['MD ', 'deleted'],
		['R', 'unchanged'],
		['', 'unchanged'],
	]

	for (const [mode, text] of cases) {
		test(`calls ${JSON.stringify(mode)} ${text}`, () => {
			assert.equal(statusText(mode), text)
		})
	}
})

describe('changedFiles', () => {
	const statuses = { 'out/a.txt': 'A  ', 'out/sub/b.txt': ' M ', 'single.txt': 'D  ' }

	test('lists the files of a directory relative to it, with their status', () => {
		assert.deepEqual(
			changedFiles(
				{ source: 'src/', dest: 'out', isDirectory: true },
				['out/a.txt', 'out/sub/b.txt', 'out/c.txt'],
				statuses,
			),
			{
				header: 'From remote directory <code>src/</code>, synced the following files:',
				files: ['`a.txt` - created', '`sub/b.txt` - updated', '`c.txt` - unchanged'],
			},
		)
	})

	test('lists a file by its name', () => {
		assert.deepEqual(
			changedFiles(
				{ source: 'templates/single.txt', dest: 'single.txt', isDirectory: false },
				['single.txt'],
				statuses,
			),
			{
				header: 'From remote file <code>templates/single.txt</code>, synced the following files:',
				files: ['`single.txt` - deleted'],
			},
		)
	})
})
