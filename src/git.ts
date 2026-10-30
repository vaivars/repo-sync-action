import * as core from '@actions/core'
import * as path from 'path'

import { authEnv, basicCredentials } from './auth.ts'
import config from './config.ts'
import type { MergeMethod, Repo } from './config.ts'
import {
	hasStatusChanges,
	parseGitDiffOutput,
	parseNameStatus,
	parseTreeDiff,
	parseTreeId,
} from './git-output.ts'
import type { NameStatusEntry, TreeDiffEntry } from './git-output.ts'
import { createOctokit, GitHub } from './github.ts'
import type { ExistingPr, PullRequest, RepoSession } from './github.ts'
import { execFile, execFileBuffer } from './helpers.ts'
import type { ExecOptions } from './helpers.ts'
import { commitMessage, defaultSyncMessage } from './messages.ts'
import { prBranchName } from './pull-request.ts'
import type { ChangedFiles } from './pull-request.ts'

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

// The environment that authenticates git's HTTPS requests, see auth.ts
function gitAuthEnv(): Record<string, string> {
	const basic = basicCredentials(GITHUB_TOKEN, {
		isInstallationToken: IS_INSTALLATION_TOKEN,
		isFineGrained: IS_FINE_GRAINED,
	})
	core.setSecret(basic)

	return authEnv(basic)
}

// The session for the repository being synced, which index.ts drives: it runs git in the clone,
// and hands the GitHub API calls to github.ts
export default class Git implements RepoSession {
	github: GitHub
	authEnv: Record<string, string>
	// Set by initRepo for the repository being synced
	repo!: Repo
	workingDir!: string
	gitUrl!: string
	lastCommitSha!: string
	baseBranch: string | undefined
	prBranch: string | undefined
	existingPr: ExistingPr | undefined

	constructor() {
		this.github = new GitHub(createOctokit(GITHUB_TOKEN), this, {
			fork: FORK,
			skipPr: SKIP_PR,
			defaultTitle: defaultSyncMessage(COMMIT_PREFIX, GITHUB_REPOSITORY),
			body: { sourceRepository: GITHUB_REPOSITORY, serverUrl: GITHUB_SERVER_URL, prBody: PR_BODY },
		})

		this.authEnv = gitAuthEnv()
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
		// No credentials in it, see auth.ts
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
		await this.github.createFork()
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
			const data = await this.github.getAuthenticatedUser()
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
		const newBranch = prBranchName(
			BRANCH_PREFIX,
			GITHUB_REPOSITORY,
			this.repo.branch,
			OVERWRITE_EXISTING_PR === false ? Math.round(new Date().getTime() / 1000) : undefined,
		)

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
		return this.github.isOneCommitPush()
	}

	originalCommitMessage(): string {
		return this.github.originalCommitMessage()
	}

	async getLastCommitSha(): Promise<void> {
		this.lastCommitSha = await this.exec(['rev-parse', 'HEAD'])
	}

	async changes(destination: string): Promise<string[]> {
		// gets array of git diffs for the destination, which either can be a file or a dict
		const output = await this.exec(['diff', 'HEAD', '--', destination])
		return Object.values(parseGitDiffOutput(output))
	}

	// The output is not trimmed, which would cut the spaces of a status or a path
	async hasChanges(): Promise<boolean> {
		const statusOutput = await this.exec(['status', '--porcelain', '-z'], { trimResult: false })

		return hasStatusChanges(statusOutput)
	}

	// The changes staged below dest, which the next commit makes. -M finds renames even when the
	// runner's git config turns diff.renames off
	async stagedChanges(dest: string): Promise<NameStatusEntry[]> {
		const output = await this.exec(['diff', '--cached', '--name-status', '-z', '-M', '--', dest], {
			trimResult: false,
		})

		return parseNameStatus(output)
	}

	async commit(msg?: string): Promise<string> {
		const message = commitMessage(
			msg,
			defaultSyncMessage(COMMIT_PREFIX, GITHUB_REPOSITORY),
			COMMIT_BODY,
		)
		return this.exec(['commit', '-m', message])
	}

	// Returns a git tree parsed for the specified commit sha
	async getTreeId(commitSha: string): Promise<string> {
		core.debug(`Getting treeId for commit ${commitSha}`)
		return parseTreeId(await this.exec(['cat-file', '-p', commitSha]))
	}

	async getTreeDiff(referenceTreeId: string, differenceTreeId: string): Promise<TreeDiffEntry[]> {
		// -z prints paths verbatim, so they are not quoted and can contain spaces
		const output = await this.exec(['diff-tree', '-z', '-r', referenceTreeId, differenceTreeId], {
			trimResult: false,
		})

		return parseTreeDiff(output)
	}

	// The content of a blob, as raw bytes: decoding them as text would corrupt binary files and
	// change the blob sha
	readBlob(blob: string): Promise<Buffer> {
		return execFileBuffer('git', ['cat-file', 'blob', blob], this.workingDir)
	}

	async uploadGitHubBlob(blob: string): Promise<unknown> {
		return this.github.uploadBlob(blob)
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

	async status(): Promise<string> {
		return this.exec(['status'])
	}

	async push(): Promise<string | void> {
		if (FORK) {
			// prBranch is set: config.ts rejects FORK together with SKIP_PR
			return this.execRemote(['push', '-u', 'fork', this.prBranch!, '--force'])
		}
		if (IS_INSTALLATION_TOKEN) {
			return await this.github.createVerifiedCommits()
		}
		// With SKIP_PR the commits go straight onto the base branch, which must not be force pushed
		return this.execRemote(['push', this.gitUrl, ...(SKIP_PR === false ? ['--force'] : [])])
	}

	// The PR side, in github.ts

	findExistingPr(): Promise<ExistingPr | undefined> {
		return this.github.findExistingPr()
	}

	setPrWarning(): Promise<void> {
		return this.github.setPrWarning()
	}

	removePrWarning(): Promise<void> {
		return this.github.removePrWarning()
	}

	createOrUpdatePr(
		changedFiles: ChangedFiles[],
		title: string | undefined,
		description: string | undefined,
	): Promise<PullRequest> {
		return this.github.createOrUpdatePr(changedFiles, title, description)
	}

	addPrLabels(labels: string[]): Promise<void> {
		return this.github.addPrLabels(labels)
	}

	addPrAssignees(assignees: string[]): Promise<void> {
		return this.github.addPrAssignees(assignees)
	}

	addPrReviewers(reviewers: string[]): Promise<void> {
		return this.github.addPrReviewers(reviewers)
	}

	addPrTeamReviewers(reviewers: string[]): Promise<void> {
		return this.github.addPrTeamReviewers(reviewers)
	}

	enablePrAutoMerge(
		pullRequest: PullRequest,
		mergeMethod: MergeMethod,
	): Promise<'enabled' | 'merged'> {
		return this.github.enablePrAutoMerge(pullRequest, mergeMethod)
	}
}
