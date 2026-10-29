import * as core from '@actions/core'
import * as github from '@actions/github'
import { throttling } from '@octokit/plugin-throttling'
import { parse } from '@putout/git-status-porcelain'
import * as path from 'path'

import config from './config.js'

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
} from './helpers.js'

// setPrWarning puts this on top of an existing PR body while it is being resynced
const PR_WARNING = '⚠️ This PR is being automatically resynced ⚠️'

// The environment that authenticates git's HTTPS requests. git reads http.extraHeader from it
// (git 2.31 or newer), so the token is neither in argv nor in a remote URL, which git would store
// in the clone's .git/config. Unlike a GIT_ASKPASS helper, it needs no script on disk, and the
// token never goes through git's credential helpers, which could store it
function authEnv() {
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
	exec(args, options) {
		return execFile('git', args, this.workingDir, options)
	}

	// Runs a git command that talks to the server, with the credentials in its environment
	execRemote(args) {
		return this.exec(args, { env: this.authEnv })
	}

	// Fails the repository unless name is a branch name that git takes as it is. git would read one
	// that starts with - as an option, and check-ref-format prints something else for @{-1}
	async checkBranchName(name, description) {
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

	async initRepo(repo) {
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

	async createFork() {
		core.debug(
			`Creating fork with OWNER: ${this.repo.user} and REPO: ${this.repo.name}`,
		)
		await this.github.repos.createFork({
			owner: this.repo.user,
			repo: this.repo.name,
		})
	}

	async createRemote(forkUrl) {
		return this.exec(['remote', 'add', 'fork', forkUrl])
	}

	async clone() {
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

	async setIdentity() {
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

	async getBaseBranch() {
		this.baseBranch = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])
		await this.checkBranchName(this.baseBranch, 'base branch')
	}

	async createPrBranch() {
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

	async add(file) {
		// After --, a dest starting with - is still a path
		return this.exec(['add', '-f', '--', file])
	}

	isOneCommitPush() {
		return (
			github.context.eventName === 'push'
			&& github.context.payload.commits.length === 1
		)
	}

	originalCommitMessage() {
		return github.context.payload.commits[0].message
	}

	parseGitDiffOutput(string) {
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

	async getChangesFromLastCommit(source) {
		// gets array of git diffs for the source, which either can be a file or a dict
		if (this.lastCommitChanges === undefined) {
			const diff = await this.github.repos.compareCommits({
				mediaType: {
					format: 'diff',
				},
				owner: github.context.payload.repository.owner.name,
				repo: github.context.payload.repository.name,
				base: github.context.payload.before,
				head: github.context.payload.after,
			})
			this.lastCommitChanges = this.parseGitDiffOutput(diff.data)
		}
		if (source.endsWith('/')) {
			return Object.keys(this.lastCommitChanges)
				.filter((filePath) => filePath.startsWith(source))
				.reduce((result, key) => [...result, this.lastCommitChanges[key]], [])
		} else {
			return this.lastCommitChanges[source] === undefined
				? []
				: [this.lastCommitChanges[source]]
		}
	}

	async getLastCommitSha() {
		this.lastCommitSha = await this.exec(['rev-parse', 'HEAD'])
	}

	async changes(destination) {
		// gets array of git diffs for the destination, which either can be a file or a dict
		const output = await this.exec(['diff', 'HEAD', '--', destination])
		return Object.values(this.parseGitDiffOutput(output))
	}

	async getFileStatuses() {
		const statusOutput = await this.exec(['status', '--porcelain'])
		return parse(statusOutput).reduce((acc, entry) => {
			acc[entry.name] = entry.mode
			return acc
		}, {})
	}

	async hasChanges() {
		const statusOutput = await this.exec(['status', '--porcelain'])

		return parse(statusOutput).length !== 0
	}

	async commit(msg) {
		let message = msg !== undefined
			? msg
			: `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`
		if (COMMIT_BODY) {
			message += `\n\n${COMMIT_BODY}`
		}
		return this.exec(['commit', '-m', message])
	}

	// Returns a git tree parsed for the specified commit sha
	async getTreeId(commitSha) {
		core.debug(`Getting treeId for commit ${commitSha}`)
		const output = (await this.exec(['cat-file', '-p', commitSha])).split('\n')

		const commitHeaders = output.slice(
			0,
			output.findIndex((e) => e === ''),
		)
		const tree = commitHeaders
			.find((e) => e.startsWith('tree'))
			.replace('tree ', '')

		return tree
	}

	async getTreeDiff(referenceTreeId, differenceTreeId) {
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
	async uploadGitHubBlob(blob) {
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
	async getCommitsToPush() {
		const output = await this.exec([
			'log',
			'--format=%H',
			'--reverse',
			`${SKIP_PR === false ? `` : `origin/`}${this.baseBranch}..HEAD`,
		])

		const commits = output.split('\n')
		return commits
	}

	async getCommitMessage(commitSha) {
		return await this.exec(['log', '-1', '--format=%B', commitSha])
	}

	// A wrapper for running all the flow to generate all the pending commits using the GitHub API
	async createGithubVerifiedCommits() {
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

	async status() {
		return this.exec(['status'])
	}

	async push() {
		if (FORK) {
			return this.execRemote(['push', '-u', 'fork', this.prBranch, '--force'])
		}
		if (IS_INSTALLATION_TOKEN) {
			return await this.createGithubVerifiedCommits()
		}
		// With SKIP_PR the commits go straight onto the base branch, which must not be force pushed
		return this.execRemote(['push', this.gitUrl, ...(SKIP_PR === false ? ['--force'] : [])])
	}

	async findExistingPr() {
		const { data } = await this.github.pulls.list({
			owner: this.repo.user,
			repo: this.repo.name,
			state: 'open',
			head: `${FORK ? FORK : this.repo.user}:${this.prBranch}`,
		})

		this.existingPr = data[0]

		return this.existingPr
	}

	async setPrWarning() {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			// Tagged, so that only the template is dedented and the body keeps its indentation
			body: dedent`
				${PR_WARNING}

				${this.existingPr.body}
			`,
		})
	}

	async removePrWarning() {
		await this.github.pulls.update({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			body: this.existingPr.body.replace(PR_WARNING, ''),
		})
	}

	renderPrBody(changedFiles, description) {
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
	async createOrUpdatePr(changedFiles, title, description) {
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
			base: this.baseBranch,
		})

		this.existingPr = data

		return data
	}

	async addPrLabels(labels) {
		await this.github.issues.addLabels({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			labels: labels,
		})
	}

	async addPrAssignees(assignees) {
		await this.github.issues.addAssignees({
			owner: this.repo.user,
			repo: this.repo.name,
			issue_number: this.existingPr.number,
			assignees: assignees,
		})
	}

	async addPrReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			reviewers: reviewers,
		})
	}

	async addPrTeamReviewers(reviewers) {
		await this.github.pulls.requestReviewers({
			owner: this.repo.user,
			repo: this.repo.name,
			pull_number: this.existingPr.number,
			team_reviewers: reviewers,
		})
	}

	async createGithubCommit(commitSha) {
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
		const tree = treeDiff.map((e) => {
			if (e.newMode === '000000') {
				// Set the sha to null to remove the file
				e.newMode = e.previousMode
				e.newBlob = null
			}

			const entry = {
				path: e.path,
				mode: e.newMode,
				type: 'blob',
				sha: e.newBlob,
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
			error.message = `Cannot create a new GitHub Tree: ${error.message}`
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
