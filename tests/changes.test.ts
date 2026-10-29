import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { changedFiles, statusText } from '../src/changes.ts'
import { parseFileStatuses } from '../src/git-output.ts'

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
	const statuses = new Map([['out/a.txt', 'A '], ['out/sub/b.txt', ' M'], ['single.txt', 'D ']])

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

	test('takes the status of files named like Object properties from git only', () => {
		const fileStatuses = parseFileStatuses('A  out/constructor\0A  out/__proto__\0')

		assert.deepEqual(
			changedFiles(
				{ source: 'src/', dest: 'out', isDirectory: true },
				['out/constructor', 'out/__proto__', 'out/toString'],
				fileStatuses,
			).files,
			['`constructor` - created', '`__proto__` - created', '`toString` - unchanged'],
		)
		for (const name of ['constructor', '__proto__', 'hasOwnProperty']) {
			assert.deepEqual(
				changedFiles({ source: 'a', dest: name, isDirectory: false }, [name], parseFileStatuses(''))
					.files,
				[`\`${name}\` - unchanged`],
			)
		}
	})
})
