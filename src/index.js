import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

import Git from './git.js'
import {
	addTrailingSlash,
	copy,
	dedent,
	getSyncedFileList,
	pathIsDirectory,
	remove,
} from './helpers.js'

import { default as config, parseConfig } from './config.js'

const {
	COMMIT_EACH_FILE,
	COMMIT_PREFIX,
	PR_LABELS,
	ASSIGNEES,
	DRY_RUN,
	TMP_DIR,
	SKIP_CLEANUP,
	OVERWRITE_EXISTING_PR,
	SKIP_PR,
	ORIGINAL_MESSAGE,
	COMMIT_AS_PR_TITLE,
	FORK,
	REVIEWERS,
	TEAM_REVIEWERS,
} = config

export async function run() {
	const git = new Git()

	const repos = await parseConfig()

	const prUrls = []

	for (const repo of repos) {
		await processRepository(repo, git, prUrls)
	}

	if (prUrls.length > 0) {
		core.setOutput('pull_request_urls', prUrls)
	}

	if (SKIP_CLEANUP === true) {
		core.info('Skipping cleanup')
		return
	}

	await remove(TMP_DIR)
	core.info('Cleanup complete')
}

async function processRepository(item, git, prUrls) {
	core.info(`Repository Info`)
	core.info(`Slug\t\t: ${item.repo.name}`)
	core.info(`Owner\t\t: ${item.repo.user}`)
	core.info(`Https Url\t: https://${item.repo.fullName}`)
	core.info(`Branch\t\t: ${item.repo.branch}`)
	core.info('\t')

	try {
		// Clone and setup the git repository locally
		await git.initRepo(item.repo)

		let existingPr
		if (SKIP_PR === false) {
			await git.createPrBranch()

			// Check for existing PR and add warning message that the PR maybe about to change
			existingPr = OVERWRITE_EXISTING_PR ? await git.findExistingPr() : undefined
			if (existingPr && DRY_RUN === false) {
				core.info(`Found existing PR ${existingPr.number}`)
				await git.setPrWarning()
			}
		}

		core.info(`Locally syncing file(s) between source and target repository`)
		const modified = []

		// Loop through all selected files of the source repo
		for (const file of item.files) {
			await syncFile(file, git, modified)
		}

		if (DRY_RUN) {
			core.warning('Dry run, no changes will be pushed')

			core.debug('Git Status:')
			core.debug(await git.status())

			return
		}

		const hasChanges = await git.hasChanges()
		const useOriginalMessage = ORIGINAL_MESSAGE && git.isOneCommitPush()
		const originalMessage = useOriginalMessage ? git.originalCommitMessage() : undefined

		if (hasChanges === false && modified.length < 1) {
			core.info('File(s) already up to date')

			if (existingPr) await git.removePrWarning()

			return
		}

		if (hasChanges === true) {
			core.debug(`Creating commit for remaining files`)

			const commitMessage = useOriginalMessage ? originalMessage : undefined
			await git.commit(commitMessage)
			modified.push({
				dest: git.workingDir,
				commitMessage: commitMessage,
			})
		}

		core.info(`Pushing changes to target repository`)
		await git.push()

		if (SKIP_PR === false) {
			const changedFiles = dedent(`
				<details>
				<summary>Changed files</summary>
				<ul>
				${modified.map((file) => `<li>${file.message}</li>`).join('')}
				</ul>
				</details>
			`)

			const useCommitAsPRTitle = COMMIT_AS_PR_TITLE && useOriginalMessage
			const prTitle = useCommitAsPRTitle
				? originalMessage.split('\n', 1)[0].trim()
				: undefined

			const pullRequest = await git.createOrUpdatePr(
				COMMIT_EACH_FILE ? changedFiles : '',
				prTitle,
			)

			core.notice(
				`Pull Request #${pullRequest.number} created/updated: ${pullRequest.html_url}`,
			)
			prUrls.push(pullRequest.html_url)

			if (PR_LABELS !== undefined && PR_LABELS.length > 0 && !FORK) {
				core.info(`Adding label(s) "${PR_LABELS.join(', ')}" to PR`)
				await git.addPrLabels(PR_LABELS)
			}

			if (ASSIGNEES !== undefined && ASSIGNEES.length > 0 && !FORK) {
				core.info(`Adding assignee(s) "${ASSIGNEES.join(', ')}" to PR`)
				await git.addPrAssignees(ASSIGNEES)
			}

			if (REVIEWERS !== undefined && REVIEWERS.length > 0 && !FORK) {
				core.info(`Adding reviewer(s) "${REVIEWERS.join(', ')}" to PR`)
				await git.addPrReviewers(REVIEWERS)
			}

			if (
				TEAM_REVIEWERS !== undefined
				&& TEAM_REVIEWERS.length > 0
				&& !FORK
			) {
				core.info(
					`Adding team reviewer(s) "${TEAM_REVIEWERS.join(', ')}" to PR`,
				)
				await git.addPrTeamReviewers(TEAM_REVIEWERS)
			}
		}

		core.info('\t')
	} catch (err) {
		core.setFailed(err.message)
		core.debug(err)
	}
}

async function syncFile(file, git, modified) {
	const fileExists = fs.existsSync(file.source)
	if (fileExists === false) {
		return core.warning(`Source ${file.source} not found`)
	}

	const localDestination = `${git.workingDir}/${file.dest}`

	const destExists = fs.existsSync(localDestination)
	if (destExists === true && file.replace === false) {
		return core.warning(
			`File(s) already exist(s) in destination and 'replace' option is set to false`,
		)
	}

	const isDirectory = await pathIsDirectory(file.source)
	const source = isDirectory
		? `${addTrailingSlash(file.source)}`
		: file.source
	const dest = isDirectory
		? `${addTrailingSlash(localDestination)}`
		: localDestination

	if (isDirectory) core.info(`Source is directory`)

	await copy(source, dest, isDirectory, file)

	await git.add(file.dest)

	// Commit each file separately, if option is set to false commit all files at once later
	if (COMMIT_EACH_FILE === true) {
		const hasChanges = await git.hasChanges()

		if (hasChanges === false) {
			return core.debug('File(s) already up to date')
		}

		core.debug(`Creating commit for file(s) ${file.dest}`)

		// Use different commit/pr message based on if the source is a directory or file
		const directory = isDirectory ? 'directory' : 'file'

		const syncedFiles = await getSyncedFileList(
			file.source,
			file.dest,
			isDirectory,
			file,
		)
		const fileStatuses = await git.getFileStatuses()

		const details = syncedFiles
			.map((filePath) => {
				const mode = fileStatuses[filePath] || ''
				let statusText = 'unchanged'
				if (mode.includes('A') || mode.includes('?')) statusText = 'created'
				if (mode.includes('M')) statusText = 'updated'
				if (mode.includes('D')) statusText = 'deleted'

				const relPath = isDirectory
					? path.relative(file.dest, filePath)
					: path.basename(filePath)
				return `\`${relPath}\` - ${statusText}`
			})
			.join('\n')

		const prMessage = dedent(`
			From remote ${directory} <code>${file.source}</code>, synced the following files:

			${details}
		`)

		const useOriginalMessage = ORIGINAL_MESSAGE && git.isOneCommitPush()
		const originalMessage = useOriginalMessage ? git.originalCommitMessage() : undefined

		const message = {
			true: {
				commit: useOriginalMessage
					? originalMessage
					: `${COMMIT_PREFIX} synced local '${file.dest}' with remote '${file.source}'`,
				pr: prMessage,
			},
			false: {
				commit: useOriginalMessage
					? originalMessage
					: `${COMMIT_PREFIX} created local '${file.dest}' from remote '${file.source}'`,
				pr: prMessage,
			},
		}

		await git.commit(message[destExists].commit)
		modified.push({
			dest: file.dest,
			source: file.source,
			message: message[destExists].pr,
			commitMessage: message[destExists].commit,
		})
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	run().catch((err) => {
		core.setFailed(err.message)
		core.debug(err)
	})
}
