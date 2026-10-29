import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import type { SyncTarget } from '../src/config.ts'
import { loadConfig, ROOT_DIR } from './support.ts'

describe('config', () => {
	for (const [value, expected] of [[undefined, false], ['false', false], ['true', true]] as const) {
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

describe('repo groups', () => {
	// The entry parseConfig makes of a file given only by its source
	const file = (source: string) => ({
		source,
		dest: source,
		template: false,
		replace: true,
		deleteOrphaned: false,
		exclude: undefined,
	})
	// The repos parseConfig resolves, in order, with their files
	const resolved = (repos: SyncTarget[]) => repos.map(({ repo, files }) => [repo.uniqueName, files])

	test('resolve a group name in repos to the repos of that group', async () => {
		const { parseConfig, warnings } = await loadConfig(`
repo_groups:
  backend:
    - user/api
    - user/worker
  frontend:
    - user/web
    - user/mobile

group:
  - files:
      - source: .github/workflows/test.yml
        dest: .github/workflows/test.yml
    repos: backend

  - files:
      - source: LICENSE
        dest: LICENSE
    repos: frontend
`)

		const repos = await parseConfig()

		assert.deepEqual(resolved(repos), [
			['github.com/user/api@default', [file('.github/workflows/test.yml')]],
			['github.com/user/worker@default', [file('.github/workflows/test.yml')]],
			['github.com/user/web@default', [file('LICENSE')]],
			['github.com/user/mobile@default', [file('LICENSE')]],
		])
		assert.deepEqual(warnings, [])
	})

	test('are optional for inline repos lists and repo keys', async () => {
		const { parseConfig, warnings } = await loadConfig(`
group:
  - files:
      - source: .github/workflows/test.yml
        dest: .github/workflows/test.yml
    repos: |
      user/repo1
      user/repo2
      user/repo3

user/repo4:
  - LICENSE
  - .gitignore
`)

		const repos = await parseConfig()

		assert.deepEqual(resolved(repos), [
			['github.com/user/repo1@default', [file('.github/workflows/test.yml')]],
			['github.com/user/repo2@default', [file('.github/workflows/test.yml')]],
			['github.com/user/repo3@default', [file('.github/workflows/test.yml')]],
			['github.com/user/repo4@default', [file('LICENSE'), file('.gitignore')]],
		])
		assert.deepEqual(warnings, [])
	})

	test('resolve group names on the lines of an inline repos list', async () => {
		const { parseConfig, warnings } = await loadConfig(`
repo_groups:
  main_repos:
    - user/repo1
    - user/repo2
  extra_repos:
    - user/repo5
    - user/repo6

group:
  - files:
      - source: .github/workflows/build.yml
    repos: main_repos

  - files:
      - source: README.md
    repos: |
      user/repo3
      user/repo4

  # Multi-line string with group references (the squash-merge bug case)
  - files:
      - source: LICENSE
    repos: |
      main_repos
      extra_repos
`)

		const repos = await parseConfig()

		assert.deepEqual(resolved(repos), [
			['github.com/user/repo1@default', [file('.github/workflows/build.yml'), file('LICENSE')]],
			['github.com/user/repo2@default', [file('.github/workflows/build.yml'), file('LICENSE')]],
			['github.com/user/repo3@default', [file('README.md')]],
			['github.com/user/repo4@default', [file('README.md')]],
			['github.com/user/repo5@default', [file('LICENSE')]],
			['github.com/user/repo6@default', [file('LICENSE')]],
		])
		assert.deepEqual(warnings, [])
	})
})

describe('repo group names', () => {
	test('match only the groups that sync.yml defines, also when named like Object properties', async () => {
		const { resolveRepoList, warnings } = await loadConfig('')
		const groups = { constructor: ['user/a'], main: ['user/b'] }

		assert.deepEqual(resolveRepoList('constructor', groups), ['user/a'])
		for (const name of ['toString', '__proto__', 'hasOwnProperty']) {
			assert.deepEqual(resolveRepoList(name, groups), [name])
		}
		assert.deepEqual(resolveRepoList('valueOf\nconstructor\nmain', groups), [
			'valueOf',
			'user/a',
			'user/b',
		])
		assert.deepEqual(warnings, [])
	})
})

describe('action.yml', () => {
	// Inputs whose default depends on the token or the runner, or that have none
	const WITHOUT_DEFAULT = [
		'GH_PAT',
		'GH_INSTALLATION_TOKEN',
		'PR_BODY',
		'ASSIGNEES',
		'REVIEWERS',
		'TEAM_REVIEWERS',
		'COMMIT_BODY',
		'GIT_EMAIL',
		'GIT_USERNAME',
		'TMP_DIR',
		'FORK',
	]

	async function actionInputs() {
		const action = yaml.load(await fs.readFile(path.join(ROOT_DIR, 'action.yml'), 'utf8')) as {
			inputs: Record<string, { default?: string }>
		}
		return action.inputs
	}

	test('declares a default for every input except those without a fixed one', async () => {
		const inputs = await actionInputs()
		const withoutDefault = Object.keys(inputs).filter((key) => inputs[key].default === undefined)

		assert.deepEqual(withoutDefault.sort(), [...WITHOUT_DEFAULT].sort())
		for (const [key, input] of Object.entries(inputs)) {
			if (input.default !== undefined) assert.equal(typeof input.default, 'string', key)
		}
	})

	test('declares the same defaults the code falls back to', async () => {
		const inputs = await actionInputs()
		const declared = Object.fromEntries(
			Object.entries(inputs)
				.filter(([, input]) => input.default !== undefined)
				.map(([key, input]) => [key, input.default]),
		)

		// Without the inputs set, the code's own defaults apply. With them, the values the runner passes
		const unset = Object.fromEntries(Object.keys(declared).map((key) => [key, undefined]))
		const { context: fromCode } = await loadConfig('', unset)
		const { context: fromAction } = await loadConfig('', declared)

		for (const key of Object.keys(declared)) {
			assert.deepEqual(fromAction[key], fromCode[key], key)
		}
	})

	test('only declares inputs the code reads', async () => {
		const inputs = await actionInputs()
		const { context } = await loadConfig('')
		const tokens = ['GH_PAT', 'GH_INSTALLATION_TOKEN']

		for (const key of Object.keys(inputs)) {
			if (!tokens.includes(key)) assert.ok(key in context, key)
		}
	})
})
