import * as core from '@actions/core'
import * as fs from 'fs'
import { pathToFileURL } from 'url'

import { changedFiles } from './changes.ts'
import { errorDetails } from './errors.ts'
import Git from './git.ts'
import type { ExistingPr } from './github.ts'
import {
	addTrailingSlash,
	copy,
	getSyncedFileList,
	isProtectedPath,
	pathIsDirectory,
	remove,
	setTmpDir,
} from './helpers.ts'
import { fileCommitMessage, originalMessageOf, prDescription, prTitle } from './messages.ts'

import { default as config, parseConfig } from './config.ts'
import type { FileEntry, SyncTarget } from './config.ts'
import type { ChangedFiles } from './pull-request.ts'

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
	PR_AUTOMERGE,
	PR_AUTOMERGE_METHOD,
} = config

// A commit the sync made: one per file entry with COMMIT_EACH_FILE, and one with the files left over
interface SyncCommit {
	dest: string
	source?: string
	commitMessage: string | undefined
}

export async function run(): Promise<void> {
	setTmpDir(TMP_DIR)

	const git = new Git()

	const repos = await parseConfig()

	const prUrls: string[] = []

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

async function processRepository(item: SyncTarget, git: Git, prUrls: string[]): Promise<void> {
	core.info(`Repository Info`)
	core.info(`Slug\t\t: ${item.repo.name}`)
	core.info(`Owner\t\t: ${item.repo.user}`)
	core.info(`Https Url\t: https://${item.repo.fullName}`)
	core.info(`Branch\t\t: ${item.repo.branch}`)
	core.info('\t')

	try {
		// Clone and setup the git repository locally
		await git.initRepo(item.repo)

		let existingPr: ExistingPr | undefined
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
		const modified: SyncCommit[] = []
		// What the PR body lists: the changes that each entry staged
		const entryChanges: ChangedFiles[] = []

		// Loop through all selected files of the source repo
		for (const file of item.files) {
			await syncFile(file, git, modified, entryChanges)
		}

		if (DRY_RUN) {
			core.warning('Dry run, no changes will be pushed')

			core.debug('Git Status:')
			core.debug(await git.status())

			return
		}

		const hasChanges = await git.hasChanges()
		const originalMessage = originalMessageOf(ORIGINAL_MESSAGE, git)
		const prBody = prDescription(originalMessage)

		if (hasChanges === false && modified.length < 1) {
			core.info('File(s) already up to date')

			if (existingPr) await git.removePrWarning()

			return
		}

		if (hasChanges === true) {
			core.debug(`Creating commit for remaining files`)

			// The original message, or Git's default without one
			await git.commit(originalMessage)
			modified.push({
				dest: git.workingDir,
				commitMessage: originalMessage,
			})
		}

		core.info(`Pushing changes to target repository`)
		await git.push()

		if (SKIP_PR === false) {
			const pullRequest = await git.createOrUpdatePr(
				entryChanges,
				prTitle(originalMessage, COMMIT_AS_PR_TITLE),
				prBody,
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

			if (PR_AUTOMERGE && !FORK) {
				core.info(`Enabling auto-merge (${PR_AUTOMERGE_METHOD}) on PR`)
				const automerge = await git.enablePrAutoMerge(pullRequest, PR_AUTOMERGE_METHOD)
				if (automerge === 'merged') {
					core.notice(
						`Pull Request #${pullRequest.number} had no required checks or reviews to wait for and was merged`,
					)
				}
			}
		}

		core.info('\t')
	} catch (err) {
		core.setFailed((err as Error).message)
		core.debug(errorDetails(err))
	}
}

async function syncFile(
	file: FileEntry,
	git: Git,
	modified: SyncCommit[],
	entryChanges: ChangedFiles[],
): Promise<void> {
	if (isProtectedPath(file.source)) {
		return core.warning(`Source ${file.source} is inside .git or TMP_DIR and is not synced`)
	}

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

	// What the PR body lists for the entry, read before a commit takes it out of the index. Without
	// COMMIT_EACH_FILE the changes of all entries stay staged, so only those below dest are read
	const changes = await stagedChangesOf(file, isDirectory, git)
	if (changes) entryChanges.push(changes)

	// Commit each file separately, if option is set to false commit all files at once later
	if (COMMIT_EACH_FILE === true) {
		const hasChanges = await git.hasChanges()

		if (hasChanges === false) {
			return core.debug('File(s) already up to date')
		}

		core.debug(`Creating commit for file(s) ${file.dest}`)

		const commitMessage = fileCommitMessage(originalMessageOf(ORIGINAL_MESSAGE, git), {
			prefix: COMMIT_PREFIX,
			source: file.source,
			dest: file.dest,
			destExists,
		})

		await git.commit(commitMessage)
		modified.push({
			dest: file.dest,
			source: file.source,
			commitMessage,
		})
	}
}

// What the PR body lists for an entry: the changes staged below its dest, unless there are none.
// dest is a pathspec, so when the dests of two entries overlap, a file below both of them can be
// listed under each
async function stagedChangesOf(
	file: FileEntry,
	isDirectory: boolean,
	git: Git,
): Promise<ChangedFiles | undefined> {
	const changes = await git.stagedChanges(file.dest)
	if (changes.length === 0) return undefined

	const syncedFiles = await getSyncedFileList(file.source, file.dest, isDirectory, file)
	return changedFiles({ source: file.source, dest: file.dest, isDirectory }, syncedFiles, changes)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	run().catch((err: unknown) => {
		core.setFailed((err as Error).message)
		core.debug(errorDetails(err))
	})
}
