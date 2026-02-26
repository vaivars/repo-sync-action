import * as core from '@actions/core'
import { getInput } from 'action-input-parser'
import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import * as path from 'path'

const REPLACE_DEFAULT = true
const TEMPLATE_DEFAULT = false
const DELETE_ORPHANED_DEFAULT = false

let context

try {
	let isInstallationToken = false
	let token = getInput({
		key: 'GH_PAT',
	})

	if (!token) {
		token = getInput({
			key: 'GH_INSTALLATION_TOKEN',
		})
		isInstallationToken = true
		if (!token) {
			core.setFailed('You must provide either GH_PAT or GH_INSTALLATION_TOKEN')
			process.exit(1)
		}
	}

	context = {
		GITHUB_TOKEN: token,
		GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL || 'https://github.com',
		IS_INSTALLATION_TOKEN: isInstallationToken,
	}

	const inputs = {
		GIT_EMAIL: {},
		GIT_USERNAME: {},
		CONFIG_PATH: { default: '.github/sync.yml' },
		IS_FINE_GRAINED: { default: false },
		COMMIT_BODY: { default: '' },
		COMMIT_PREFIX: { default: '🔄' },
		COMMIT_EACH_FILE: { type: 'boolean', default: true },
		PR_LABELS: { default: ['sync'], type: 'array', disableable: true },
		PR_BODY: { default: '' },
		ASSIGNEES: { type: 'array' },
		REVIEWERS: { type: 'array' },
		TEAM_REVIEWERS: { type: 'array' },
		TMP_DIR: { default: `tmp-${Date.now().toString()}` },
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

	for (const [key, options] of Object.entries(inputs)) {
		context[key] = getInput({ key, ...options })
	}

	core.setSecret(context.GITHUB_TOKEN)

	core.debug(JSON.stringify(context, null, 2))

	while (fs.existsSync(context.TMP_DIR)) {
		context.TMP_DIR = `tmp-${Date.now().toString()}`
		core.warning(`TEMP_DIR already exists. Using "${context.TMP_DIR}" now.`)
	}
} catch (err) {
	core.setFailed(err.message)
	process.exit(1)
}

const parseRepoName = (fullRepo) => {
	let host = new URL(context.GITHUB_SERVER_URL).host

	if (fullRepo.startsWith('http')) {
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

const parseExclude = (text, src) => {
	if (text === undefined || typeof text !== 'string') return undefined

	const files = text.split('\n').filter((i) => i)

	return files.map((file) => path.join(src, file))
}

const parseFiles = (files) => {
	return files.map((item) => {
		if (typeof item === 'string') item = { source: item }

		if (item.source !== undefined) {
			return {
				source: item.source,
				dest: item.dest || item.source,
				template: item.template === undefined ? TEMPLATE_DEFAULT : item.template,
				replace: item.replace === undefined ? REPLACE_DEFAULT : item.replace,
				deleteOrphaned: item.deleteOrphaned === undefined
					? DELETE_ORPHANED_DEFAULT
					: item.deleteOrphaned,
				exclude: parseExclude(item.exclude, item.source),
			}
		}

		core.warning('Warn: No source files specified')
	})
}

const resolveRepoList = (reposValue, repoGroups) => {
	// If reposValue is already an array, return it as-is
	if (Array.isArray(reposValue)) {
		return reposValue
	}

	// If it's a string, check if it's a group reference
	if (typeof reposValue === 'string') {
		const trimmedValue = reposValue.trim()

		// Check if this is a group reference (no newlines, matches a group name)
		if (!trimmedValue.includes('\n') && repoGroups[trimmedValue]) {
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

			return groupRepos
		}

		// Otherwise, treat as newline-separated inline list
		// Each entry may be a group reference or a direct repo name
		const entries = reposValue
			.split('\n')
			.map((n) => n.trim())
			.filter((n) => n)

		return entries.flatMap((entry) => {
			if (repoGroups[entry] && Array.isArray(repoGroups[entry])) {
				core.debug(`Resolving repo group reference: ${entry}`)
				return repoGroups[entry]
			}
			return [entry]
		})
	}

	// Fallback for unexpected types
	core.warning(`Unexpected repos value type: ${typeof reposValue}`)
	return []
}

export async function parseConfig() {
	const fileContent = await fs.promises.readFile(context.CONFIG_PATH)

	const configObject = yaml.load(fileContent.toString())

	// Extract and validate repo_groups
	const repoGroups = configObject.repo_groups || {}

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

	const result = {}

	Object.keys(configObject).forEach((key) => {
		// Skip the repo_groups key as it's not a sync target
		if (key === 'repo_groups') {
			return
		}

		if (key === 'group') {
			const rawObject = configObject[key]

			const groups = Array.isArray(rawObject) ? rawObject : [rawObject]

			groups.forEach((group) => {
				const repos = resolveRepoList(group.repos, repoGroups)

				repos.forEach((name) => {
					const files = parseFiles(group.files)
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
			const files = parseFiles(configObject[key])
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

	return Object.values(result)
}

export default context
