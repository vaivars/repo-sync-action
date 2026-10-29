import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { loadConfig } from './support.js'

describe('config', () => {
	for (const [value, expected] of [[undefined, false], ['false', false], ['true', true]]) {
		test(`parses IS_FINE_GRAINED ${value} as ${expected}`, async () => {
			const { context } = await loadConfig('', { IS_FINE_GRAINED: value })

			assert.equal(context.IS_FINE_GRAINED, expected)
		})
	}

	test('reads a repo name starting with http as owner/name and still accepts URLs', async () => {
		const { parseConfig } = await loadConfig(`
httpie/cli:
  - a.txt
https://ghe.example.com/owner/repo@main:
  - b.txt
`)

		const repos = await parseConfig()

		assert.deepEqual(repos.map(({ repo }) => repo.uniqueName), [
			'github.com/httpie/cli@default',
			'ghe.example.com/owner/repo@main',
		])
	})

	test('skips file entries without a source and repos without files', async () => {
		const { parseConfig, warnings } = await loadConfig(`
owner/valid:
  - source: a.txt
  - dest: no-source.txt
  -
owner/null-list:
owner/empty-list: []
group:
  - repos: owner/group-null
    files:
  - repos: owner/valid
    files:
      - b.txt
`)

		const repos = await parseConfig()

		assert.deepEqual(
			repos.map(({ repo, files }) => [repo.fullName, files.map((file) => file.source)]),
			[['github.com/owner/valid', ['a.txt', 'b.txt']]],
		)
		assert.equal(warnings.filter((warning) => warning.includes('owner/valid')).length, 2)
		for (const name of ['owner/null-list', 'owner/empty-list', 'owner/group-null']) {
			assert.ok(warnings.some((warning) => warning.includes(name)), `no warning for ${name}`)
		}
	})
})
