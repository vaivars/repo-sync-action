// One entry of git diff-tree between a commit's tree and its parent's
export interface TreeDiffEntry {
	newMode: string
	previousMode: string
	newBlob: string
	previousBlob: string
	change: string
	path: string
}

// Splits git diff output by file: the path of each file, mapped to the diff of its content.
// Binary files have no diff of their content and are left out
export function parseGitDiffOutput(string: string): Record<string, string> {
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

// The tree of a commit, from what git cat-file -p prints for it
export function parseTreeId(catFileOutput: string): string {
	const output = catFileOutput.split('\n')

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

// The entries of git diff-tree -z -r output
export function parseTreeDiff(output: string): TreeDiffEntry[] {
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

// One change of git diff --name-status -z
export interface NameStatusEntry {
	// The status letter, with the similarity score of a rename, like R100
	status: string
	path: string
	// The path that a rename came from
	from?: string
}

// The changes of git diff --name-status -z output, with their paths verbatim
export function parseNameStatus(output: string): NameStatusEntry[] {
	// Each change is "<status>" NUL "<path>" NUL. A rename, or a copy with -C, is
	// "<status><score>" NUL "<from>" NUL "<path>" NUL
	const fields = output.split('\0')
	const changes: NameStatusEntry[] = []
	let i = 0
	while (i + 1 < fields.length && fields[i] !== '') {
		const status = fields[i]
		if (/^[RC]/.test(status)) {
			changes.push({ status, from: fields[i + 1], path: fields[i + 2] })
			i += 3
		} else {
			changes.push({ status, path: fields[i + 1] })
			i += 2
		}
	}

	return changes
}

// One entry of git status --porcelain -z: its two status letters and its path
export interface StatusEntry {
	status: string
	path: string
}

// The entries of git status --porcelain -z output. -z prints the paths verbatim, without the quotes
// and escapes that git puts around paths with spaces or non-ASCII characters otherwise
export function parseStatus(statusOutput: string): StatusEntry[] {
	// Each entry is "XY <path>" NUL, and a rename or copy is followed by "<from path>" NUL
	const fields = statusOutput.split('\0')
	const entries = []
	for (let i = 0; i < fields.length; i++) {
		if (fields[i] === '') continue

		const status = fields[i].slice(0, 2)
		entries.push({ status, path: fields[i].slice(3) })
		if (/[RC]/.test(status)) i++
	}

	return entries
}

// The git status --porcelain -z status letters of each changed file, by its path. A Map, so that a
// path like constructor or __proto__ is a key like any other
export function parseFileStatuses(statusOutput: string): Map<string, string> {
	return new Map(parseStatus(statusOutput).map(({ path, status }) => [path, status]))
}

// Whether git status --porcelain -z lists any changes
export function hasStatusChanges(statusOutput: string): boolean {
	return parseStatus(statusOutput).length !== 0
}
