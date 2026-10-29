import fs from 'fs-extra'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { gitIn, loadConfig, loadGit, makeTmpDir, prGit, silentCore } from './support.js'

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

// sync.yml values that a shell would run. Without spaces they are valid branch names
const SHELL_PATH = '$(touch pwned)'
const SHELL_BRANCH = '$(touch${IFS}pwned)'

// The environment that hands git the user:password pair as an HTTP header
function authEnv(credentials) {
	return {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(credentials).toString('base64')}`,
	}
}

// Serves the bare repos below root with git http-backend. Like a private repo on GitHub, a request
// without the expected Authorization header gets a 401. Every request's header is recorded
async function startGitServer(root, authorization) {
	const authorizations = []
	const server = http.createServer((req, res) => {
		authorizations.push(req.headers.authorization)
		if (req.headers.authorization !== authorization) {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end()
			return
		}

		const url = new URL(req.url, 'http://localhost')
		const backend = spawn('git', ['http-backend'], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: '1',
				// Allows pushes
				REMOTE_USER: 'test',
				REQUEST_METHOD: req.method,
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers['content-type'] ?? '',
				HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
				HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
			},
		})
		req.pipe(backend.stdin)

		// A CGI response: headers, a blank line, then the body
		const chunks = []
		backend.stdout.on('data', (chunk) => chunks.push(chunk))
		backend.on('close', () => {
			const output = Buffer.concat(chunks)
			const end = output.indexOf('\r\n\r\n')
			const headers = {}
			let status = 200
			for (const line of output.subarray(0, end).toString().split('\r\n')) {
				const [name, value] = line.split(/: (.*)/)
				if (name === 'Status') status = parseInt(value)
				else headers[name] = value
			}
			res.writeHead(status, headers).end(output.subarray(end + 4))
		})
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		authorizations,
		close: () => {
			server.closeAllConnections()
			server.close()
		},
	}
}

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

describe('Git credentials', () => {
	const repo = {
		fullName: 'ghe.example.com/owner/repo',
		uniqueName: 'ghe.example.com/owner/repo@default',
		host: 'ghe.example.com',
		user: 'owner',
		name: 'repo',
		branch: 'default',
	}
	// The user:password pairs that the token was put into the clone URL with. A bare token was the
	// user name with an empty password
	const cases = [
		{ config: {}, credentials: 'test-token:' },
		{ config: { IS_FINE_GRAINED: true }, credentials: 'oauth:test-token' },
		{ config: { IS_INSTALLATION_TOKEN: true }, credentials: 'x-access-token:test-token' },
	]

	for (const { config, credentials } of cases) {
		test(`passes ${credentials} to the clone and the fork push in the environment`, async () => {
			const commands = []
			const secrets = []
			const logs = []
			const git = await loadGit({
				config: { ...config, FORK: 'forker', GIT_USERNAME: 'u', GIT_EMAIL: 'e@example.com' },
				octokit: { repos: { createFork: async () => ({}) } },
				core: {
					...silentCore,
					debug: (message) => logs.push(message),
					setSecret: (secret) => secrets.push(secret),
				},
				commands,
			})

			await git.initRepo(repo)
			await git.createPrBranch()
			await git.push()

			const find = (name) => commands.find(({ args }) => args[0] === name)
			assert.deepEqual(find('clone'), {
				file: 'git',
				args: [
					'clone',
					'--depth',
					'1',
					'--',
					'https://ghe.example.com/owner/repo.git',
					path.join('tmp', repo.uniqueName),
				],
				env: authEnv(credentials),
			})
			// The fork remote is on the repo's host, which gets the same header
			assert.deepEqual(find('remote'), {
				file: 'git',
				args: ['remote', 'add', 'fork', 'https://ghe.example.com/forker/repo.git'],
				env: undefined,
			})
			assert.deepEqual(find('push'), {
				file: 'git',
				args: ['push', '-u', 'fork', 'repo-sync/source/default', '--force'],
				env: authEnv(credentials),
			})
			// Only the commands that talk to the server get the header
			assert.deepEqual(commands.filter(({ env }) => env).map(({ args }) => args[0]), [
				'clone',
				'push',
			])

			const basic = Buffer.from(credentials).toString('base64')
			assert.ok(secrets.includes(basic), 'the header is not masked')
			const leaks = [...commands.map(({ args }) => args.join(' ')), ...logs]
				.filter((text) => text.includes('test-token') || text.includes(basic))
			assert.deepEqual(leaks, [])
		})
	}
})

describe('Git against a git server', () => {
	const credentials = 'test-token:'
	const header = authEnv(credentials).GIT_CONFIG_VALUE_0
	const savedEnv = {}
	let root
	let server

	before(async () => {
		root = await makeTmpDir()
		server = await startGitServer(root, header.replace('Authorization: ', ''))
		// https://github.com/ leads to the test server, and nothing else from the machine's git
		// config applies
		const globalConfig = path.join(root, 'gitconfig')
		await fs.writeFile(
			globalConfig,
			`[url "${server.url}"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = main\n`,
		)
		const env = {
			GIT_CONFIG_GLOBAL: globalConfig,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
		}
		for (const [key, value] of Object.entries(env)) {
			savedEnv[key] = process.env[key]
			process.env[key] = value
		}
	})

	after(() => {
		server?.close()
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	})

	test('clones and pushes with the token in a header, not in argv or .git/config', async () => {
		const source = await makeRepo([{ 'a.txt': 'a' }])
		gitIn(source, 'branch', SHELL_BRANCH)
		gitIn(root, 'clone', '-q', '--bare', source, 'owner/repo.git')
		const bare = path.join(root, 'owner/repo.git')
		const { parseConfig } = await loadConfig(`'owner/repo@${SHELL_BRANCH}':\n  - a.txt\n`)
		const [{ repo }] = await parseConfig()
		const commands = []
		const logs = []
		const git = await loadGit({
			config: {
				TMP_DIR: path.join(root, 'work'),
				GIT_USERNAME: 'u',
				GIT_EMAIL: 'e@example.com',
				SKIP_PR: true,
			},
			core: { ...silentCore, debug: (message) => logs.push(message) },
			commands,
			run: true,
		})

		// A shell would have run $(touch …) where the action runs
		const cwd = process.cwd()
		process.chdir(root)
		try {
			await git.initRepo(repo)
			await fs.outputFile(path.join(git.workingDir, 'a.txt'), 'synced')
			await git.add('a.txt')
			await git.commit()
			await git.push()
		} finally {
			process.chdir(cwd)
		}

		// The sync.yml branch was cloned literally, and the commit reached it on the server
		assert.equal(git.baseBranch, SHELL_BRANCH)
		assert.equal(
			gitIn(bare, 'rev-parse', `refs/heads/${SHELL_BRANCH}`),
			gitIn(git.workingDir, 'rev-parse', 'HEAD'),
		)
		assert.equal(await fs.pathExists(path.join(root, 'pwned')), false)

		// Every request carried the header
		assert.ok(server.authorizations.length > 0)
		assert.deepEqual(
			[...new Set(server.authorizations)],
			[header.replace('Authorization: ', '')],
		)

		// The token is nowhere on disk, in argv or in the log
		const basic = Buffer.from(credentials).toString('base64')
		const gitConfig = await fs.readFile(path.join(git.workingDir, '.git/config'), 'utf8')
		assert.ok(!gitConfig.includes('test-token') && !gitConfig.includes(basic), gitConfig)
		assert.equal(
			gitIn(git.workingDir, 'config', 'remote.origin.url'),
			'https://github.com/owner/repo.git',
		)
		const leaks = [...commands.map(({ args }) => args.join(' ')), ...logs]
			.filter((text) => text.includes('test-token') || text.includes(basic))
		assert.deepEqual(leaks, [])
		assert.deepEqual(commands.filter(({ env }) => env).map(({ args }) => args[0]), [
			'clone',
			'push',
		])
	})
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
			gitUrl: 'https://github.com/owner/repo.git',
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

		assert.deepEqual(commands, [
			{
				file: 'git',
				args: ['push', 'https://github.com/owner/repo.git'],
				env: authEnv('test-token:'),
			},
		])
	})

	test('force pushes the recreated PR branch', async () => {
		const { commands } = await pushWith({ SKIP_PR: false })

		assert.deepEqual(commands, [
			{
				file: 'git',
				args: ['push', 'https://github.com/owner/repo.git', '--force'],
				env: authEnv('test-token:'),
			},
		])
	})

	test('force pushes the PR branch to the fork', async () => {
		const { commands } = await pushWith({ SKIP_PR: false, FORK: 'forker' })

		assert.deepEqual(commands, [
			{
				file: 'git',
				args: ['push', '-u', 'fork', 'repo-sync/source/default', '--force'],
				env: authEnv('test-token:'),
			},
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
})
