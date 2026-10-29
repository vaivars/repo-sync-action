import type * as actionsCore from '@actions/core'
import esmock from 'esmock'
import fs from 'fs-extra'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { after } from 'node:test'

import type { Config } from '../src/config.ts'
import type Git from '../src/git.ts'
import type { ExecOptions } from '../src/helpers.ts'

// The @actions/core functions a test replaces
export type CoreMock = Partial<typeof actionsCore>

// A fake Octokit REST client: the endpoint methods a test calls, by scope. Each takes the request's
// parameters, whose type the test chooses
export type FakeApi = Record<string, Record<string, (params: never) => unknown>>

// A program that Git ran
export interface Command {
	file: string
	args: string[]
	env: Record<string, string> | undefined
}

// The parameters of a PR that prGit's fake Octokit created or updated
export interface PrRequest {
	title?: string
	body: string
}

export const ROOT_DIR = path.resolve(import.meta.dirname, '..')
// Templates only render below the working directory, so scratch files live in the repo. Test
// files run in parallel, each in its own process, so each process gets its own directory
export const TMP_ROOT = path.join(ROOT_DIR, `.tmp/tests-${process.pid}`)

after(() => fs.remove(TMP_ROOT))

export async function makeTmpDir(): Promise<string> {
	await fs.ensureDir(TMP_ROOT)
	return fs.mkdtemp(path.join(TMP_ROOT, 'case-'))
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [file, content] of Object.entries(files)) {
		await fs.outputFile(path.join(root, file), content)
	}
}

export function gitIn(cwd: string, ...args: string[]): string {
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

export const silentCore = {
	debug: () => {},
	info: () => {},
	warning: () => {},
	setSecret: () => {},
}

// helpers.ts with @actions/core silenced; readdir sorted so that dot entries come first
export async function loadHelpers(): Promise<typeof import('../src/helpers.ts')> {
	return esmock('../src/helpers.ts', {
		'@actions/core': silentCore,
		'fs-extra': {
			default: { ...fs, readdir: async (dir: string) => (await fs.readdir(dir)).sort() },
		},
	})
}

// Sets the action's inputs, from INPUT_ variables like the runner does, with syncYml as sync.yml
async function setInputs(syncYml: string, inputs: Record<string, string | undefined>) {
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
}

// config.ts reads its inputs when it is imported, so every call loads a fresh copy of it
export async function loadConfig(
	syncYml: string,
	inputs: Record<string, string | undefined> = {},
): Promise<{
	context: Config & Record<string, unknown>
	parseConfig: typeof import('../src/config.ts').parseConfig
	resolveRepoList: typeof import('../src/config.ts').resolveRepoList
	warnings: string[]
}> {
	await setInputs(syncYml, inputs)

	const warnings: string[] = []
	const config = await esmock<typeof import('../src/config.ts')>('../src/config.ts', {
		'@actions/core': { ...silentCore, warning: (message: string) => warnings.push(message) },
	})
	return {
		context: config.default,
		parseConfig: config.parseConfig,
		resolveRepoList: config.resolveRepoList,
		warnings,
	}
}

// What process.exit throws while configFailure loads config.ts
class ExitError extends Error {
	code: number | string | null | undefined

	constructor(code: number | string | null | undefined) {
		super(`process.exit(${code})`)
		this.code = code
	}
}

// How config.ts fails the run for these inputs: the messages it passes to core.setFailed, and the
// code it then exits with, which stops loading it here instead
export async function configFailure(
	inputs: Record<string, string | undefined>,
): Promise<{ failures: string[]; code: number | string | null | undefined }> {
	await setInputs('', inputs)

	const failures: string[] = []
	const exit = process.exit
	process.exit = (code) => {
		throw new ExitError(code)
	}
	try {
		await esmock('../src/config.ts', {
			'@actions/core': { ...silentCore, setFailed: (message: string) => failures.push(message) },
		})
	} catch (error) {
		if (error instanceof ExitError) return { failures, code: error.code }
		throw error
	} finally {
		process.exit = exit
	}
	throw new Error('config.ts did not fail the run')
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

// A Git instance with a fixed config, a fake Octokit and `core` for @actions/core. With
// `commands`, the programs it runs are recorded there as { file, args, env }. They are run only
// with `run`, otherwise they print what `outputs` has for their arguments. Branch names are always
// checked by the real git check-ref-format
export async function loadGit(
	{ config = {}, octokit = {}, core = silentCore, commands, outputs = {}, run = false }: {
		config?: Partial<Config>
		octokit?: FakeApi
		core?: CoreMock
		commands?: Command[]
		outputs?: Record<string, string>
		run?: boolean
	} = {},
): Promise<Git> {
	// Each module gets its mocks directly, bottom up. esmock's global mocks would put the URL of a
	// mocked package below node_modules into the URLs of the .ts modules below, which Node then
	// refuses to strip the types of
	const helpers = await esmock<typeof import('../src/helpers.ts')>('../src/helpers.ts', {
		'@actions/core': core,
	})
	const github = await esmock.strict<typeof import('../src/github.ts')>('../src/github.ts', {
		'@actions/core': core,
		'@actions/github': { getOctokit: () => ({ rest: octokit }), context: {} },
	})
	const mocks: Record<string, unknown> = {
		'@actions/core': core,
		'../src/config.ts': { default: { ...GIT_CONFIG, ...config } },
		'../src/github.ts': github,
		'../src/helpers.ts': helpers,
	}
	if (commands) {
		const printed: Record<string, string> = { 'rev-parse --abbrev-ref HEAD': 'main', ...outputs }
		mocks['../src/helpers.ts'] = {
			...helpers,
			execFile: async (
				file: string,
				args: string[],
				workingDir?: string,
				options: ExecOptions = {},
			) => {
				if (args[0] !== 'check-ref-format') commands.push({ file, args, env: options.env })
				if (run || args[0] === 'check-ref-format') {
					return helpers.execFile(file, args, workingDir, options)
				}
				return printed[args.join(' ')] ?? ''
			},
		}
	}
	const { default: Git } = await esmock.strict<typeof import('../src/git.ts')>(
		'../src/git.ts',
		mocks,
	)
	return new Git()
}

// A Git instance whose fake Octokit records the parameters of every PR it creates or updates
export async function prGit(
	config: Partial<Config> = {},
): Promise<{ git: Git; requests: PrRequest[] }> {
	const requests: PrRequest[] = []
	const respond = async (params: PrRequest) => {
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
