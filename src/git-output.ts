import { parse } from '@putout/git-status-porcelain'

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

// The git status --porcelain status letters of each changed file, by its path
export function parseFileStatuses(statusOutput: string): Record<string, string> {
	return parse(statusOutput).reduce((acc: Record<string, string>, entry) => {
		acc[entry.name] = entry.mode
		return acc
	}, {})
}

// Whether git status --porcelain lists any changes
export function hasStatusChanges(statusOutput: string): boolean {
	return parse(statusOutput).length !== 0
}
