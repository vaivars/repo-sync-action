import esmock from 'esmock'
import fs from 'fs-extra'
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, test } from 'node:test'

import { isReferenceExistsError } from '../src/helpers.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
// nunjucks only renders templates below the working directory, so scratch files live in the repo
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

// A Git instance with a fixed config and a fake Octokit. With `commands`, shell commands are
// recorded there instead of being run
async function loadGit({ config = {}, octokit = {}, commands } = {}) {
	const helpers = await import('../src/helpers.js')
	const mocks = {
		'../src/config.js': { default: { ...GIT_CONFIG, ...config } },
		'@actions/github': { getOctokit: () => ({ rest: octokit }), context: {} },
	}
	if (commands) {
		mocks['../src/helpers.js'] = {
			...helpers,
			execCmd: async (command) => {
				commands.push(command)
				return ''
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

			assert.deepEqual(commands, [
				`git config --local user.name "${username}" && git config --local user.email "${email}"`,
			])
		})
	}
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
