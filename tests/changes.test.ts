import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { changedFiles } from '../src/changes.ts'

describe('changedFiles', () => {
	const directory = { source: 'src/', dest: 'out', isDirectory: true }

	test('describes each staged change of a directory, relative to it', () => {
		assert.deepEqual(
			changedFiles(directory, [], [
				{ status: 'A', path: 'out/new file.txt' },
				{ status: 'M', path: 'out/sub/ünï.txt' },
				{ status: 'T', path: 'out/link' },
				{ status: 'D', path: 'out/gone.txt' },
				{ status: 'R100', from: 'out/old.txt', path: 'out/sub/new.txt' },
				{ status: 'R087', from: 'out/a.txt', path: 'out/b.txt' },
			]),
			{
				header: 'From remote directory <code>src/</code>, synced the following files:',
				files: [
					'`new file.txt` - created',
					'`sub/ünï.txt` - updated',
					'`link` - updated',
					'`gone.txt` - deleted',
					'`old.txt` → `sub/new.txt` - renamed',
					'`a.txt` → `b.txt` - renamed and updated',
				],
				unchanged: 0,
			},
		)
	})

	test('describes a single file by its name', () => {
		assert.deepEqual(
			changedFiles(
				{ source: 'templates/single.txt', dest: 'conf/single.txt', isDirectory: false },
				['conf/single.txt'],
				[{ status: 'M', path: 'conf/single.txt' }],
			),
			{
				header: 'From remote file <code>templates/single.txt</code>, synced the following files:',
				files: ['`single.txt` - updated'],
				unchanged: 0,
			},
		)
	})

	test('counts the synced files that did not change', () => {
		const synced = ['out/a.txt', 'out/b.txt', 'out/c.txt', 'out/new.txt']
		const unchanged = (changes: { status: string; path: string; from?: string }[]) =>
			changedFiles(directory, synced, changes).unchanged

		assert.equal(unchanged([{ status: 'A', path: 'out/a.txt' }]), 3)
		assert.equal(
			unchanged([
				{ status: 'M', path: 'out/a.txt' },
				{ status: 'M', path: 'out/b.txt' },
				{ status: 'R100', from: 'out/old.txt', path: 'out/new.txt' },
			]),
			1,
		)
		assert.equal(
			unchanged(synced.map((path) => ({ status: 'M', path }))),
			0,
		)
	})

	test('treats files named like Object properties like any other', () => {
		assert.deepEqual(
			changedFiles(directory, ['out/constructor', 'out/__proto__', 'out/toString'], [
				{ status: 'A', path: 'out/constructor' },
				{ status: 'A', path: 'out/__proto__' },
			]),
			{
				header: 'From remote directory <code>src/</code>, synced the following files:',
				files: ['`constructor` - created', '`__proto__` - created'],
				unchanged: 1,
			},
		)
	})
})
