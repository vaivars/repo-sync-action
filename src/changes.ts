import * as path from 'path'

import type { ChangedFiles } from './pull-request.ts'

// How the PR body describes a file with these git status --porcelain letters
export function statusText(mode: string): string {
	let statusText = 'unchanged'
	if (mode.includes('A') || mode.includes('?')) statusText = 'created'
	if (mode.includes('M')) statusText = 'updated'
	if (mode.includes('D')) statusText = 'deleted'
	return statusText
}

// What the PR body lists for one synced source: each synced file, relative to the destination
// directory, with its status
export function changedFiles(
	{ source, dest, isDirectory }: { source: string; dest: string; isDirectory: boolean },
	syncedFiles: string[],
	fileStatuses: ReadonlyMap<string, string>,
): ChangedFiles {
	// Use different commit/pr message based on if the source is a directory or file
	const directory = isDirectory ? 'directory' : 'file'

	const files = syncedFiles.map((filePath) => {
		const mode = fileStatuses.get(filePath) || ''

		const relPath = isDirectory
			? path.relative(dest, filePath)
			: path.basename(filePath)
		return `\`${relPath}\` - ${statusText(mode)}`
	})

	return {
		// The PR body lists these, see formatChangedFiles
		header: `From remote ${directory} <code>${source}</code>, synced the following files:`,
		files,
	}
}
