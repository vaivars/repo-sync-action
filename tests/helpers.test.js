import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isReferenceExistsError } from '../src/helpers.js'

// Shaped like Octokit's RequestError for POST /repos/{owner}/{repo}/git/refs
function requestError(status, message) {
	const error = new Error(message)
	error.status = status
	return error
}

test('matches an existing branch with the docs URL Octokit appends', () => {
	assert.equal(
		isReferenceExistsError(
			requestError(
				422,
				'Reference already exists - https://docs.github.com/rest/git/refs#create-a-reference',
			),
		),
		true,
	)
})

test('matches an existing branch with the bare message', () => {
	assert.equal(isReferenceExistsError(requestError(422, 'Reference already exists')), true)
})

test('rejects other validation failures', () => {
	assert.equal(isReferenceExistsError(requestError(422, 'Reference update failed')), false)
})

test('rejects the same message with another status', () => {
	assert.equal(isReferenceExistsError(requestError(500, 'Reference already exists')), false)
})
