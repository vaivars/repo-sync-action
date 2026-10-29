import * as path from 'path'

import type { NameStatusEntry } from './git-output.ts'
import type { ChangedFiles } from './pull-request.ts'

// How the PR body describes a change with this git diff --name-status status
function changeText(status: string): string {
	switch (status[0]) {
		case 'A':
			return 'created'
		case 'M':
		case 'T':
			return 'updated'
		case 'D':
			return 'deleted'
		case 'R':
			// The score is how similar the file is to the one it was renamed from
			return status === 'R100' ? 'renamed' : 'renamed and updated'
		default:
			return 'changed'
	}
}

// What the PR body lists for one synced entry: each change it staged, with the paths relative to a
// directory dest, or the name of a single file, and how many of the synced files did not change
export function changedFiles(
	{ source, dest, isDirectory }: { source: string; dest: string; isDirectory: boolean },
	syncedFiles: string[],
	changes: NameStatusEntry[],
): ChangedFiles {
	// Use different commit/pr message based on if the source is a directory or file
	const directory = isDirectory ? 'directory' : 'file'

	const show = (filePath: string) =>
		`\`${isDirectory ? path.relative(dest, filePath) : path.basename(filePath)}\``
	const files = changes.map((change) =>
		change.from === undefined
			? `${show(change.path)} - ${changeText(change.status)}`
			: `${show(change.from)} → ${show(change.path)} - ${changeText(change.status)}`
	)

	const changed = new Set(
		changes.flatMap((
			change,
		) => (change.from === undefined ? [change.path] : [change.from, change.path])),
	)

	return {
		// The PR body lists these, see formatChangedFiles
		header: `From remote ${directory} <code>${source}</code>, synced the following files:`,
		files,
		unchanged: syncedFiles.filter((filePath) => !changed.has(filePath)).length,
	}
}
