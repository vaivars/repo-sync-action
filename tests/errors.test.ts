import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { errorDetails } from '../src/errors.ts'

describe('errorDetails', () => {
	test('is the stack of an Error, which starts with its message', () => {
		const error = new TypeError('broken')

		assert.equal(errorDetails(error), error.stack)
		assert.match(errorDetails(error), /^TypeError: broken\n/)
	})

	test('is the message of an Error without a stack', () => {
		assert.equal(errorDetails(Object.assign(new Error('message'), { stack: undefined })), 'message')
		assert.equal(errorDetails(Object.assign(new Error('message'), { stack: '' })), 'message')
	})

	test('is anything else as a string', () => {
		assert.equal(errorDetails('text'), 'text')
		assert.equal(errorDetails(42), '42')
		assert.equal(errorDetails(null), 'null')
		assert.equal(errorDetails({ message: 'not an Error' }), '[object Object]')
	})
})
