import * as path from 'path'

import { dedent } from './dedent.ts'

// GitHub rejects pull request bodies longer than this
export const PR_BODY_MAX_LENGTH = 65536

// withPrWarning puts this on top of an existing PR body while it is being resynced
export const PR_WARNING = '⚠️ This PR is being automatically resynced ⚠️'

// The changed files of one synced source, which the PR body lists
export interface ChangedFiles {
	header: string
	files: string[]
	// How many of its synced files did not change, which a line after the files says
	unchanged?: number
}

// The line after the files of a section that has unchanged files
function unchangedLine(unchanged: number | undefined): string[] {
	if (!unchanged) return []

	return [`...and ${unchanged} unchanged file${unchanged === 1 ? '' : 's'}`]
}

// What the PR body says besides the description and the changed files
export interface PrBodyOptions {
	// GITHUB_REPOSITORY, which the files are synced from
	sourceRepository: string
	serverUrl: string
	// PR_BODY
	prBody: string
	// The workflow run that the body links to
	runId: string | number
}

// The branch the PR comes from: BRANCH_PREFIX, with SOURCE_REPO_NAME replaced by the name of the
// source repository, and the target branch. A timestamp, if given, makes it unique
export function prBranchName(
	branchPrefix: string,
	sourceRepository: string,
	branch: string,
	timestamp?: number,
): string {
	const prefix = branchPrefix.replace(
		'SOURCE_REPO_NAME',
		sourceRepository.split('/')[1],
	)

	let newBranch = path
		.join(prefix, branch)
		.replace(/\\/g, '/')
		.replace(/\/\./g, '/')

	if (timestamp !== undefined) {
		newBranch += `-${timestamp}`
	}

	return newBranch
}

// The PR's head: its branch in the fork with FORK, otherwise in the repository
export function prHead(
	fork: string | false | undefined,
	owner: string,
	branch: string | undefined,
): string {
	return `${fork ? fork : owner}:${branch}`
}

// A PR without a body has null for it, which counts as empty
export function withPrWarning(body: string | null): string {
	// Tagged, so that only the template is dedented and the body keeps its indentation
	return dedent`
		${PR_WARNING}

		${body ?? ''}
	`
}

export function withoutPrWarning(body: string | null): string {
	return (body ?? '').replace(PR_WARNING, '')
}

export function renderPrBody(
	changedFiles: string,
	description: string | undefined,
	{ sourceRepository, serverUrl, prBody, runId }: PrBodyOptions,
): string {
	// Tagged, so that only the template is dedented and the interpolated content keeps its
	// indentation
	return dedent`
		${
		description ? description + '\n\n' : ''
	}synced local file(s) with [${sourceRepository}](${serverUrl}/${sourceRepository}).

		${prBody}

		${changedFiles}

		---

		This PR was created automatically by the [repo-sync-action](https://github.com/vaivars/repo-sync-action) workflow run [#${runId}](${serverUrl}/${sourceRepository}/actions/runs/${runId})
	`
}

// The body of the PR, with the changed files of each synced source
export function prBody(
	changedFiles: ChangedFiles[],
	description: string | undefined,
	options: PrBodyOptions,
): string {
	// The file list gets what the rest of the body leaves of GitHub's limit, keeping room for
	// the warning that withPrWarning adds on the next run
	const maxLength = PR_BODY_MAX_LENGTH
		- `${PR_WARNING}\n\n`.length
		- renderPrBody('', description, options).length
	return renderPrBody(formatChangedFiles(changedFiles, maxLength), description, options)
}

// Renders the changed files of each synced source ({ header, files }) as a collapsed list. Files
// that do not fit into maxLength characters are summed up in an "...and N more" line instead
export function formatChangedFiles(sections: ChangedFiles[], maxLength = Infinity): string {
	if (sections.length === 0) return ''

	const start = '<details>\n<summary>Changed files</summary>\n<ul>\n'
	const end = '\n</ul>\n</details>'
	const full = start
		+ sections
			.map(({ header, files, unchanged }) =>
				`<li>${header}\n\n${[...files, ...unchangedLine(unchanged)].join('\n')}</li>`
			)
			.join('')
		+ end
	if (full.length <= maxLength) return full

	// Only the files count: the unchanged line of a section goes with it when it does not fit
	const total = sections.reduce((count, { files }) => count + files.length, 0)
	const pieces: { text: string; isFile?: boolean }[] = sections.flatMap((
		{ header, files, unchanged },
		i,
	) => [
		{ text: `${i === 0 ? '' : '</li>'}<li>${header}\n` },
		...files.map((file) => ({ text: `\n${file}`, isFile: true })),
		...unchangedLine(unchanged).map((line) => ({ text: `\n${line}` })),
	])
	// Room for the "...and N more" line and the closing tags
	const reserve = `<li>...and ${total} more</li>`.length + end.length

	let text = start
	let listed = 0
	for (const piece of pieces) {
		if (text.length + piece.text.length + reserve > maxLength) break
		text += piece.text
		if (piece.isFile) listed++
	}

	return `${text}${text === start ? '<li>' : '\n'}...and ${total - listed} more</li>${end}`
}
