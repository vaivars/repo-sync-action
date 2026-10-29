import * as core from '@actions/core'
import { getInput } from 'action-input-parser'
import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import * as os from 'os'
import * as path from 'path'

// The token, where GitHub is, and the action's inputs
export type Config = {
	GITHUB_TOKEN: string
	GITHUB_SERVER_URL: string
	IS_INSTALLATION_TOKEN: boolean
	GIT_EMAIL: string | undefined
	GIT_USERNAME: string | undefined
	CONFIG_PATH: string
	IS_FINE_GRAINED: boolean
	COMMIT_BODY: string
	COMMIT_PREFIX: string
	COMMIT_EACH_FILE: boolean
	// Undefined when the input is 'false'
	PR_LABELS: string[] | undefined
	PR_BODY: string
	ASSIGNEES: string[] | undefined
	REVIEWERS: string[] | undefined
	TEAM_REVIEWERS: string[] | undefined
	TMP_DIR: string
	DRY_RUN: boolean
	SKIP_CLEANUP: boolean
	OVERWRITE_EXISTING_PR: boolean
	GITHUB_REPOSITORY: string
	SKIP_PR: boolean
	ORIGINAL_MESSAGE: boolean
	COMMIT_AS_PR_TITLE: boolean
	BRANCH_PREFIX: string
	// false when not set, undefined when the input is 'false'
	FORK: string | false | undefined
}

// A repository to sync to, from a sync.yml key or repos entry like owner/name@branch
export interface Repo {
	// host/owner/name
	fullName: string
	// host/owner/name@branch, which names its clone in TMP_DIR
	uniqueName: string
	host: string
	user: string
	name: string
	// 'default' for the repository's default branch
	branch: string
}

// A truthy value renders the source as a LiquidJS template, and an object holds its variables
export type Template = boolean | Record<string, unknown>

// A file entry of sync.yml, with the defaults filled in
export interface FileEntry {
	source: string
	dest: string
	template: Template
	replace: boolean
	deleteOrphaned: boolean
	// The excluded paths, each prefixed with source
	exclude: string[] | undefined
}

// A repository with all the file entries that sync.yml lists for it
export interface SyncTarget {
	repo: Repo
	files: FileEntry[]
}

// A file entry as sync.yml has it. YAML values keep whatever type they were written with: only
// source and exclude are checked, the others pass through as they are
interface FileEntryYml {
	source?: unknown
	dest?: string
	template?: Template
	replace?: boolean
	deleteOrphaned?: boolean
	exclude?: unknown
}

// An entry of the group list in sync.yml
interface GroupYml {
	repos?: unknown
	files?: unknown
}

type InputOptions = Parameters<typeof getInput>[1]
type InputKey = Exclude<
	keyof Config,
	'GITHUB_TOKEN' | 'GITHUB_SERVER_URL' | 'IS_INSTALLATION_TOKEN'
>

const REPLACE_DEFAULT = true
const TEMPLATE_DEFAULT = false
const DELETE_ORPHANED_DEFAULT = false

// Clones go to the runner's temporary directory, outside the workspace that templates can read
const tmpDirIn = (parent: string) => path.join(parent, `repo-sync-${Date.now().toString()}`)

let context: Config

try {
	let isInstallationToken = false
	let token = getInput('GH_PAT', {})

	if (!token) {
		token = getInput('GH_INSTALLATION_TOKEN', {})
		isInstallationToken = true
		if (!token) {
			core.setFailed('You must provide either GH_PAT or GH_INSTALLATION_TOKEN')
			process.exit(1)
		}
	}

	const tokens = {
		// getInput returns a string for an input without a type
		GITHUB_TOKEN: token as string,
		GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL || 'https://github.com',
		IS_INSTALLATION_TOKEN: isInstallationToken,
	}

	// The defaults are declared in action.yml, which the runner applies. The same values are repeated
	// here for runs outside of Actions; tests/config.test.ts checks that the two agree
	const inputs: Record<InputKey, InputOptions> = {
		GIT_EMAIL: {},
		GIT_USERNAME: {},
		CONFIG_PATH: { default: '.github/sync.yml' },
		IS_FINE_GRAINED: { type: 'boolean', default: false },
		COMMIT_BODY: { default: '' },
		COMMIT_PREFIX: { default: '🔄' },
		COMMIT_EACH_FILE: { type: 'boolean', default: true },
		PR_LABELS: { default: ['sync'], type: 'array', disableable: true },
		PR_BODY: { default: '' },
		ASSIGNEES: { type: 'array' },
		REVIEWERS: { type: 'array' },
		TEAM_REVIEWERS: { type: 'array' },
		TMP_DIR: { default: tmpDirIn(process.env.RUNNER_TEMP || os.tmpdir()) },
		DRY_RUN: { type: 'boolean', default: false },
		SKIP_CLEANUP: { type: 'boolean', default: false },
		OVERWRITE_EXISTING_PR: { type: 'boolean', default: true },
		GITHUB_REPOSITORY: { required: true },
		SKIP_PR: { type: 'boolean', default: false },
		ORIGINAL_MESSAGE: { type: 'boolean', default: false },
		COMMIT_AS_PR_TITLE: { type: 'boolean', default: false },
		BRANCH_PREFIX: { default: 'repo-sync/SOURCE_REPO_NAME' },
		FORK: { default: false, disableable: true },
	}

	const values: Record<string, unknown> = { ...tokens }
	for (const [key, options] of Object.entries(inputs)) {
		values[key] = getInput(key, options)
	}
	// getInput returns a string, boolean or array as each input's options say, which Config spells out
	context = values as Config

	core.setSecret(context.GITHUB_TOKEN)

	core.debug(JSON.stringify(context, null, 2))

	while (fs.existsSync(context.TMP_DIR)) {
		context.TMP_DIR = tmpDirIn(path.dirname(context.TMP_DIR))
		core.warning(`TEMP_DIR already exists. Using "${context.TMP_DIR}" now.`)
	}
} catch (err) {
	core.setFailed((err as Error).message)
	process.exit(1)
}

const parseRepoName = (fullRepo: string): Repo => {
	let host = new URL(context.GITHUB_SERVER_URL).host

	if (/^https?:\/\//.test(fullRepo)) {
		const url = new URL(fullRepo)
		host = url.host

		fullRepo = url.pathname.replace(/^\/+/, '') // Remove leading slash

		core.info('Using custom host')
	}

	const user = fullRepo.split('/')[0]
	const name = fullRepo.split('/')[1].split('@')[0]
	const branch = fullRepo.split('@')[1] || 'default'

	return {
		fullName: `${host}/${user}/${name}`,
		uniqueName: `${host}/${user}/${name}@${branch}`,
		host,
		user,
		name,
		branch,
	}
}

const parseExclude = (text: unknown, src: string): string[] | undefined => {
	if (text === undefined || typeof text !== 'string') return undefined

	const files = text.split('\n').filter((i) => i)

	return files.map((file) => path.join(src, file))
}

// Returns the valid file entries. A missing or empty list yields none, and parseConfig skips the
// repo with a warning if it ends up without any files
const parseFiles = (files: unknown, target: string): FileEntry[] => {
	if (!Array.isArray(files)) return []

	return files.flatMap((item: unknown) => {
		if (typeof item === 'string') item = { source: item }

		const entry = item as FileEntryYml | null | undefined
		if (typeof entry?.source === 'string' && entry.source !== '') {
			return [{
				source: entry.source,
				dest: entry.dest || entry.source,
				template: entry.template === undefined ? TEMPLATE_DEFAULT : entry.template,
				replace: entry.replace === undefined ? REPLACE_DEFAULT : entry.replace,
				deleteOrphaned: entry.deleteOrphaned === undefined
					? DELETE_ORPHANED_DEFAULT
					: entry.deleteOrphaned,
				exclude: parseExclude(entry.exclude, entry.source),
			}]
		}

		core.warning(`Skipping a file entry for ${target} without a source: ${JSON.stringify(item)}`)
		return []
	})
}

// The repo names of a repos value. The entries of a list are not checked, they pass through as
// YAML has them
export const resolveRepoList = (
	reposValue: unknown,
	repoGroups: Record<string, unknown>,
): string[] => {
	// If reposValue is already an array, return it as-is
	if (Array.isArray(reposValue)) {
		return reposValue as string[]
	}

	// If it's a string, check if it's a group reference
	if (typeof reposValue === 'string') {
		const trimmedValue = reposValue.trim()

		// Check if this is a group reference (no newlines, matches a group name)
		// Only the groups sync.yml defines, not the properties every object inherits
		if (
			!trimmedValue.includes('\n')
			&& Object.hasOwn(repoGroups, trimmedValue)
			&& repoGroups[trimmedValue]
		) {
			core.debug(`Resolving repo group reference: ${trimmedValue}`)
			const groupRepos = repoGroups[trimmedValue]

			if (!Array.isArray(groupRepos)) {
				core.warning(
					`Repo group "${trimmedValue}" is not an array, treating as inline list`,
				)
				return reposValue
					.split('\n')
					.map((n) => n.trim())
					.filter((n) => n)
			}

			return groupRepos as string[]
		}

		// Otherwise, treat as newline-separated inline list
		// Each entry may be a group reference or a direct repo name
		const entries = reposValue
			.split('\n')
			.map((n) => n.trim())
			.filter((n) => n)

		return entries.flatMap((entry) => {
			if (Object.hasOwn(repoGroups, entry) && Array.isArray(repoGroups[entry])) {
				core.debug(`Resolving repo group reference: ${entry}`)
				return repoGroups[entry] as string[]
			}
			return [entry]
		})
	}

	// Fallback for unexpected types
	core.warning(`Unexpected repos value type: ${typeof reposValue}`)
	return []
}

export async function parseConfig(): Promise<SyncTarget[]> {
	const fileContent = await fs.promises.readFile(context.CONFIG_PATH)

	// Not validated: a file that is not a mapping fails or is skipped below, as it did in JavaScript
	const configObject = yaml.load(fileContent.toString()) as Record<string, unknown>

	// Extract and validate repo_groups
	const repoGroups = (configObject.repo_groups || {}) as Record<string, unknown>

	// Validate repo_groups structure
	if (repoGroups && typeof repoGroups === 'object') {
		Object.keys(repoGroups).forEach((groupName) => {
			if (!Array.isArray(repoGroups[groupName])) {
				core.warning(
					`Repo group "${groupName}" should be an array of repository strings`,
				)
			}
		})
		core.debug(
			`Loaded ${Object.keys(repoGroups).length} repo group(s): ${
				Object.keys(repoGroups).join(', ')
			}`,
		)
	}

	const result: Record<string, SyncTarget> = {}

	Object.keys(configObject).forEach((key) => {
		// Skip the repo_groups key as it's not a sync target
		if (key === 'repo_groups') {
			return
		}

		if (key === 'group') {
			const rawObject = configObject[key]

			const groups = (Array.isArray(rawObject) ? rawObject : [rawObject]) as GroupYml[]

			groups.forEach((group) => {
				const repos = resolveRepoList(group.repos, repoGroups)

				repos.forEach((name) => {
					const files = parseFiles(group.files, name)
					const repo = parseRepoName(name)

					if (result[repo.uniqueName] !== undefined) {
						result[repo.uniqueName].files.push(...files)
						return
					}

					result[repo.uniqueName] = {
						repo,
						files,
					}
				})
			})
		} else {
			const files = parseFiles(configObject[key], key)
			const repo = parseRepoName(key)

			if (result[repo.uniqueName] !== undefined) {
				result[repo.uniqueName].files.push(...files)
				return
			}

			result[repo.uniqueName] = {
				repo,
				files,
			}
		}
	})

	return Object.values(result).filter(({ repo, files }) => {
		if (files.length > 0) return true

		core.warning(`Skipping ${repo.uniqueName}: it has no files to sync`)
		return false
	})
}

export default context
