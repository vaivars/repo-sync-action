import esmock from 'esmock'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { TreeDiffEntry } from '../src/git-output.ts'
import type { GitHubOptions, GraphQlApi, RepoSession, RestApi } from '../src/github.ts'
import { PR_WARNING } from '../src/pull-request.ts'
import type { FakeApi } from './support.ts'
import { silentCore } from './support.ts'

const { GitHub, treeEntries } = await esmock<typeof import('../src/github.ts')>(
	'../src/github.ts',
	{ '@actions/core': silentCore },
)

const OPTIONS: GitHubOptions = {
	fork: false,
	skipPr: false,
	defaultTitle: '🔄 synced file(s) with owner/source',
	body: { sourceRepository: 'owner/source', serverUrl: 'https://github.com', prBody: '' },
}

// A session for owner/repo, whose local git reads the test can replace
function session(overrides: Partial<RepoSession> = {}): RepoSession {
	return {
		repo: {
			fullName: 'github.com/owner/repo',
			uniqueName: 'github.com/owner/repo@default',
			host: 'github.com',
			user: 'owner',
			name: 'repo',
			branch: 'default',
		},
		baseBranch: 'main',
		prBranch: 'repo-sync/source/default',
		existingPr: undefined,
		lastCommitSha: 'base',
		getCommitsToPush: async () => [],
		getTreeId: async (commitSha) => `tree of ${commitSha}`,
		getTreeDiff: async () => [],
		getCommitMessage: async (commitSha) => `message of ${commitSha}`,
		readBlob: async (blob) => Buffer.from(blob),
		...overrides,
	}
}

// A GitHub whose fake API records each call as [scope.method, params], and each GraphQL request as
// ['graphql', { query, ...variables }]
function recordingGitHub(
	repoSession: RepoSession,
	options: Partial<GitHubOptions> = {},
	responses: Record<string, (params: Record<string, unknown>) => unknown> = {},
) {
	const calls: [string, Record<string, unknown>][] = []
	const api: FakeApi = {}
	for (
		const name of [
			'git.createRef',
			'git.createBlob',
			'git.createTree',
			'git.createCommit',
			'git.updateRef',
			'pulls.list',
			'pulls.create',
			'pulls.update',
			'pulls.merge',
			'issues.addLabels',
		]
	) {
		const [scope, method] = name.split('.')
		api[scope] ??= {}
		api[scope][method] = async (params: Record<string, unknown>) => {
			calls.push([name, params])
			return responses[name]?.(params) ?? { data: {} }
		}
	}
	const graphql = async (query: string, variables: Record<string, unknown>) => {
		const params = { query, ...variables }
		calls.push(['graphql', params])
		return responses.graphql?.(params) ?? {}
	}
	const github = new GitHub(
		{ rest: api as unknown as RestApi, graphql: graphql as unknown as GraphQlApi },
		repoSession,
		{ ...OPTIONS, ...options },
	)
	return { github, calls }
}

describe('treeEntries', () => {
	test('keeps added and changed files, and removes deleted ones with a null sha', () => {
		const entry = (newMode: string, previousMode: string, path: string): TreeDiffEntry => ({
			newMode,
			previousMode,
			newBlob: newMode === '000000' ? '0'.repeat(40) : `blob of ${path}`,
			previousBlob: 'previous',
			change: 'M',
			path,
		})

		assert.deepEqual(
			treeEntries([
				entry('100644', '000000', 'added.txt'),
				entry('100755', '100644', 'script.sh'),
				entry('000000', '120000', 'removed-link'),
			]),
			[
				{ path: 'added.txt', mode: '100644', type: 'blob', sha: 'blob of added.txt' },
				{ path: 'script.sh', mode: '100755', type: 'blob', sha: 'blob of script.sh' },
				{ path: 'removed-link', mode: '120000', type: 'blob', sha: null },
			],
		)
	})
})

describe('GitHub.createOrUpdatePr', () => {
	test('creates the PR from the fork with the default title, then updates it', async () => {
		const repoSession = session()
		const { github, calls } = recordingGitHub(repoSession, { fork: 'forker' }, {
			'pulls.create': () => ({ data: { number: 5, body: 'created', html_url: 'url' } }),
		})

		const created = await github.createOrUpdatePr([], undefined, undefined)
		await github.createOrUpdatePr([], 'Title', undefined)

		assert.deepEqual(created, { number: 5, body: 'created', html_url: 'url' })
		assert.deepEqual(repoSession.existingPr, created)
		assert.deepEqual(calls.map(([name]) => name), ['pulls.create', 'pulls.update'])
		const [[, create], [, update]] = calls
		assert.equal(create.title, '🔄 synced file(s) with owner/source')
		assert.equal(create.head, 'forker:repo-sync/source/default')
		assert.equal(create.base, 'main')
		assert.equal(update.title, 'Title')
		assert.equal(update.pull_number, 5)
		assert.equal(update.body, create.body)
	})
})

describe('GitHub.enablePrAutoMerge', () => {
	const PULL_REQUEST = { number: 5, body: null, html_url: 'url', node_id: 'PR_node' }
	// How Octokit's GraphqlResponseError words GitHub's errors
	const graphqlError = (message: string) => () => {
		throw new Error(`Request failed due to following response errors:\n - ${message}`)
	}

	test('enables auto-merge by the node ID, with the method in the case GraphQL takes', async () => {
		const { github, calls } = recordingGitHub(session())

		assert.equal(await github.enablePrAutoMerge(PULL_REQUEST, 'squash'), 'enabled')

		assert.equal(calls.length, 1)
		const [[name, { query, ...variables }]] = calls
		assert.equal(name, 'graphql')
		assert.match(
			query as string,
			/enablePullRequestAutoMerge\(input: \{ pullRequestId: \$pullRequestId, mergeMethod: \$mergeMethod \}\)/,
		)
		assert.deepEqual(variables, { pullRequestId: 'PR_node', mergeMethod: 'SQUASH' })
	})

	for (const status of ['clean', 'unstable']) {
		test(`merges a PR in ${status} status right away`, async () => {
			const { github, calls } = recordingGitHub(session(), {}, {
				graphql: graphqlError(`Pull request is in ${status} status`),
			})

			assert.equal(await github.enablePrAutoMerge(PULL_REQUEST, 'rebase'), 'merged')

			assert.deepEqual(calls.map(([name]) => name), ['graphql', 'pulls.merge'])
			assert.deepEqual(calls[1][1], {
				owner: 'owner',
				repo: 'repo',
				pull_number: 5,
				merge_method: 'rebase',
			})
		})
	}

	test('fails on other errors without merging', async () => {
		const { github, calls } = recordingGitHub(session(), {}, {
			graphql: graphqlError('Auto merge is not allowed for this repository'),
		})

		await assert.rejects(
			github.enablePrAutoMerge(PULL_REQUEST, 'merge'),
			/Auto merge is not allowed for this repository/,
		)
		assert.deepEqual(calls.map(([name]) => name), ['graphql'])
	})
})

describe('GitHub PR warning', () => {
	test('does not write null into a PR without a body', async () => {
		const { github, calls } = recordingGitHub(session({ existingPr: { number: 3, body: null } }))

		await github.setPrWarning()

		assert.deepEqual(calls, [
			['pulls.update', { owner: 'owner', repo: 'repo', pull_number: 3, body: `${PR_WARNING}\n\n` }],
		])
	})

	test('comes off a PR without a body', async () => {
		const { github, calls } = recordingGitHub(session({ existingPr: { number: 3, body: null } }))

		await github.removePrWarning()

		assert.deepEqual(calls, [
			['pulls.update', { owner: 'owner', repo: 'repo', pull_number: 3, body: '' }],
		])
	})

	test('leaves a body without the warning as it is', async () => {
		const { github, calls } = recordingGitHub(session({ existingPr: { number: 3, body: 'Body' } }))

		await github.removePrWarning()

		assert.deepEqual(calls, [
			['pulls.update', { owner: 'owner', repo: 'repo', pull_number: 3, body: 'Body' }],
		])
	})
})

describe('GitHub.createVerifiedCommits', () => {
	const diff = (commitSha: string): TreeDiffEntry[] => [
		{
			newMode: '100644',
			previousMode: '100644',
			newBlob: `new ${commitSha}`,
			previousBlob: 'old',
			change: 'M',
			path: 'a.txt',
		},
		{
			newMode: '000000',
			previousMode: '100644',
			newBlob: '0'.repeat(40),
			previousBlob: 'old',
			change: 'A',
			path: 'gone.txt',
		},
	]

	function commitSession() {
		return session({
			getCommitsToPush: async () => ['c1', 'c2'],
			getTreeDiff: async (treeId) => diff(treeId.replace('tree of ', '')),
		})
	}

	test('makes each commit on top of the last one and moves the PR branch to them', async () => {
		const repoSession = commitSession()
		let created = 0
		const { github, calls } = recordingGitHub(repoSession, {}, {
			'git.createTree': () => ({ data: { sha: `tree ${++created}` } }),
			'git.createCommit': () => ({ data: { sha: `commit ${created}` } }),
		})

		await github.createVerifiedCommits()

		assert.deepEqual(
			calls.map(([name, params]) => [name, params.ref ?? params.parents ?? params.content ?? null]),
			[
				['git.createRef', 'refs/heads/repo-sync/source/default'],
				// Only the files the commit keeps are uploaded
				['git.createBlob', Buffer.from('new c1').toString('base64')],
				['git.createTree', null],
				['git.createCommit', ['base']],
				['git.createBlob', Buffer.from('new c2').toString('base64')],
				['git.createTree', null],
				['git.createCommit', ['commit 1']],
				['git.updateRef', 'heads/repo-sync/source/default'],
			],
		)
		assert.deepEqual(calls[2][1].tree, treeEntries(diff('c1')))
		assert.equal(calls[2][1].base_tree, 'tree of c1~1')
		assert.equal(calls[3][1].message, 'message of c1')
		assert.deepEqual(calls.at(-1)![1], {
			owner: 'owner',
			repo: 'repo',
			ref: 'heads/repo-sync/source/default',
			sha: 'commit 2',
			force: true,
		})
		assert.equal(repoSession.lastCommitSha, 'commit 2')
	})

	test('fast-forwards the base branch with SKIP_PR', async () => {
		const { github, calls } = recordingGitHub(session(), { skipPr: true })

		await github.createVerifiedCommits()

		assert.deepEqual(calls, [
			['git.updateRef', {
				owner: 'owner',
				repo: 'repo',
				ref: 'heads/main',
				sha: 'base',
				force: false,
			}],
		])
	})

	test('goes on when the PR branch exists, and fails on other errors', async () => {
		const failWith = (status: number, message: string) => () => {
			throw Object.assign(new Error(message), { status })
		}
		const exists = recordingGitHub(session(), {}, {
			'git.createRef': failWith(422, 'Reference already exists - https://docs.github.com'),
		})
		const fails = recordingGitHub(session(), {}, {
			'git.createRef': failWith(422, 'Reference update failed'),
		})

		await exists.github.createVerifiedCommits()
		await assert.rejects(fails.github.createVerifiedCommits(), {
			message: 'Reference update failed',
		})

		assert.deepEqual(exists.calls.map(([name]) => name), ['git.createRef', 'git.updateRef'])
		assert.deepEqual(fails.calls.map(([name]) => name), ['git.createRef'])
	})

	test('says when the tree cannot be created', async () => {
		const { github } = recordingGitHub(commitSession(), {}, {
			'git.createTree': () => {
				throw new Error('Validation Failed')
			},
		})

		await assert.rejects(github.createVerifiedCommits(), {
			message: 'Cannot create a new GitHub Tree: Validation Failed',
		})
	})
})
