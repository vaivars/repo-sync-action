import esmock from 'esmock'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
	gitIn,
	loadHelpers,
	makeRepo,
	makeTmpDir,
	prGit,
	silentCore,
	writeTree,
} from './support.ts'

describe('run', () => {
	test("truncates a long file list so that the body stays under GitHub's limit", async () => {
		const fileCount = 3000
		const { git, requests } = await prGit({ PR_BODY: 'x'.repeat(1000) })
		const failures: string[] = []
		let statusChecks = 0
		Object.assign(git, {
			initRepo: async () => {},
			createPrBranch: async () => {},
			findExistingPr: async () => undefined,
			add: async () => {},
			commit: async () => {},
			push: async () => {},
			isOneCommitPush: () => false,
			stagedChanges: async (dest: string) =>
				Array.from({ length: fileCount }, (_, i) => ({
					status: 'A',
					path: `${dest}/some/deeply/nested/directory/file-${i}.txt`,
				})),
			// Changes for the synced directory, then nothing left for the final commit
			hasChanges: async () => ++statusChecks === 1,
			workingDir: 'work',
		})
		const helpers = await import('../src/helpers.ts')
		const { run } = await esmock.strict<typeof import('../src/index.ts')>('../src/index.ts', {
			'../src/config.ts': {
				default: {
					COMMIT_EACH_FILE: true,
					COMMIT_PREFIX: '🔄',
					PR_LABELS: [],
					DRY_RUN: false,
					TMP_DIR: 'tmp',
					SKIP_CLEANUP: true,
					OVERWRITE_EXISTING_PR: true,
					SKIP_PR: false,
					ORIGINAL_MESSAGE: false,
					COMMIT_AS_PR_TITLE: false,
					FORK: false,
				},
				parseConfig: async () => [{
					repo: {
						name: 'repo',
						user: 'owner',
						fullName: 'github.com/owner/repo',
						branch: 'default',
					},
					files: [{ source: 'src-dir', dest: 'dest-dir', replace: true }],
				}],
			},
			'../src/git.ts': {
				default: class {
					constructor() {
						return git
					}
				},
			},
			'../src/helpers.ts': {
				...helpers,
				copy: async () => {},
				pathIsDirectory: async () => true,
				getSyncedFileList: async (_src: string, dest: string) =>
					Array.from(
						{ length: fileCount },
						(_, i) => `${dest}/some/deeply/nested/directory/file-${i}.txt`,
					),
				remove: async () => {},
			},
			fs: { existsSync: () => true },
			// Not a global mock, which would keep Node from stripping the types of the modules below
			'@actions/core': {
				...silentCore,
				notice: () => {},
				setOutput: () => {},
				setFailed: (message: string) => failures.push(message),
			},
		})

		await run()

		assert.deepEqual(failures, [])
		assert.equal(requests.length, 1)
		const { body } = requests[0]
		assert.ok(body.length <= 65536, `body is ${body.length} characters`)
		const listed = body.match(/^`some\/deeply\/nested\/directory\/file-\d+\.txt` - created$/gm)!
		const [, more] = body.match(/\n\.\.\.and (\d+) more<\/li>\n<\/ul>\n<\/details>\n/)!
		assert.equal(listed.length + Number(more), fileCount)

		// The resync warning added on the next run has to fit as well
		git.existingPr = { number: 1, body }
		await git.setPrWarning()
		assert.ok(requests[1].body.length <= 65536, `body is ${requests[1].body.length} characters`)
	})
})

describe('run with real files and git', () => {
	const lines = (word: string) => Array.from({ length: 30 }, (_, i) => `${word} ${i}\n`).join('')

	// The files of the source repository, and those the target has before the sync
	const SOURCE = {
		'conf/keep.txt': 'same',
		'conf/change.txt': 'new',
		'conf/new file.txt': 'added',
		'conf/ünï cödé.txt': 'added too',
		'conf/dir with space/moved.txt': lines('moved'),
		'conf/edited new.txt': lines('edited').replace('edited 7\n', 'edited seven\n'),
		'docs/a.md': 'a',
		'docs/b.md': 'b',
		'docs/c.md': 'c',
		'docs/e.md': 'new e',
		'single.txt': 'new single',
		'same/x.txt': 'same',
	}
	const TARGET = {
		'conf/keep.txt': 'same',
		'conf/change.txt': 'old',
		'conf/orphan.txt': 'orphan',
		'conf/old place.txt': lines('moved'),
		'conf/edited old.txt': lines('edited'),
		'docs/a.md': 'a',
		'docs/b.md': 'b',
		'docs/c.md': 'c',
		'docs/e.md': 'old e',
		'single.txt': 'old single',
		'same/x.txt': 'same',
	}

	// Syncs SOURCE into a repository with TARGET, copying the files and running git for real. Only
	// the clone, the push and the API are fakes. Returns the PR body and how many commits were made
	async function syncFiles(commitEachFile: boolean) {
		const source = await makeTmpDir()
		await writeTree(source, SOURCE)
		const target = await makeRepo([TARGET])
		const { git, requests } = await prGit()
		Object.assign(git, {
			initRepo: async () => {},
			createPrBranch: async () => {},
			findExistingPr: async () => undefined,
			push: async () => {},
			isOneCommitPush: () => false,
			workingDir: target,
		})
		const entry = (name: string, deleteOrphaned = false) => ({
			source: path.join(source, name),
			dest: name,
			template: false,
			replace: true,
			deleteOrphaned,
			exclude: undefined,
		})
		const failures: string[] = []
		const { run } = await esmock.strict<typeof import('../src/index.ts')>('../src/index.ts', {
			'../src/config.ts': {
				default: {
					COMMIT_EACH_FILE: commitEachFile,
					COMMIT_PREFIX: '🔄',
					PR_LABELS: [],
					DRY_RUN: false,
					TMP_DIR: 'tmp',
					SKIP_CLEANUP: true,
					OVERWRITE_EXISTING_PR: true,
					SKIP_PR: false,
					ORIGINAL_MESSAGE: false,
					COMMIT_AS_PR_TITLE: false,
					FORK: false,
				},
				parseConfig: async () => [{
					repo: { name: 'repo', user: 'owner', fullName: 'github.com/owner/repo', branch: 'main' },
					files: [entry('conf', true), entry('docs'), entry('single.txt'), entry('same')],
				}],
			},
			'../src/git.ts': {
				default: class {
					constructor() {
						return git
					}
				},
			},
			'../src/helpers.ts': await loadHelpers(),
			'@actions/core': {
				...silentCore,
				notice: () => {},
				setOutput: () => {},
				setFailed: (message: string) => failures.push(message),
			},
		})
		const before = Number(gitIn(target, 'rev-list', '--count', 'HEAD'))

		await run()

		assert.deepEqual(failures, [])
		assert.equal(requests.length, 1)
		return {
			source,
			body: requests[0].body,
			commits: Number(gitIn(target, 'rev-list', '--count', 'HEAD')) - before,
		}
	}

	// What the PR body lists for the sync: the changes of each entry that has any, with the number of
	// its synced files that did not change
	const changedFilesList = (source: string) =>
		'<details>\n<summary>Changed files</summary>\n<ul>\n'
		+ `<li>From remote directory <code>${source}/conf</code>, synced the following files:\n\n`
		+ '`change.txt` - updated\n'
		+ '`old place.txt` → `dir with space/moved.txt` - renamed\n'
		+ '`edited old.txt` → `edited new.txt` - renamed and updated\n'
		+ '`new file.txt` - created\n'
		+ '`orphan.txt` - deleted\n'
		+ '`ünï cödé.txt` - created\n'
		+ '...and 1 unchanged file</li>'
		+ `<li>From remote directory <code>${source}/docs</code>, synced the following files:\n\n`
		+ '`e.md` - updated\n'
		+ '...and 3 unchanged files</li>'
		+ `<li>From remote file <code>${source}/single.txt</code>, synced the following files:\n\n`
		+ '`single.txt` - updated</li>'
		+ '\n</ul>\n</details>'

	test('lists what each commit changes with COMMIT_EACH_FILE', async () => {
		const { source, body, commits } = await syncFiles(true)

		assert.ok(body.includes(`\n\n${changedFilesList(source)}\n\n---\n\n`), body)
		// One per entry with changes
		assert.equal(commits, 3)
	})

	test('lists what each entry changes without COMMIT_EACH_FILE', async () => {
		const { source, body, commits } = await syncFiles(false)

		assert.ok(body.includes(`\n\n${changedFilesList(source)}\n\n---\n\n`), body)
		// One for everything
		assert.equal(commits, 1)
	})
})

describe('run with PR_AUTOMERGE', () => {
	// Syncs one changed file into each of the fake repositories `repos`, whose PRs are numbered from 1
	// and whose PR calls are recorded in order. The fake enablePrAutoMerge answers what `automerge`
	// returns for the PR's number. Returns the calls, notices, failures and outputs of the run
	async function syncWith(
		{ config = {}, automerge = () => 'enabled', repos = ['repo'] }: {
			config?: Record<string, unknown>
			automerge?: (number: number) => string
			repos?: string[]
		} = {},
	) {
		const calls: unknown[][] = []
		const notices: string[] = []
		const failures: string[] = []
		const outputs: Record<string, unknown> = {}
		let statusChecks = 0
		let prs = 0
		const git = {
			workingDir: 'work',
			initRepo: async () => {
				statusChecks = 0
			},
			createPrBranch: async () => {},
			findExistingPr: async () => undefined,
			add: async () => {},
			commit: async () => {},
			push: async () => {},
			isOneCommitPush: () => false,
			stagedChanges: async () => [],
			// Changes for the file, then nothing left for the final commit
			hasChanges: async () => ++statusChecks === 1,
			createOrUpdatePr: async () => {
				calls.push(['createOrUpdatePr'])
				const number = ++prs
				return { number, body: '', html_url: `url/${number}`, node_id: `PR_${number}` }
			},
			addPrLabels: async (labels: string[]) => calls.push(['addPrLabels', labels]),
			enablePrAutoMerge: async (
				pullRequest: { number: number; node_id: string },
				method: string,
			) => {
				calls.push(['enablePrAutoMerge', pullRequest.node_id, method])
				return automerge(pullRequest.number)
			},
		}
		const helpers = await import('../src/helpers.ts')
		const { run } = await esmock.strict<typeof import('../src/index.ts')>('../src/index.ts', {
			'../src/config.ts': {
				default: {
					COMMIT_EACH_FILE: true,
					COMMIT_PREFIX: '🔄',
					PR_LABELS: ['sync'],
					DRY_RUN: false,
					TMP_DIR: 'tmp',
					SKIP_CLEANUP: true,
					OVERWRITE_EXISTING_PR: true,
					SKIP_PR: false,
					ORIGINAL_MESSAGE: false,
					COMMIT_AS_PR_TITLE: false,
					FORK: false,
					PR_AUTOMERGE: true,
					PR_AUTOMERGE_METHOD: 'squash',
					...config,
				},
				parseConfig: async () =>
					repos.map((name) => ({
						repo: { name, user: 'owner', fullName: `github.com/owner/${name}`, branch: 'main' },
						files: [{ source: 'a.txt', dest: 'a.txt', replace: true }],
					})),
			},
			'../src/git.ts': {
				default: class {
					constructor() {
						return git
					}
				},
			},
			'../src/helpers.ts': {
				...helpers,
				copy: async () => {},
				pathIsDirectory: async () => false,
				remove: async () => {},
			},
			fs: { existsSync: () => true },
			'@actions/core': {
				...silentCore,
				notice: (message: string) => notices.push(message),
				setOutput: (name: string, value: unknown) => {
					outputs[name] = value
				},
				setFailed: (message: string) => failures.push(message),
			},
		})

		await run()

		return { calls, notices, failures, outputs }
	}

	test('enables auto-merge with the method after the labels', async () => {
		const { calls, notices, failures } = await syncWith()

		assert.deepEqual(failures, [])
		assert.deepEqual(calls, [
			['createOrUpdatePr'],
			['addPrLabels', ['sync']],
			['enablePrAutoMerge', 'PR_1', 'squash'],
		])
		assert.deepEqual(notices, ['Pull Request #1 created/updated: url/1'])
	})

	test('says when the PR was merged right away', async () => {
		const { notices, failures } = await syncWith({ automerge: () => 'merged' })

		assert.deepEqual(failures, [])
		assert.deepEqual(notices, [
			'Pull Request #1 created/updated: url/1',
			'Pull Request #1 had no required checks or reviews to wait for and was merged',
		])
	})

	test('leaves auto-merge off without PR_AUTOMERGE, and with FORK', async () => {
		const off = await syncWith({ config: { PR_AUTOMERGE: false } })
		const fork = await syncWith({ config: { FORK: 'forker' } })

		assert.deepEqual(off.calls, [['createOrUpdatePr'], ['addPrLabels', ['sync']]])
		assert.deepEqual(fork.calls, [['createOrUpdatePr']])
	})

	test('fails only the repository whose auto-merge fails, and still outputs its PR', async () => {
		const { calls, failures, outputs } = await syncWith({
			repos: ['repo-a', 'repo-b'],
			automerge: (number) => {
				if (number === 1) throw new Error('Auto merge is not allowed for this repository')
				return 'enabled'
			},
		})

		assert.deepEqual(failures, ['Auto merge is not allowed for this repository'])
		assert.deepEqual(calls.filter(([name]) => name === 'enablePrAutoMerge'), [
			['enablePrAutoMerge', 'PR_1', 'squash'],
			['enablePrAutoMerge', 'PR_2', 'squash'],
		])
		assert.deepEqual(outputs, { pull_request_urls: ['url/1', 'url/2'] })
	})
})

describe('run with a repository that fails', () => {
	// Runs the action for one repository whose clone throws `thrown`, and returns what it reported
	async function failWith(thrown: unknown) {
		const failures: unknown[] = []
		const debugs: unknown[] = []
		const helpers = await import('../src/helpers.ts')
		const { run } = await esmock.strict<typeof import('../src/index.ts')>('../src/index.ts', {
			'../src/config.ts': {
				default: { TMP_DIR: 'tmp', SKIP_CLEANUP: true, SKIP_PR: false, DRY_RUN: false },
				parseConfig: async () => [{
					repo: { name: 'repo', user: 'owner', fullName: 'github.com/owner/repo', branch: 'main' },
					files: [],
				}],
			},
			'../src/git.ts': {
				default: class {
					async initRepo() {
						throw thrown
					}
				},
			},
			'../src/helpers.ts': helpers,
			'@actions/core': {
				...silentCore,
				setFailed: (message: unknown) => failures.push(message),
				debug: (message: unknown) => debugs.push(message),
			},
		})

		await run()

		return { failures, debugs }
	}

	test('fails it with the message and debug-logs the stack of an Error', async () => {
		const error = new Error('boom')

		assert.deepEqual(await failWith(error), { failures: ['boom'], debugs: [error.stack] })
		assert.match(error.stack!, /^Error: boom\n {4}at /)
	})

	test('debug-logs the message of an Error without a stack', async () => {
		const error = Object.assign(new Error('no stack'), { stack: undefined })

		assert.deepEqual(await failWith(error), { failures: ['no stack'], debugs: ['no stack'] })
	})

	test('debug-logs anything else thrown as a string', async () => {
		assert.deepEqual((await failWith({ code: 42 })).debugs, ['[object Object]'])
		assert.deepEqual((await failWith('text')).debugs, ['text'])
	})
})
