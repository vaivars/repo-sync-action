import * as core from '@actions/core'
import * as github from '@actions/github'
import { throttling } from '@octokit/plugin-throttling'

import type { Repo } from './config.ts'
import { parseGitDiffOutput } from './git-output.ts'
import type { TreeDiffEntry } from './git-output.ts'
import { prBody, prHead, withoutPrWarning, withPrWarning } from './pull-request.ts'
import type { ChangedFiles, PrBodyOptions } from './pull-request.ts'

export type Octokit = ReturnType<typeof github.getOctokit>
// The REST endpoint methods, the only part of the client the action uses
export type RestApi = Octokit['rest']
type TreeEntry = NonNullable<Parameters<RestApi['git']['createTree']>[0]>['tree'][number]

// The parts of an open pull request that the action reads
export interface ExistingPr {
	number: number
	body: string | null
}

// A pull request that createOrUpdatePr created or updated
export interface PullRequest extends ExistingPr {
	html_url: string
}

// What GitHub reads from, and writes back to, the Git session of the repository being synced
export interface RepoSession {
	repo: Repo
	baseBranch: string | undefined
	prBranch: string | undefined
	existingPr: ExistingPr | undefined
	// The commit the next API commit goes on, and the branch is updated to at the end
	lastCommitSha: string
	// The local git reads that the API commits are made from
	getCommitsToPush(): Promise<string[]>
	getTreeId(commitSha: string): Promise<string>
	getTreeDiff(referenceTreeId: string, differenceTreeId: string): Promise<TreeDiffEntry[]>
	getCommitMessage(commitSha: string): Promise<string>
	readBlob(blob: string): Promise<Buffer>
}

// The inputs that the API calls depend on
export interface GitHubOptions {
	// FORK: the account whose fork the PR comes from
	fork: string | false | undefined
	skipPr: boolean
	// The PR title when there is no other
	defaultTitle: string
	// What the PR body says besides the description and the changed files
	body: Omit<PrBodyOptions, 'runId'>
}

// The parts of a push event's payload that the action reads
type PushPayload = {
	commits: { message: string }[]
	before: string
	after: string
	repository: { name: string; owner: { login: string; name: string } }
}

// The parts of Octokit's RequestError that isReferenceExistsError reads
interface RequestErrorLike {
	status?: unknown
	message: string
}

// GitHub's answer when createRef targets a branch that already exists. Octokit
// appends the docs URL to the message, so match its start, not all of it.
export function isReferenceExistsError(error: unknown): boolean {
	const requestError = error as RequestErrorLike
	return requestError.status === 422 && requestError.message.startsWith('Reference already exists')
}

// A client for the GitHub API that waits out rate limits
export function createOctokit(token: string): Octokit {
	return github.getOctokit(
		token,
		{
			baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
			throttle: {
				onRateLimit: (retryAfter) => {
					core.debug(
						`Hit GitHub API rate limit, retrying after ${retryAfter}s`,
					)
					return true
				},
				onSecondaryRateLimit: (retryAfter) => {
					core.debug(
						`Hit secondary GitHub API rate limit, retrying after ${retryAfter}s`,
					)
					return true
				},
			},
		},
		throttling,
	)
}

// The tree entries that make a commit's changes on top of its parent's tree. A file the commit
// removes gets a null sha
export function treeEntries(treeDiff: TreeDiffEntry[]): TreeEntry[] {
	return treeDiff.map((e) => {
		const removed = e.newMode === '000000'

		return {
			path: e.path,
			// git diff-tree prints one of the modes a tree entry can have
			mode: (removed ? e.previousMode : e.newMode) as TreeEntry['mode'],
			type: 'blob',
			// Set the sha to null to remove the file
			sha: removed ? null : e.newBlob,
		}
	})
}

// The GitHub side of syncing one repository: its fork, its pull request, the commits that an
// installation token makes through the API, and the event that triggered the run
export class GitHub {
	api: RestApi
	session: RepoSession
	options: GitHubOptions
	// The changes of the pushed commit by path, once getChangesFromLastCommit fetched them
	lastCommitChanges: Record<string, string> | undefined

	constructor(api: RestApi, session: RepoSession, options: GitHubOptions) {
		this.api = api
		this.session = session
		this.options = options
	}

	// The repository's owner and name, as the API takes them
	get target(): { owner: string; repo: string } {
		return { owner: this.session.repo.user, repo: this.session.repo.name }
	}

	// The PR that findExistingPr found or createOrUpdatePr created, which the methods that change a
	// PR are only called with
	get pr(): ExistingPr {
		return this.session.existingPr!
	}

	async getAuthenticatedUser(): Promise<{ login: string; id: number; email: string | null }> {
		const { data } = await this.api.users.getAuthenticated()
		return data
	}

	async createFork(): Promise<void> {
		const { repo } = this.session
		core.debug(
			`Creating fork with OWNER: ${repo.user} and REPO: ${repo.name}`,
		)
		await this.api.repos.createFork({
			owner: repo.user,
			repo: repo.name,
		})
	}

	isOneCommitPush(): boolean {
		return (
			github.context.eventName === 'push'
			&& (github.context.payload as PushPayload).commits.length === 1
		)
	}

	originalCommitMessage(): string {
		return (github.context.payload as PushPayload).commits[0].message
	}

	// The diffs of the pushed commits for the source, which either can be a file or a directory
	async getChangesFromLastCommit(source: string): Promise<string[]> {
		if (this.lastCommitChanges === undefined) {
			const payload = github.context.payload as PushPayload
			const diff = await this.api.repos.compareCommits({
				mediaType: {
					format: 'diff',
				},
				owner: payload.repository.owner.name,
				repo: payload.repository.name,
				base: payload.before,
				head: payload.after,
			})
			// With the diff media type, the response is the diff as text
			this.lastCommitChanges = parseGitDiffOutput(diff.data as unknown as string)
		}
		const lastCommitChanges = this.lastCommitChanges
		if (source.endsWith('/')) {
			return Object.keys(lastCommitChanges)
				.filter((filePath) => filePath.startsWith(source))
				.reduce((result: string[], key) => [...result, lastCommitChanges[key]], [])
		} else {
			return lastCommitChanges[source] === undefined
				? []
				: [lastCommitChanges[source]]
		}
	}

	// Creates the blob objects in GitHub for the files that are not in the previous commit only
	async uploadBlob(blob: string): Promise<unknown> {
		core.debug(`Uploading GitHub Blob for blob ${blob}`)
		const fileContent = await this.session.readBlob(blob)

		// Creates the blob. We don't need to store the response because the local sha is the same and we can use it to reference the blob
		return this.api.git.createBlob({
			...this.target,
			content: fileContent.toString('base64'),
			encoding: 'base64',
		})
	}

	// A wrapper for running all the flow to generate all the pending commits using the GitHub API
	async createVerifiedCommits(): Promise<void> {
		const { session } = this
		const { skipPr } = this.options
		core.debug(`Creating Commits using GitHub API`)
		const commits = await session.getCommitsToPush()

		if (skipPr === false) {
			// Creates the PR branch if doesn't exists
			try {
				await this.api.git.createRef({
					...this.target,
					sha: session.lastCommitSha,
					ref: 'refs/heads/' + session.prBranch,
				})

				core.debug(`Created new branch ${session.prBranch}`)
			} catch (error) {
				// If the branch exists ignores the error
				if (!isReferenceExistsError(error)) throw error
			}
		}

		for (const commit of commits) {
			await this.createCommit(commit)
		}

		core.debug(
			`Updating branch ${skipPr === false ? session.prBranch : session.baseBranch} ref`,
		)
		await this.api.git.updateRef({
			...this.target,
			ref: `heads/${skipPr === false ? session.prBranch : session.baseBranch}`,
			sha: session.lastCommitSha,
			// The PR branch is recreated on every run. The base branch must only fast-forward, so
			// that the update fails instead of dropping commits pushed while the sync ran
			force: skipPr === false,
		})
		core.debug(`Commit using GitHub API completed`)
	}

	// Makes a local commit once more through the API, on top of the last one
	async createCommit(commitSha: string): Promise<void> {
		const { session } = this
		const [treeId, parentTreeId, commitMessage] = await Promise.all([
			session.getTreeId(`${commitSha}`),
			session.getTreeId(`${commitSha}~1`),
			session.getCommitMessage(commitSha),
		])

		const treeDiff = await session.getTreeDiff(treeId, parentTreeId)
		core.debug(`Uploading the blobs to GitHub`)
		const blobsToCreate = treeDiff.filter((e) => e.newMode !== '000000') // Do not upload the blob if it is being removed

		await Promise.all(
			blobsToCreate.map((e) => this.uploadBlob(e.newBlob)),
		)
		core.debug(`Creating a GitHub tree`)
		const tree = treeEntries(treeDiff)

		let treeSha
		try {
			const request = await this.api.git.createTree({
				...this.target,
				tree,
				base_tree: parentTreeId,
			})
			treeSha = request.data.sha
		} catch (error) {
			const requestError = error as Error
			requestError.message = `Cannot create a new GitHub Tree: ${requestError.message}`
			throw error
		}

		core.debug(`Creating a commit for the GitHub tree`)
		const request = await this.api.git.createCommit({
			...this.target,
			message: commitMessage,
			parents: [session.lastCommitSha],
			tree: treeSha,
		})
		session.lastCommitSha = request.data.sha
	}

	async findExistingPr(): Promise<ExistingPr | undefined> {
		const { session } = this
		const { data } = await this.api.pulls.list({
			...this.target,
			state: 'open',
			head: prHead(this.options.fork, session.repo.user, session.prBranch),
		})

		session.existingPr = data[0]

		return session.existingPr
	}

	async setPrWarning(): Promise<void> {
		await this.api.pulls.update({
			...this.target,
			pull_number: this.pr.number,
			body: withPrWarning(this.pr.body),
		})
	}

	async removePrWarning(): Promise<void> {
		await this.api.pulls.update({
			...this.target,
			pull_number: this.pr.number,
			// A PR without a body fails here, as it did before
			body: withoutPrWarning(this.pr.body!),
		})
	}

	// changedFiles are the { header, files } sections that formatChangedFiles renders
	async createOrUpdatePr(
		changedFiles: ChangedFiles[],
		title: string | undefined,
		description: string | undefined,
	): Promise<PullRequest> {
		const { session } = this
		const body = prBody(changedFiles, description, {
			...this.options.body,
			runId: process.env.GITHUB_RUN_ID || 0,
		})

		const prTitle = title === undefined ? this.options.defaultTitle : title

		if (session.existingPr) {
			core.info(`Overwriting existing PR`)

			const { data } = await this.api.pulls.update({
				...this.target,
				title: prTitle,
				pull_number: session.existingPr.number,
				body: body,
			})

			return data
		}

		core.info(`Creating new PR`)

		const { data } = await this.api.pulls.create({
			...this.target,
			title: prTitle,
			body: body,
			head: prHead(this.options.fork, session.repo.user, session.prBranch),
			// Set by initRepo
			base: session.baseBranch!,
		})

		session.existingPr = data

		return data
	}

	async addPrLabels(labels: string[]): Promise<void> {
		await this.api.issues.addLabels({
			...this.target,
			issue_number: this.pr.number,
			labels: labels,
		})
	}

	async addPrAssignees(assignees: string[]): Promise<void> {
		await this.api.issues.addAssignees({
			...this.target,
			issue_number: this.pr.number,
			assignees: assignees,
		})
	}

	async addPrReviewers(reviewers: string[]): Promise<void> {
		await this.api.pulls.requestReviewers({
			...this.target,
			pull_number: this.pr.number,
			reviewers: reviewers,
		})
	}

	async addPrTeamReviewers(reviewers: string[]): Promise<void> {
		await this.api.pulls.requestReviewers({
			...this.target,
			pull_number: this.pr.number,
			team_reviewers: reviewers,
		})
	}
}
