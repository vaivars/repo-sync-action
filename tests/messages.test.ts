import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
	commitMessage,
	defaultSyncMessage,
	fileCommitMessage,
	originalMessageOf,
	prDescription,
	prTitle,
} from '../src/messages.ts'

describe('originalMessageOf', () => {
	// An event that records what is asked of it
	function event(oneCommitPush: boolean) {
		const asked: string[] = []
		return {
			asked,
			isOneCommitPush: () => {
				asked.push('isOneCommitPush')
				return oneCommitPush
			},
			originalCommitMessage: () => {
				asked.push('originalCommitMessage')
				return 'Title\n\nBody'
			},
		}
	}

	test("is the pushed commit's message with ORIGINAL_MESSAGE and a push of one commit", () => {
		const push = event(true)

		assert.equal(originalMessageOf(true, push), 'Title\n\nBody')
		assert.deepEqual(push.asked, ['isOneCommitPush', 'originalCommitMessage'])
	})

	test('is undefined for other events', () => {
		const push = event(false)

		assert.equal(originalMessageOf(true, push), undefined)
		assert.deepEqual(push.asked, ['isOneCommitPush'])
	})

	test('does not look at the event without ORIGINAL_MESSAGE', () => {
		const push = event(true)

		assert.equal(originalMessageOf(false, push), undefined)
		assert.deepEqual(push.asked, [])
	})
})

describe('commitMessage', () => {
	const fallback = defaultSyncMessage('🔄', 'owner/source')

	test('falls back to the default message', () => {
		assert.equal(fallback, '🔄 synced file(s) with owner/source')
		assert.equal(commitMessage(undefined, fallback, ''), fallback)
	})

	test('keeps a given message, even an empty one', () => {
		assert.equal(commitMessage('Message', fallback, ''), 'Message')
		assert.equal(commitMessage('', fallback, ''), '')
	})

	test('appends COMMIT_BODY', () => {
		assert.equal(commitMessage('Message', fallback, 'Body'), 'Message\n\nBody')
		assert.equal(commitMessage(undefined, fallback, 'Body'), `${fallback}\n\nBody`)
	})
})

describe('fileCommitMessage', () => {
	const entry = { prefix: '🔄', source: 'src/a.yml', dest: 'a.yml' }

	test('says whether the destination was synced or created', () => {
		assert.equal(
			fileCommitMessage(undefined, { ...entry, destExists: true }),
			`🔄 synced local 'a.yml' with remote 'src/a.yml'`,
		)
		assert.equal(
			fileCommitMessage(undefined, { ...entry, destExists: false }),
			`🔄 created local 'a.yml' from remote 'src/a.yml'`,
		)
	})

	test('is the original message when there is one', () => {
		assert.equal(fileCommitMessage('Original', { ...entry, destExists: true }), 'Original')
		assert.equal(fileCommitMessage('', { ...entry, destExists: false }), '')
	})
})

describe('prTitle', () => {
	test('is the trimmed first line of the original message with COMMIT_AS_PR_TITLE', () => {
		assert.equal(prTitle('  Title  \nBody', true), 'Title')
		assert.equal(prTitle('Single line', true), 'Single line')
	})

	test('is undefined, for the default title, when the first line is empty', () => {
		for (const message of ['', '\nBody', ' \t \nBody', '   ']) {
			assert.equal(prTitle(message, true), undefined, JSON.stringify(message))
		}
	})

	test('is undefined without COMMIT_AS_PR_TITLE or an original message', () => {
		assert.equal(prTitle('Title\nBody', false), undefined)
		assert.equal(prTitle(undefined, true), undefined)
	})
})

describe('prDescription', () => {
	test('is what follows the first line of the original message, trimmed', () => {
		assert.equal(prDescription('Title\n\nBody\n  indented\n'), 'Body\n  indented')
		assert.equal(prDescription('\nAfter an empty first line'), 'After an empty first line')
		assert.equal(prDescription('Title\n'), '')
	})

	test('is undefined for a message of one line, an empty one or none', () => {
		assert.equal(prDescription('Title'), undefined)
		assert.equal(prDescription(''), undefined)
		assert.equal(prDescription(undefined), undefined)
	})
})
