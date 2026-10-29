// How git authenticates its HTTPS requests. git reads http.extraHeader from the environment
// (git 2.31 or newer), so the token is neither in argv nor in a remote URL, which git would store
// in the clone's .git/config. Unlike a GIT_ASKPASS helper, it needs no script on disk, and the
// token never goes through git's credential helpers, which could store it

export interface TokenKind {
	isInstallationToken: boolean
	isFineGrained: boolean
}

// The token as the user:password pair of the https://<credentials>@host URLs used before,
// base64-encoded for a Basic Authorization header. A bare token was the user name with an empty
// password
export function basicCredentials(
	token: string,
	{ isInstallationToken, isFineGrained }: TokenKind,
): string {
	const credentials = `${isInstallationToken ? 'x-access-token:' : ''}${
		isFineGrained ? 'oauth:' : ''
	}${token}`
	return Buffer.from(credentials.includes(':') ? credentials : `${credentials}:`)
		.toString('base64')
}

// The environment that has git send the credentials with each HTTPS request
export function authEnv(basic: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
	}
}
