// @putout/git-status-porcelain ships no types. This is the part of it the action uses
declare module '@putout/git-status-porcelain' {
	// A line of git status --porcelain: the path, and the status letters before it
	export interface StatusEntry {
		name: string
		mode: string
	}

	export function parse(output: string): StatusEntry[]
}
