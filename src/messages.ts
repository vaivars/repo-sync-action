// The commit messages and the PR title and description of a sync, and what ORIGINAL_MESSAGE takes
// for them from the commit that triggered the run

// What the triggering event tells about its commits, see Git
export interface PushEvent {
	isOneCommitPush(): boolean
	originalCommitMessage(): string
}

// The message of the commit that triggered the run, when ORIGINAL_MESSAGE is set and the run is
// for a push of one commit. Undefined otherwise
export function originalMessageOf(enabled: boolean, event: PushEvent): string | undefined {
	return enabled && event.isOneCommitPush() ? event.originalCommitMessage() : undefined
}

// The message of the commits, and the title of the PR, when there is no other
export function defaultSyncMessage(prefix: string, sourceRepository: string): string {
	return `${prefix} synced file(s) with ${sourceRepository}`
}

// The message a commit is made with: the given one or the default, and COMMIT_BODY below it
export function commitMessage(
	message: string | undefined,
	defaultMessage: string,
	commitBody: string,
): string {
	let result = message !== undefined
		? message
		: defaultMessage
	if (commitBody) {
		result += `\n\n${commitBody}`
	}
	return result
}

// The message of the commit that syncs one file entry: the original message if there is one,
// otherwise one that says whether the destination was there before
export function fileCommitMessage(
	original: string | undefined,
	{ prefix, source, dest, destExists }: {
		prefix: string
		source: string
		dest: string
		destExists: boolean
	},
): string {
	if (original !== undefined) return original

	return destExists
		? `${prefix} synced local '${dest}' with remote '${source}'`
		: `${prefix} created local '${dest}' from remote '${source}'`
}

// The PR title that COMMIT_AS_PR_TITLE takes from the original message: its first line
export function prTitle(
	original: string | undefined,
	commitAsPrTitle: boolean,
): string | undefined {
	return commitAsPrTitle && original !== undefined
		? original.split('\n', 1)[0].trim()
		: undefined
}

// The PR description taken from the original message: what follows its first line
export function prDescription(original: string | undefined): string | undefined {
	const firstLineBreakIndex = original
		? original.indexOf('\n')
		: -1
	return original !== undefined && firstLineBreakIndex !== -1
		? original.substring(firstLineBreakIndex + 1).trim()
		: undefined
}
