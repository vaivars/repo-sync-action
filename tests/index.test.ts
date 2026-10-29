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
