// What the debug log shows of something thrown: the stack of an Error, which starts with its
// message, or the message of one without a stack, and anything else as a string
export function errorDetails(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message

	return String(error)
}
