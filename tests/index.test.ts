import esmock from 'esmock'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { prGit, silentCore } from './support.ts'

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
			getFileStatuses: async () => new Map(),
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
		const listed = body.match(/^`some\/deeply\/nested\/directory\/file-\d+\.txt` - unchanged$/gm)!
		const [, more] = body.match(/\n\.\.\.and (\d+) more<\/li>\n<\/ul>\n<\/details>\n/)!
		assert.equal(listed.length + Number(more), fileCount)

		// The resync warning added on the next run has to fit as well
		git.existingPr = { number: 1, body }
		await git.setPrWarning()
		assert.ok(requests[1].body.length <= 65536, `body is ${requests[1].body.length} characters`)
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
