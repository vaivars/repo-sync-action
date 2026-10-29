import * as core from '@actions/core'
import * as github from '@actions/github'
import { throttling } from '@octokit/plugin-throttling'
import { parse } from '@putout/git-status-porcelain'
import * as path from 'path'

import config from './config.ts'
import type { Repo } from './config.ts'

const {
	GITHUB_TOKEN,
	GITHUB_SERVER_URL,
	IS_INSTALLATION_TOKEN,
	IS_FINE_GRAINED,
	GIT_USERNAME,
	GIT_EMAIL,
	TMP_DIR,
	COMMIT_BODY,
	COMMIT_PREFIX,
	GITHUB_REPOSITORY,
	OVERWRITE_EXISTING_PR,
	SKIP_PR,
	PR_BODY,
	BRANCH_PREFIX,
	FORK,
} = config

import {
	dedent,
	execFile,
	execFileBuffer,
	formatChangedFiles,
	isReferenceExistsError,
	PR_BODY_MAX_LENGTH,
} from './helpers.ts'
import type { ChangedFiles, ExecOptions } from './helpers.ts'

type Octokit = ReturnType<typeof github.getOctokit>
// The REST endpoint methods, the only part of the client the action uses
type RestApi = Octokit['rest']
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

// One entry of git diff-tree between a commit's tree and its parent's
export interface TreeDiffEntry {
	newMode: string
	previousMode: string
	newBlob: string
	previousBlob: string
	change: string
	path: string
}

// The parts of a push event's payload that the action reads
type PushPayload = {
	commits: { message: string }[]
	before: string
	after: string
	repository: { name: string; owner: { login: string; name: string } }
}

// setPrWarning puts this on top of an existing PR body while it is being resynced
const PR_WARNING = '⚠️ This PR is being automatically resynced ⚠️'

// The environment that authenticates git's HTTPS requests. git reads http.extraHeader from it
// (git 2.31 or newer), so the token is neither in argv nor in a remote URL, which git would store
// in the clone's .git/config. Unlike a GIT_ASKPASS helper, it needs no script on disk, and the
// token never goes through git's credential helpers, which could store it
function authEnv(): Record<string, string> {
	// The user:password pairs of the https://<credentials>@host URLs used before. A bare token was
	// the user name with an empty password
	const credentials = `${IS_INSTALLATION_TOKEN ? 'x-access-token:' : ''}${
		IS_FINE_GRAINED ? 'oauth:' : ''
	}${GITHUB_TOKEN}`
	const basic = Buffer.from(credentials.includes(':') ? credentials : `${credentials}:`)
		.toString('base64')
	core.setSecret(basic)

	return {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
	}
}

export default class Git {
	github: RestApi
	authEnv: Record<string, string>
	// Set by initRepo for the repository being synced
	repo!: Repo
	workingDir!: string
	gitUrl!: string
	lastCommitSha!: string
	baseBranch: string | undefined
	prBranch: string | undefined
	existingPr: ExistingPr | undefined
	// The changes of the pushed commit by path, once getChangesFromLastCommit fetched them
	lastCommitChanges: Record<string, string> | undefined

	constructor() {
		const octokit = github.getOctokit(
			GITHUB_TOKEN,
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

		// We only need the rest client
		this.github = octokit.rest

		this.authEnv = authEnv()
	}

	// Runs git in the clone. Values from sync.yml and the inputs are passed as separate arguments,
	// never through a shell
	exec(args: string[], options?: ExecOptions): Promise<string> {
		return execFile('git', args, this.workingDir, options)
	}

	// Runs a git command that talks to the server, with the credentials in its environment
	execRemote(args: string[]): Promise<string> {
		return this.exec(args, { env: this.authEnv })
	}

	// Fails the repository unless name is a branch name that git takes as it is. git would read one
	// that starts with - as an option, and check-ref-format prints something else for @{-1}
	async checkBranchName(name: string, description: string): Promise<void> {
		const valid = !name.startsWith('-')
			&& await execFile('git', ['check-ref-format', '--branch', name]).then(
				(output) => output === name,
				() => false,
			)
		if (!valid) {
			const quoted = JSON.stringify(name)
			throw new Error(
				`The ${description} ${quoted} of ${this.repo.fullName} is not a valid branch name`,
			)
		}
	}

	async initRepo(repo: Repo): Promise<void> {
		// Reset repo specific values
		this.existingPr = undefined
		this.prBranch = undefined
		this.baseBranch = undefined

		// Set values to current repo
		this.repo = repo
		this.workingDir = path.join(TMP_DIR, repo.uniqueName)
		// No credentials in it, see authEnv
		this.gitUrl = `https://${repo.fullName}.git`

		if (repo.branch !== 'default') {
			await this.checkBranchName(repo.branch, 'branch')
		}

		await this.clone()
		await this.setIdentity()
		await this.getBaseBranch()
		await this.getLastCommitSha()

		if (FORK) {
			// On the repo's host, so the push to it gets the same credentials
			const forkUrl = `https://${repo.host}/${FORK}/${repo.name}.git`
			await this.createFork()
			await this.createRemote(forkUrl)
		}
	}

	async createFork(): Promise<void> {
		core.debug(
			`Creating fork with OWNER: ${this.repo.user} and REPO: ${this.repo.name}`,
		)
		await this.github.repos.createFork({
			owner: this.repo.user,
			repo: this.repo.name,
		})
	}

	async createRemote(forkUrl: string): Promise<string> {
		return this.exec(['remote', 'add', 'fork', forkUrl])
	}

	async clone(): Promise<string> {
		core.debug(`Cloning ${this.repo.fullName} into ${this.workingDir}`)

		const branch = this.repo.branch !== 'default' ? ['--branch', this.repo.branch] : []
		// Runs where the action runs, since the clone does not exist yet
		return execFile(
			'git',
			['clone', '--depth', '1', ...branch, '--', this.gitUrl, this.workingDir],
			undefined,
			{ env: this.authEnv },
		)
	}

	async setIdentity(): Promise<void> {
		let username = GIT_USERNAME
		let email = GIT_EMAIL

		// Fill in only what was not given. An installation token cannot read GET /user
		if ((!username || !email) && !IS_INSTALLATION_TOKEN) {
			const { data } = await this.github.users.getAuthenticated()
			username = username || data.login
			// The profile email is null when it is private, so use the account's noreply address
			email = email || data.email || `${data.id}+${data.login}@users.noreply.github.com`
		}

		// An installation token without GIT_USERNAME/GIT_EMAIL: git still needs an identity to
		// create the local commits
		username = username || 'github-actions[bot]'
		email = email || '41898282+github-actions[bot]@users.noreply.github.com'

		core.debug(`Setting git user to email: ${email}, username: ${username}`)

		await this.exec(['config', '--local', 'user.name', username])
		await this.exec(['config', '--local', 'user.email', email])
	}

	async getBaseBranch(): Promise<void> {
		this.baseBranch = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])
		await this.checkBranchName(this.baseBranch, 'base branch')
	}

	async createPrBranch(): Promise<void> {
		const prefix = BRANCH_PREFIX.replace(
			'SOURCE_REPO_NAME',
			GITHUB_REPOSITORY.split('/')[1],
		)

		let newBranch = path
			.join(prefix, this.repo.branch)
			.replace(/\\/g, '/')
			.replace(/\/\./g, '/')

		if (OVERWRITE_EXISTING_PR === false) {
			newBranch += `-${Math.round(new Date().getTime() / 1000)}`
		}

		await this.checkBranchName(newBranch, 'PR branch')

		core.debug(`Creating PR Branch ${newBranch}`)

		await this.exec(['checkout', '-b', newBranch])

		this.prBranch = newBranch
	}

	async add(file: string): Promise<string> {
		// After --, a dest starting with - is still a path
		return this.exec(['add', '-f', '--', file])
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

	parseGitDiffOutput(string: string): Record<string, string> {
		// parses git diff output and returns a dictionary mapping the file path to the diff output for this file
		// split diff into separate entries for separate files. \ndiff --git should be a reliable way to detect the separation, as content of files is always indented
		return `\n${string}`
			.split('\ndiff --git')
			.slice(1)
			.reduce((resultDict, fileDiff) => {
				const lines = fileDiff.split('\n')
				const lastHeaderLineIndex = lines.findIndex((line) => line.startsWith('+++'))
				if (lastHeaderLineIndex === -1) return resultDict // ignore binary files

				const plainDiff = lines
					.slice(lastHeaderLineIndex + 1)
					.join('\n')
					.trim()
				const filePath = lines[lastHeaderLineIndex].startsWith('+++ b/')
					? lines[lastHeaderLineIndex].slice(6) // remove '+++ b/' for every file except removed files
					: lines[lastHeaderLineIndex - 1].slice(6) // remove '--- a/' for removed files
				return { ...resultDict, [filePath]: plainDiff }
			}, {})
	}

	async getChangesFromLastCommit(source: string): Promise<string[]> {
		// gets array of git diffs for the source, which either can be a file or a dict
		if (this.lastCommitChanges === undefined) {
			const payload = github.context.payload as PushPayload
			const diff = await this.github.repos.compareCommits({
				mediaType: {
					format: 'diff',
				},
				owner: payload.repository.owner.name,
				repo: payload.repository.name,
				base: payload.before,
				head: payload.after,
			})
			// With the diff media type, the response is the diff as text
			this.lastCommitChanges = this.parseGitDiffOutput(diff.data as unknown as string)
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

	async getLastCommitSha(): Promise<void> {
		this.lastCommitSha = await this.exec(['rev-parse', 'HEAD'])
	}

	async changes(destination: string): Promise<string[]> {
		// gets array of git diffs for the destination, which either can be a file or a dict
		const output = await this.exec(['diff', 'HEAD', '--', destination])
		return Object.values(this.parseGitDiffOutput(output))
	}

	async getFileStatuses(): Promise<Record<string, string>> {
		const statusOutput = await this.exec(['status', '--porcelain'])
		return parse(statusOutput).reduce((acc: Record<string, string>, entry) => {
			acc[entry.name] = entry.mode
			return acc
		}, {})
	}

	async hasChanges(): Promise<boolean> {
		const statusOutput = await this.exec(['status', '--porcelain'])

		return parse(statusOutput).length !== 0
	}

	async commit(msg?: string): Promise<string> {
		let message = msg !== undefined
			? msg
			: `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`
		if (COMMIT_BODY) {
			message += `\n\n${COMMIT_BODY}`
		}
		return this.exec(['commit', '-m', message])
	}

	// Returns a git tree parsed for the specified commit sha
	async getTreeId(commitSha: string): Promise<string> {
		core.debug(`Getting treeId for commit ${commitSha}`)
		const output = (await this.exec(['cat-file', '-p', commitSha])).split('\n')

		const commitHeaders = output.slice(
			0,
			output.findIndex((e) => e === ''),
		)
		// A commit always has a tree header
		const tree = commitHeaders
			.find((e) => e.startsWith('tree'))!
			.replace('tree ', '')

		return tree
	}

	async getTreeDiff(referenceTreeId: string, differenceTreeId: string): Promise<TreeDiffEntry[]> {
		// -z prints paths verbatim, so they are not quoted and can contain spaces
		const output = await this.exec(['diff-tree', '-z', '-r', referenceTreeId, differenceTreeId], {
			trimResult: false,
		})

		// Each entry is ":<mode> <mode> <blob> <blob> <change>" NUL "<path>" NUL
		const fields = output.split('\0')
		const diff = []
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const [newMode, previousMode, newBlob, previousBlob, change] = fields[i]
				.replace(/^:/, '')
				.split(' ')
			const path = fields[i + 1]

			diff.push({
				newMode,
				previousMode,
				newBlob,
				previousBlob,
				change,
				path,
			})
		}

		return diff
	}

	// Creates the blob objects in GitHub for the files that are not in the previous commit only
	async uploadGitHubBlob(blob: string): Promise<unknown> {
		core.debug(`Uploading GitHub Blob for blob ${blob}`)
		// Raw bytes: decoding them as text would corrupt binary files and change the blob sha
		const fileContent = await execFileBuffer('git', ['cat-file', 'blob', blob], this.workingDir)

		// Creates the blob. We don't need to store the response because the local sha is the same and we can use it to reference the blob
		return this.github.git.createBlob({
			owner: this.repo.user,
			repo: this.repo.name,
			content: fileContent.toString('base64'),
			encoding: 'base64',
		})
	}

	// Gets the commit list in chronological order
	async getCommitsToPush(): Promise<string[]> {
		const output = await this.exec([
			'log',
			'--format=%H',
			'--reverse',
			`${SKIP_PR === false ? `` : `origin/`}${this.baseBranch}..HEAD`,
		])

		const commits = output.split('\n')
		return commits
	}

	async getCommitMessage(commitSha: string): Promise<string> {
		return await this.exec(['log', '-1', '--format=%B', commitSha])
	}

	// A wrapper for running all the flow to generate all the pending commits using the GitHub API
	async createGithubVerifiedCommits(): Promise<void> {
		core.debug(`Creating Commits using GitHub API`)
		const commits = await this.getCommitsToPush()

		if (SKIP_PR === false) {
			// Creates the PR branch if doesn't exists
			try {
				await this.github.git.createRef({
					owner: this.repo.user,
					repo: this.repo.name,
					sha: this.lastCommitSha,
					ref: 'refs/heads/' + this.prBranch,
				})

				core.debug(`Created new branch ${this.prBranch}`)
			} catch (error) {
				// If the branch exists ignores the error
				if (!isReferenceExistsError(error)) throw error
			}
		}

		for (const commit of commits) {
			await this.createGithubCommit(commit)
		}

		core.debug(
			`Updating branch ${SKIP_PR === false ? this.prBranch : this.baseBranch} ref`,
		)
		await this.github.git.updateRef({
			owner: this.repo.user,
			repo: this.repo.name,
			ref: `heads/${SKIP_PR === false ? this.prBranch : this.baseBranch}`,
			sha: this.lastCommitSha,
			// The PR branch is recreated on every run. The base branch must only fast-forward, so
			// that the update fails instead of dropping commits pushed while the sync ran
			force: SKIP_PR === false,
		})
		core.debug(`Commit using GitHub API completed`)
	}

	async status(): Promise<string> {
		return this.exec(['status'])
	}

	async push(): Promise<string | void> {
		if (FORK) {
			// prBranch is set: FORK goes with a PR
			return this.execRemote(['push', '-u', 'fork', this.prBranch!, '--force'])
		}
		if (IS_INSTALLATION_TOKEN) {
			return await this.createGithubVerifiedCommits()
		}
		// With SKIP_PR the commits go straight onto the base branch, which must not be force pushed
		return this.execRemote(['push', this.gitUrl, ...(SKIP_PR === false ? ['--force'] : [])])
	}

	async findExistingPr(): Promise<ExistingPr | undefined> {
		const { data } = await this.github.pulls.list({
			owner: this.repo.user,
			repo: this.repo.name,
			state: 'open',
			head: `${FORK ? FORK : this.repo.user}:${this.prBranch}`,
		})

		this.existingPr = data[0]

		return this.existingPr
	}

	// The PR that findExistingPr found or createOrUpdatePr created, which the methods that change a
	// PR are only called with
	get pr(): ExistingPr {
		return this.existingPr!
	}

	async setPrWarning(): Promise<void> {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.pr.number,
			// Tagged, so that only the template is dedented and the body keeps its indentation
			body: dedent`
				${PR_WARNING}

				${this.pr.body}
			`,
		})
	}

	async removePrWarning(): Promise<void> {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.pr.number,
			// A PR without a body fails here, as it did before
			body: this.pr.body!.replace(PR_WARNING, ''),
		})
	}

	renderPrBody(changedFiles: string, description: string | undefined): string {
		// Tagged, so that only the template is dedented and the interpolated content keeps its
		// indentation
		return dedent`
			${
			description ? description + '\n\n' : ''
		}synced local file(s) with [${GITHUB_REPOSITORY}](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}).

			${PR_BODY}

			${changedFiles}

			---

			This PR was created automatically by the [repo-sync-action](https://github.com/vaivars/repo-sync-action) workflow run [#${
			process.env.GITHUB_RUN_ID || 0
		}](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || 0})
		`
	}

	// changedFiles are the { header, files } sections that formatChangedFiles renders
	async createOrUpdatePr(
		changedFiles: ChangedFiles[],
		title: string | undefined,
		description: string | undefined,
	): Promise<PullRequest> {
		// The file list gets what the rest of the body leaves of GitHub's limit, keeping room for
		// the warning that setPrWarning adds on the next run
		const maxLength = PR_BODY_MAX_LENGTH
			- `${PR_WARNING}\n\n`.length
			- this.renderPrBody('', description).length
		const body = this.renderPrBody(formatChangedFiles(changedFiles, maxLength), description)

		const prTitle = title === undefined
			? `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`
			: title

		if (this.existingPr) {
			core.info(`Overwriting existing PR`)

			const { data } = await this.github.pulls.update({
				owner: this.repo.user,
				repo: this.repo.name,
				title: prTitle,
				pull_number: this.existingPr.number,
				body: body,
			})

			return data
		}

		core.info(`Creating new PR`)

		const { data } = await this.github.pulls.create({
			owner: this.repo.user,
			repo: this.repo.name,
			title: prTitle,
			body: body,
			head: `${FORK ? FORK : this.repo.user}:${this.prBranch}`,
			// Set by initRepo
			base: this.baseBranch!,
		})

		this.existingPr = data

		return data
	}

	async addPrLabels(labels: string[]): Promise<void> {
		await this.github.issues.addLabels({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.pr.number,
			labels: labels,
		})
	}

	async addPrAssignees(assignees: string[]): Promise<void> {
		await this.github.issues.addAssignees({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.pr.number,
			assignees: assignees,
		})
	}

	async addPrReviewers(reviewers: string[]): Promise<void> {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.pr.number,
			reviewers: reviewers,
		})
	}

	async addPrTeamReviewers(reviewers: string[]): Promise<void> {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.pr.number,
			team_reviewers: reviewers,
		})
	}

	async createGithubCommit(commitSha: string): Promise<void> {
		const [treeId, parentTreeId, commitMessage] = await Promise.all([
			this.getTreeId(`${commitSha}`),
			this.getTreeId(`${commitSha}~1`),
			this.getCommitMessage(commitSha),
		])

		const treeDiff = await this.getTreeDiff(treeId, parentTreeId)
		core.debug(`Uploading the blobs to GitHub`)
		const blobsToCreate = treeDiff.filter((e) => e.newMode !== '000000') // Do not upload the blob if it is being removed

		await Promise.all(
			blobsToCreate.map((e) => this.uploadGitHubBlob(e.newBlob)),
		)
		core.debug(`Creating a GitHub tree`)
		const tree = treeDiff.map((e): TreeEntry => {
			let newBlob: string | null = e.newBlob
			if (e.newMode === '000000') {
				// Set the sha to null to remove the file
				e.newMode = e.previousMode
				newBlob = null
			}

			const entry = {
				path: e.path,
				// git diff-tree prints one of the modes a tree entry can have
				mode: e.newMode as TreeEntry['mode'],
				type: 'blob' as const,
				sha: newBlob,
			}

			return entry
		})

		let treeSha
		try {
			const request = await this.github.git.createTree({
				owner: this.repo.user,
				repo: this.repo.name,
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
		const request = await this.github.git.createCommit({
			owner: this.repo.user,
			repo: this.repo.name,
			message: commitMessage,
			parents: [this.lastCommitSha],
			tree: treeSha,
		})
		this.lastCommitSha = request.data.sha
	}
}
