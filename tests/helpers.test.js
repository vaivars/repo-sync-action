import esmock from 'esmock'
import fs from 'fs-extra'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'

import { isReferenceExistsError } from '../src/helpers.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
// Templates only render below the working directory, so scratch files live in the repo
const TMP_ROOT = path.join(ROOT_DIR, '.tmp/helpers-tests')

after(() => fs.remove(TMP_ROOT))

async function makeTmpDir() {
	await fs.ensureDir(TMP_ROOT)
	return fs.mkdtemp(path.join(TMP_ROOT, 'case-'))
}

async function writeTree(root, files) {
	for (const [file, content] of Object.entries(files)) {
		await fs.outputFile(path.join(root, file), content)
	}
}

function gitIn(cwd, ...args) {
	return execFileSync('git', [
		'-c',
		'user.name=test',
		'-c',
		'user.email=test@example.com',
		'-c',
		'commit.gpgsign=false',
		...args,
	], { cwd, encoding: 'utf8' }).trim()
}

// A git repo with one commit per entry of `commits`; a null content deletes the file
async function makeRepo(commits) {
	const dir = await makeTmpDir()
	gitIn(dir, 'init', '-q')
	// For the commits that Git makes in it
	gitIn(dir, 'config', 'user.name', 'test')
	gitIn(dir, 'config', 'user.email', 'test@example.com')
	gitIn(dir, 'config', 'commit.gpgsign', 'false')
	for (const files of commits) {
		for (const [file, content] of Object.entries(files)) {
			if (content === null) await fs.remove(path.join(dir, file))
			else await fs.outputFile(path.join(dir, file), content)
		}
		gitIn(dir, 'add', '-A')
		gitIn(dir, 'commit', '-q', '-m', 'commit')
	}
	return dir
}

// The sha GitHub gives a blob with these bytes
function gitBlobSha(bytes) {
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

const silentCore = {
	debug: () => {},
	info: () => {},
	warning: () => {},
	setSecret: () => {},
}

// helpers.js with @actions/core silenced; readdir sorted so that dot entries come first
async function loadHelpers() {
	return esmock('../src/helpers.js', {
		'@actions/core': silentCore,
		'fs-extra': { default: { ...fs, readdir: async (dir) => (await fs.readdir(dir)).sort() } },
	})
}

// config.js reads its inputs when it is imported, so every call loads a fresh copy of it
async function loadConfig(syncYml, inputs = {}) {
	const dir = await makeTmpDir()
	const configPath = path.join(dir, 'sync.yml')
	await fs.writeFile(configPath, syncYml)

	for (const key of Object.keys(process.env)) {
		if (key.startsWith('INPUT_')) delete process.env[key]
	}
	const env = {
		GH_PAT: 'test-token',
		GITHUB_REPOSITORY: 'owner/source',
		CONFIG_PATH: configPath,
		TMP_DIR: path.join(dir, 'work'),
		...inputs,
	}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) process.env[`INPUT_${key}`] = value
	}
	process.env.GITHUB_SERVER_URL = 'https://github.com'

	const warnings = []
	const config = await esmock('../src/config.js', {
		'@actions/core': { ...silentCore, warning: (message) => warnings.push(message) },
	})
	return { context: config.default, parseConfig: config.parseConfig, warnings }
}

const GIT_CONFIG = {
	GITHUB_TOKEN: 'test-token',
	GITHUB_SERVER_URL: 'https://github.com',
	IS_INSTALLATION_TOKEN: false,
	IS_FINE_GRAINED: false,
	GIT_USERNAME: undefined,
	GIT_EMAIL: undefined,
	TMP_DIR: 'tmp',
	COMMIT_BODY: '',
	COMMIT_PREFIX: '🔄',
	GITHUB_REPOSITORY: 'owner/source',
	OVERWRITE_EXISTING_PR: true,
	SKIP_PR: false,
	PR_BODY: '',
	BRANCH_PREFIX: 'repo-sync/SOURCE_REPO_NAME',
	FORK: false,
}

// A Git instance with a fixed config and a fake Octokit. With `commands`, the programs it runs are
// recorded there as { file, args, env } instead of being run, and print what `outputs` has for
// their arguments. Branch names are still checked by the real git check-ref-format
async function loadGit({ config = {}, octokit = {}, commands, outputs = {} } = {}) {
	const helpers = await import('../src/helpers.js')
	const mocks = {
		'../src/config.js': { default: { ...GIT_CONFIG, ...config } },
		'@actions/github': { getOctokit: () => ({ rest: octokit }), context: {} },
	}
	if (commands) {
		const printed = { 'rev-parse --abbrev-ref HEAD': 'main', ...outputs }
		mocks['../src/helpers.js'] = {
			...helpers,
			execFile: async (file, args, workingDir, options = {}) => {
				if (args[0] === 'check-ref-format') {
					return helpers.execFile(file, args, workingDir, options)
				}
				commands.push({ file, args, env: options.env })
				return printed[args.join(' ')] ?? ''
			},
		}
	}
	const { default: Git } = await esmock.strict('../src/git.js', mocks, {
		'@actions/core': silentCore,
	})
	return new Git()
}

// Shaped like Octokit's RequestError for POST /repos/{owner}/{repo}/git/refs
function requestError(status, message) {
	const error = new Error(message)
	error.status = status
	return error
}

test('matches an existing branch with the docs URL Octokit appends', () => {
	assert.equal(
		isReferenceExistsError(
			requestError(
				422,
				'Reference already exists - https://docs.github.com/rest/git/refs#create-a-reference',
			),
		),
		true,
	)
})

test('matches an existing branch with the bare message', () => {
	assert.equal(isReferenceExistsError(requestError(422, 'Reference already exists')), true)
})

test('rejects other validation failures', () => {
	assert.equal(isReferenceExistsError(requestError(422, 'Reference update failed')), false)
})

test('rejects the same message with another status', () => {
	assert.equal(isReferenceExistsError(requestError(500, 'Reference already exists')), false)
})

describe('copy with deleteOrphaned', () => {
	test('keeps deleting orphans after a .git entry', async () => {
		const { copy } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src/')
		const dest = path.join(dir, 'dest/')
		await writeTree(src, { 'kept.txt': 'source' })
		await writeTree(dest, {
			'.gitkeep': '',
			'.github/workflow.yml': 'target only',
			'kept.txt': 'old',
			'orphan.txt': 'target only',
		})

		await copy(src, dest, true, { deleteOrphaned: true })

		assert.equal(await fs.pathExists(path.join(dest, 'orphan.txt')), false)
		assert.equal(await fs.readFile(path.join(dest, 'kept.txt'), 'utf8'), 'source')
		assert.equal(await fs.pathExists(path.join(dest, '.gitkeep')), true)
		assert.equal(await fs.pathExists(path.join(dest, '.github/workflow.yml')), true)
	})
})

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

describe('Git.setIdentity', () => {
	function userApi(user) {
		return {
			users: {
				getAuthenticated: async () => {
					if (!user) throw new Error('GET /user must not be called')
					return { data: user }
				},
			},
		}
	}

	const bot = { login: 'bot', id: 7, email: 'bot@example.com' }
	const cases = [
		{
			name: 'keeps GIT_USERNAME when only GIT_EMAIL is missing',
			config: { GIT_USERNAME: 'custom' },
			user: bot,
			identity: ['custom', 'bot@example.com'],
		},
		{
			name: 'keeps GIT_EMAIL when only GIT_USERNAME is missing',
			config: { GIT_EMAIL: 'me@example.com' },
			user: bot,
			identity: ['bot', 'me@example.com'],
		},
		{
			name: 'uses the noreply address when the profile email is private',
			config: {},
			user: { ...bot, email: null },
			identity: ['bot', '7+bot@users.noreply.github.com'],
		},
		{
			name: 'does not call GET /user when both are given',
			config: { GIT_USERNAME: 'custom', GIT_EMAIL: 'me@example.com' },
			identity: ['custom', 'me@example.com'],
		},
		{
			name: 'falls back to the GitHub Actions bot for an installation token',
			config: { IS_INSTALLATION_TOKEN: true },
			identity: ['github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'],
		},
		{
			name: 'keeps GIT_USERNAME for an installation token',
			config: { IS_INSTALLATION_TOKEN: true, GIT_USERNAME: 'custom' },
			identity: ['custom', '41898282+github-actions[bot]@users.noreply.github.com'],
		},
	]

	for (const { name, config, user, identity: [username, email] } of cases) {
		test(name, async () => {
			const commands = []
			const git = await loadGit({ config, octokit: userApi(user), commands })

			await git.setIdentity()

			assert.deepEqual(commands.map(({ args }) => args), [
				['config', '--local', 'user.name', username],
				['config', '--local', 'user.email', email],
			])
		})
	}

	test('passes GIT_USERNAME and GIT_EMAIL to git literally', async () => {
		const dir = await makeRepo([{ 'a.txt': 'a' }])
		const username = `$(touch pwned) "quoted" 'single'`
		const email = '`touch pwned`@example.com'
		const git = await loadGit({ config: { GIT_USERNAME: username, GIT_EMAIL: email } })
		git.workingDir = dir

		await git.setIdentity()

		assert.equal(gitIn(dir, 'config', '--local', 'user.name'), username)
		assert.equal(gitIn(dir, 'config', '--local', 'user.email'), email)
		assert.equal(await fs.pathExists(path.join(dir, 'pwned')), false)
	})
})

describe('Git.initRepo with FORK', () => {
	const repo = {
		fullName: 'ghe.example.com/owner/repo',
		uniqueName: 'ghe.example.com/owner/repo@default',
		host: 'ghe.example.com',
		user: 'owner',
		name: 'repo',
		branch: 'default',
	}
	const cases = [
		{ config: {}, credentials: 'test-token' },
		{ config: { IS_FINE_GRAINED: true }, credentials: 'oauth:test-token' },
		{ config: { IS_INSTALLATION_TOKEN: true }, credentials: 'x-access-token:test-token' },
	]

	for (const { config, credentials } of cases) {
		test(`adds the fork remote on the repo's host with ${credentials}`, async () => {
			const commands = []
			const git = await loadGit({
				config: { ...config, FORK: 'forker', GIT_USERNAME: 'u', GIT_EMAIL: 'e@example.com' },
				octokit: { repos: { createFork: async () => ({}) } },
				commands,
			})

			await git.initRepo(repo)

			const args = commands.map(({ args }) => args)
			assert.ok(
				args.some((command) => command.includes(`https://${credentials}@${repo.fullName}.git`)),
			)
			assert.deepEqual(
				args.find((command) => command[0] === 'remote'),
				['remote', 'add', 'fork', `https://${credentials}@ghe.example.com/forker/repo.git`],
			)
		})
	}
})

describe('Git.push', () => {
	async function pushWith(config) {
		const commands = []
		const refUpdates = []
		const git = await loadGit({
			config,
			octokit: {
				git: {
					createRef: async () => ({}),
					updateRef: async (params) => refUpdates.push(params),
				},
			},
			commands,
		})
		Object.assign(git, {
			repo: { user: 'owner', name: 'repo' },
			workingDir: 'work',
			gitUrl: 'https://test-token@github.com/owner/repo.git',
			baseBranch: 'main',
			prBranch: 'repo-sync/source/default',
			lastCommitSha: 'abc123',
			getCommitsToPush: async () => [],
		})

		await git.push()

		return { commands, refUpdates }
	}

	test('does not force push the base branch with SKIP_PR', async () => {
		const { commands } = await pushWith({ SKIP_PR: true })

		assert.deepEqual(commands.map(({ args }) => args), [
			['push', 'https://test-token@github.com/owner/repo.git'],
		])
	})

	test('force pushes the recreated PR branch', async () => {
		const { commands } = await pushWith({ SKIP_PR: false })

		assert.deepEqual(commands.map(({ args }) => args), [
			['push', 'https://test-token@github.com/owner/repo.git', '--force'],
		])
	})

	test('force pushes the PR branch to the fork', async () => {
		const { commands } = await pushWith({ SKIP_PR: false, FORK: 'forker' })

		assert.deepEqual(commands.map(({ args }) => args), [
			['push', '-u', 'fork', 'repo-sync/source/default', '--force'],
		])
	})

	test('does not force update the base branch ref with SKIP_PR and an installation token', async () => {
		const { refUpdates } = await pushWith({ SKIP_PR: true, IS_INSTALLATION_TOKEN: true })

		assert.equal(refUpdates.length, 1)
		assert.equal(refUpdates[0].ref, 'heads/main')
		assert.equal(refUpdates[0].force, false)
	})

	test('force updates the PR branch ref with an installation token', async () => {
		const { refUpdates } = await pushWith({ SKIP_PR: false, IS_INSTALLATION_TOKEN: true })

		assert.equal(refUpdates.length, 1)
		assert.equal(refUpdates[0].ref, 'heads/repo-sync/source/default')
		assert.equal(refUpdates[0].force, true)
	})
})

describe('Git.uploadGitHubBlob', () => {
	const files = {
		'binary file': Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
		'file over 4MB': Buffer.alloc(5 * 1024 * 1024, 'x'),
	}

	for (const [name, bytes] of Object.entries(files)) {
		test(`uploads a ${name} byte for byte`, async () => {
			const dir = await makeRepo([{ 'file.bin': bytes }])
			const blobs = []
			const git = await loadGit({
				octokit: { git: { createBlob: async (params) => blobs.push(params) } },
			})
			Object.assign(git, { workingDir: dir, repo: { user: 'owner', name: 'repo' } })
			const sha = gitIn(dir, 'rev-parse', 'HEAD:file.bin')

			await git.uploadGitHubBlob(sha)

			assert.equal(blobs.length, 1)
			assert.equal(blobs[0].encoding, 'base64')
			assert.equal(gitBlobSha(Buffer.from(blobs[0].content, 'base64')), sha)
		})
	}
})

describe('Git.getTreeDiff', () => {
	test('keeps paths with spaces and non-ASCII characters intact', async () => {
		const dir = await makeRepo([
			{ 'plain.txt': 'one', 'removed file.txt': 'removed later' },
			{
				'plain.txt': 'two',
				'removed file.txt': null,
				'dir with space/file name.txt': 'added',
				'ünïcödé.txt': 'added',
			},
		])
		const git = await loadGit()
		git.workingDir = dir

		const diff = await git.getTreeDiff(await git.getTreeId('HEAD'), await git.getTreeId('HEAD~1'))

		const byPath = Object.fromEntries(diff.map((entry) => [entry.path, entry]))
		assert.deepEqual(Object.keys(byPath).sort(), [
			'dir with space/file name.txt',
			'plain.txt',
			'removed file.txt',
			'ünïcödé.txt',
		])
		assert.deepEqual(byPath['ünïcödé.txt'], {
			newMode: '100644',
			previousMode: '000000',
			newBlob: gitIn(dir, 'rev-parse', 'HEAD:ünïcödé.txt'),
			previousBlob: '0000000000000000000000000000000000000000',
			change: 'D',
			path: 'ünïcödé.txt',
		})
		assert.equal(byPath['removed file.txt'].newMode, '000000')
	})
})

// sync.yml values that a shell would run. Without spaces they are valid branch names
const SHELL_PATH = '$(touch pwned)'
const SHELL_BRANCH = '$(touch${IFS}pwned)'

describe('git commands without a shell', () => {
	test('clones a sync.yml branch like $(…) as one literal argument', async () => {
		const commands = []
		const git = await loadGit({
			config: { GIT_USERNAME: 'u', GIT_EMAIL: 'e@example.com' },
			commands,
			outputs: { 'rev-parse --abbrev-ref HEAD': SHELL_BRANCH },
		})

		await git.initRepo({
			fullName: 'github.com/owner/repo',
			uniqueName: `github.com/owner/repo@${SHELL_BRANCH}`,
			host: 'github.com',
			user: 'owner',
			name: 'repo',
			branch: SHELL_BRANCH,
		})

		const clone = commands.find(({ args }) => args[0] === 'clone')
		assert.equal(clone.file, 'git')
		assert.deepEqual(clone.args.slice(0, 5), ['clone', '--depth', '1', '--branch', SHELL_BRANCH])
		assert.equal(clone.args.at(-1), path.join('tmp', `github.com/owner/repo@${SHELL_BRANCH}`))
	})

	test('adds a sync.yml dest like $(…) as a literal path', async () => {
		const dir = await makeRepo([{ 'a.txt': 'a' }])
		await fs.outputFile(path.join(dir, SHELL_PATH), 'synced')
		const git = await loadGit()
		git.workingDir = dir

		await git.add(SHELL_PATH)

		assert.equal(gitIn(dir, 'diff', '--cached', '--name-only'), SHELL_PATH)
		assert.equal(await fs.pathExists(path.join(dir, 'pwned')), false)
	})

	test('adds a dest starting with - as a path, not an option', async () => {
		const dir = await makeRepo([{ 'a.txt': 'a' }])
		await fs.outputFile(path.join(dir, '--dry-run'), 'synced')
		const git = await loadGit()
		git.workingDir = dir

		await git.add('--dry-run')

		assert.equal(gitIn(dir, 'diff', '--cached', '--name-only'), '--dry-run')
	})

	test('creates a PR branch from a sync.yml branch like $(…) literally', async () => {
		const dir = await makeRepo([{ 'a.txt': 'a' }])
		const git = await loadGit()
		Object.assign(git, { workingDir: dir, repo: { branch: SHELL_BRANCH } })

		await git.createPrBranch()

		assert.equal(git.prBranch, `repo-sync/source/${SHELL_BRANCH}`)
		assert.equal(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), git.prBranch)
		assert.equal(await fs.pathExists(path.join(dir, 'pwned')), false)
	})

	test('commits a message with quotes and $(…) literally', async () => {
		const dir = await makeRepo([{ 'a.txt': 'a' }])
		await fs.outputFile(path.join(dir, 'a.txt'), 'b')
		gitIn(dir, 'add', 'a.txt')
		const git = await loadGit({ config: { COMMIT_BODY: `body with 'quotes'` } })
		git.workingDir = dir
		const message = `it's "synced" ${SHELL_PATH} \`touch pwned\``

		await git.commit(message)

		assert.equal(gitIn(dir, 'log', '-1', '--format=%B'), `${message}\n\nbody with 'quotes'`)
		assert.equal(await fs.pathExists(path.join(dir, 'pwned')), false)
	})
})

describe('branch names', () => {
	const repo = (branch) => ({
		fullName: 'github.com/owner/repo',
		uniqueName: `github.com/owner/repo@${branch}`,
		host: 'github.com',
		user: 'owner',
		name: 'repo',
		branch,
	})
	const identity = { GIT_USERNAME: 'u', GIT_EMAIL: 'e@example.com' }

	// The first ones git would read as options. @{-1} is the branch checked out before
	for (const branch of ['-b', '--upload-pack=touch${IFS}pwned', 'HEAD', '@{-1}', 'two words']) {
		test(`rejects the sync.yml branch ${branch} before cloning`, async () => {
			const commands = []
			const git = await loadGit({ config: identity, commands })
			const quoted = JSON.stringify(branch)

			await assert.rejects(git.initRepo(repo(branch)), {
				message: `The branch ${quoted} of github.com/owner/repo is not a valid branch name`,
			})
			assert.deepEqual(commands, [])
		})
	}

	test('rejects a base branch starting with -', async () => {
		const commands = []
		const git = await loadGit({
			config: identity,
			commands,
			outputs: { 'rev-parse --abbrev-ref HEAD': '--output=pwned' },
		})

		await assert.rejects(git.initRepo(repo('default')), {
			message:
				'The base branch "--output=pwned" of github.com/owner/repo is not a valid branch name',
		})
		assert.equal(commands.at(-1).args.join(' '), 'rev-parse --abbrev-ref HEAD')
	})

	test('rejects a PR branch starting with -', async () => {
		const commands = []
		const git = await loadGit({ config: { BRANCH_PREFIX: '--output=pwned' }, commands })
		git.repo = repo('main')

		await assert.rejects(git.createPrBranch(), {
			message:
				'The PR branch "--output=pwned/main" of github.com/owner/repo is not a valid branch name',
		})
		assert.deepEqual(commands, [])
		assert.equal(git.prBranch, undefined)
	})

	test('clones and branches off a valid branch', async () => {
		const commands = []
		const git = await loadGit({ config: identity, commands })

		await git.initRepo(repo('release/v1.2'))
		await git.createPrBranch()

		const args = commands.map(({ args }) => args)
		assert.ok(args.some((command) => command.includes('release/v1.2')))
		assert.deepEqual(args.at(-1), ['checkout', '-b', 'repo-sync/source/release/v1.2'])
	})
})

describe('PR body', () => {
	async function prGit(config = {}) {
		const requests = []
		const respond = async (params) => {
			requests.push(params)
			return { data: { number: 1, html_url: 'https://github.com/owner/repo/pull/1' } }
		}
		const git = await loadGit({ config, octokit: { pulls: { create: respond, update: respond } } })
		Object.assign(git, {
			repo: { user: 'owner', name: 'repo' },
			prBranch: 'repo-sync/source/default',
			baseBranch: 'main',
		})
		return { git, requests }
	}

	test('keeps the indentation of interpolated content and none of the template', async () => {
		const { git, requests } = await prGit({ PR_BODY: 'Extra:\n  - indented item' })

		await git.createOrUpdatePr([], undefined, 'Body\n    code block')

		const { body } = requests[0]
		assert.ok(
			body.startsWith(
				'Body\n    code block\n\nsynced local file(s) with [owner/source](https://github.com/owner/source).\n\n'
					+ 'Extra:\n  - indented item\n\n',
			),
			body,
		)
		assert.doesNotMatch(body, /^\t/m)
	})

	test('keeps the indentation of the existing body when adding the resync warning', async () => {
		const { git, requests } = await prGit()
		git.existingPr = { number: 1, body: 'Line\n  indented' }

		await git.setPrWarning()

		assert.equal(
			requests[0].body,
			'⚠️ This PR is being automatically resynced ⚠️\n\nLine\n  indented',
		)
	})

	test('lists the changed files of each synced source', async () => {
		const { git, requests } = await prGit()

		await git.createOrUpdatePr(
			[
				{
					header: 'From remote directory <code>a/</code>:',
					files: ['`1` - created', '`2` - updated'],
				},
				{ header: 'From remote file <code>b</code>:', files: ['`b` - updated'] },
			],
			undefined,
			undefined,
		)

		assert.ok(
			requests[0].body.includes(
				'\n\n<details>\n<summary>Changed files</summary>\n<ul>\n'
					+ '<li>From remote directory <code>a/</code>:\n\n`1` - created\n`2` - updated</li>'
					+ '<li>From remote file <code>b</code>:\n\n`b` - updated</li>'
					+ '\n</ul>\n</details>\n\n---\n\n',
			),
			requests[0].body,
		)
	})

	test("truncates a long file list so that the body stays under GitHub's limit", async () => {
		const fileCount = 3000
		const { git, requests } = await prGit({ PR_BODY: 'x'.repeat(1000) })
		const failures = []
		let statusChecks = 0
		Object.assign(git, {
			initRepo: async () => {},
			createPrBranch: async () => {},
			findExistingPr: async () => undefined,
			add: async () => {},
			commit: async () => {},
			push: async () => {},
			isOneCommitPush: () => false,
			getFileStatuses: async () => ({}),
			// Changes for the synced directory, then nothing left for the final commit
			hasChanges: async () => ++statusChecks === 1,
			workingDir: 'work',
		})
		const helpers = await import('../src/helpers.js')
		const { run } = await esmock.strict('../src/index.js', {
			'../src/config.js': {
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
			'../src/git.js': {
				default: class {
					constructor() {
						return git
					}
				},
			},
			'../src/helpers.js': {
				...helpers,
				copy: async () => {},
				pathIsDirectory: async () => true,
				getSyncedFileList: async (_src, dest) =>
					Array.from(
						{ length: fileCount },
						(_, i) => `${dest}/some/deeply/nested/directory/file-${i}.txt`,
					),
				remove: async () => {},
			},
			fs: { existsSync: () => true },
		}, {
			'@actions/core': {
				...silentCore,
				notice: () => {},
				setOutput: () => {},
				setFailed: (message) => failures.push(message),
			},
		})

		await run()

		assert.deepEqual(failures, [])
		assert.equal(requests.length, 1)
		const { body } = requests[0]
		assert.ok(body.length <= 65536, `body is ${body.length} characters`)
		const listed = body.match(/^`some\/deeply\/nested\/directory\/file-\d+\.txt` - unchanged$/gm)
		const [, more] = body.match(/\n\.\.\.and (\d+) more<\/li>\n<\/ul>\n<\/details>\n/)
		assert.equal(listed.length + Number(more), fileCount)

		// The resync warning added on the next run has to fit as well
		git.existingPr = { number: 1, body }
		await git.setPrWarning()
		assert.ok(requests[1].body.length <= 65536, `body is ${requests[1].body.length} characters`)
	})
})

describe('templates', () => {
	test('render values without HTML escaping', async () => {
		const { write } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'config.yml')
		const dest = path.join(dir, 'out.yml')
		await fs.writeFile(src, 'run: {{ command }}\n')

		await write(src, dest, { command: `echo "a & b" > 'c' <d>` })

		assert.equal(await fs.readFile(dest, 'utf8'), `run: echo "a & b" > 'c' <d>\n`)
	})

	// Renders the template in `files[entry]` and returns the output. `relative` passes the template
	// path relative to the working directory, as sync.yml paths are, and `tmpDir` is a directory
	// below the case directory to treat as TMP_DIR
	async function render(files, entry, context = {}, { relative = false, tmpDir } = {}) {
		const { write, setTmpDir } = await loadHelpers()
		const dir = await makeTmpDir()
		await writeTree(dir, files)
		if (tmpDir !== undefined) setTmpDir(path.join(dir, tmpDir))
		const src = path.join(dir, entry)
		const dest = path.join(dir, 'out')
		await write(relative ? path.relative(process.cwd(), src) : src, dest, context)
		return fs.readFile(dest, 'utf8')
	}

	test('inherit layouts and blocks relative to the template', async () => {
		const output = await render(
			{
				'shared/base.yml': 'name: {% block title %}base{% endblock %}\n',
				'child.yml': `{% layout './shared/base.yml' %}{% block title %}{{ app }}{% endblock %}`,
			},
			'child.yml',
			{ app: 'my-app' },
		)

		assert.equal(output, 'name: my-app\n')
	})

	test('keep GitHub Actions expressions inside raw blocks', async () => {
		const output = await render({
			'workflow.yml': '{% raw %}token: ${{ secrets.GH_PAT }}{% endraw %}',
		}, 'workflow.yml')

		assert.equal(output, 'token: ${{ secrets.GH_PAT }}')
	})

	test('treat empty strings and zero as false', async () => {
		const output = await render(
			{
				'flags.txt':
					'{% if empty %}empty{% endif %}{% if zero %}zero{% endif %}{% if name %}{{ name }}{% endif %}',
			},
			'flags.txt',
			{ empty: '', zero: 0, name: 'set' },
		)

		assert.equal(output, 'set')
	})

	test('do not let templates reach JavaScript objects', async () => {
		const output = await render(
			{
				'escape.txt':
					'{% assign s = "x" %}[{{ s.constructor }}][{{ obj.__proto__ }}][{{ obj.toString }}]',
			},
			'escape.txt',
			{ obj: { a: 1 } },
		)

		assert.equal(output, '[][][]')
	})

	test('reject unknown filters', async () => {
		await assert.rejects(
			render({ 'filter.txt': '{{ 1 | valueOf }}' }, 'filter.txt'),
			/undefined filter: valueOf/,
		)
	})

	test('include files below the working directory by relative path', async () => {
		const output = await render(
			{ 'parts/name.txt': 'inner', 'outer.txt': `[{% include './parts/name.txt' %}]` },
			'outer.txt',
			{},
			{ relative: true },
		)

		assert.equal(output, '[inner]')
	})

	test('refuse to include existing files outside the working directory', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-sync-outside-'))
		const secret = path.join(outside, 'secret.txt')
		await fs.writeFile(secret, 'secret')
		try {
			await assert.rejects(
				render({ 'include.txt': `{% include '${secret}' %}` }, 'include.txt'),
				/Failed to lookup/,
			)
			const dir = await makeTmpDir()
			await assert.rejects(
				render({ 'include.txt': `{% include '${path.relative(dir, secret)}' %}` }, 'include.txt'),
				/Failed to lookup/,
			)
		} finally {
			await fs.remove(outside)
		}
	})

	test('refuse to include files inside .git', async () => {
		await assert.rejects(
			render(
				{ 'repo/.git/config': 'token', 'include.txt': `{% include './repo/.git/config' %}` },
				'include.txt',
			),
			/Failed to lookup/,
		)
	})

	test('refuse to include files through a symlink into .git', async () => {
		const { write } = await loadHelpers()
		const dir = await makeTmpDir()
		await writeTree(dir, {
			'repo/.git/config': 'token',
			'include.txt': `{% include './link.txt' %}`,
		})
		await fs.symlink(path.join(dir, 'repo/.git/config'), path.join(dir, 'link.txt'))

		await assert.rejects(
			write(path.join(dir, 'include.txt'), path.join(dir, 'out'), {}),
			/Failed to lookup/,
		)
	})

	test('refuse to include files inside TMP_DIR', async () => {
		await assert.rejects(
			render(
				{
					'clones/target/file.txt': 'target',
					'include.txt': `{% include './clones/target/file.txt' %}`,
				},
				'include.txt',
				{},
				{ tmpDir: 'clones' },
			),
			/Failed to lookup/,
		)
	})

	test('print arrays comma separated', async () => {
		const output = await render({ 'CODEOWNERS': '* {{ owners }}' }, 'CODEOWNERS', {
			owners: ['@a', '@b'],
		})

		assert.equal(output, '* @a,@b')
	})

	test('stop templates that allocate too much', async () => {
		await assert.rejects(
			render({ 'loop.txt': '{% for i in (1..1000000000) %}x{% endfor %}' }, 'loop.txt'),
			/memory/i,
		)
	})
})

describe('protected paths', () => {
	test('cover .git directories and TMP_DIR', async () => {
		const { isProtectedPath, setTmpDir } = await loadHelpers()
		setTmpDir('clones')

		assert.equal(isProtectedPath('.git/config'), true)
		assert.equal(isProtectedPath('nested/.git/HEAD'), true)
		assert.equal(isProtectedPath('clones/github.com/owner/repo@default/README.md'), true)
		assert.equal(isProtectedPath(path.resolve('clones')), true)
		assert.equal(isProtectedPath('.github/workflows/test.yml'), false)
		assert.equal(isProtectedPath('clones-not/file.txt'), false)
		assert.equal(isProtectedPath('templates/.gitignore'), false)
	})
})

describe('exclude', () => {
	// A source directory with excluded entries, parsed through the real config
	async function excludeSetup() {
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src')
		await writeTree(src, {
			'a.txt': '{{ name }}',
			'skip.txt': 'excluded file',
			'local/x.txt': 'excluded directory',
		})
		const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    dest: out/
    template:
      name: synced
    exclude: |
      skip.txt
      local/
`)
		const [{ files: [file] }] = await parseConfig()
		return { dir, file }
	}

	test('applies in template mode', async () => {
		const { copy } = await loadHelpers()
		const { dir, file } = await excludeSetup()
		const dest = path.join(dir, 'dest/')

		await copy(file.source, dest, true, file)

		assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'synced')
		assert.equal(await fs.pathExists(path.join(dest, 'skip.txt')), false)
		assert.equal(await fs.pathExists(path.join(dest, 'local')), false)
	})

	test('leaves excluded files out of the synced file list', async () => {
		const { getSyncedFileList } = await loadHelpers()
		const { file } = await excludeSetup()

		assert.deepEqual(await getSyncedFileList(file.source, file.dest, true, file), ['out/a.txt'])
	})

	for (const template of [false, true]) {
		test(`covers files nested below an excluded directory (template: ${template})`, async () => {
			const { copy, readfiles } = await loadHelpers()
			const dir = await makeTmpDir()
			const src = path.join(dir, 'src')
			await writeTree(src, {
				'a.txt': 'a',
				'local/x.txt': 'excluded',
				'local/sub/y.txt': 'excluded',
				'keep/k.txt': 'excluded',
				'keepsake.txt': 'not excluded',
			})
			const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    template: ${template}
    exclude: |
      local/
      keep
`)
			const [{ files: [file] }] = await parseConfig()
			const dest = path.join(dir, 'dest/')

			await copy(file.source, dest, true, file)

			assert.deepEqual((await readfiles(dest)).sort(), ['a.txt', 'keepsake.txt'])
		})
	}

	test('protects target files below an excluded directory from deleteOrphaned', async () => {
		const { copy } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src')
		const dest = path.join(dir, 'dest/')
		await writeTree(src, { 'a.txt': 'source' })
		await writeTree(dest, {
			'a.txt': 'old',
			'local/custom.txt': 'target only',
			'local/sub/deep.txt': 'target only',
			'keep/k.txt': 'target only',
			'localfile.txt': 'orphan',
			'orphan.txt': 'orphan',
		})
		const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    deleteOrphaned: true
    exclude: |
      local/
      keep
`)
		const [{ files: [file] }] = await parseConfig()

		await copy(file.source, dest, true, file)

		assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'source')
		assert.equal(await fs.pathExists(path.join(dest, 'local/custom.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'local/sub/deep.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'keep/k.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'localfile.txt')), false)
		assert.equal(await fs.pathExists(path.join(dest, 'orphan.txt')), false)
	})
})
