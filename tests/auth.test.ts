import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { authEnv, basicCredentials } from '../src/auth.ts'

const base64 = (text: string) => Buffer.from(text).toString('base64')

describe('basicCredentials', () => {
	const cases = [
		{ kind: { isInstallationToken: false, isFineGrained: false }, credentials: 'token:' },
		{ kind: { isInstallationToken: false, isFineGrained: true }, credentials: 'oauth:token' },
		{
			kind: { isInstallationToken: true, isFineGrained: false },
			credentials: 'x-access-token:token',
		},
		{
			kind: { isInstallationToken: true, isFineGrained: true },
			credentials: 'x-access-token:oauth:token',
		},
	]

	for (const { kind, credentials } of cases) {
		test(`encodes ${credentials}`, () => {
			assert.equal(basicCredentials('token', kind), base64(credentials))
		})
	}
})

describe('authEnv', () => {
	test('sets http.extraHeader through the environment only', () => {
		assert.deepEqual(authEnv('abc='), {
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.extraHeader',
			GIT_CONFIG_VALUE_0: 'Authorization: Basic abc=',
		})
	})
})
