import esmock from 'esmock'
import fs from 'fs-extra'
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, test } from 'node:test'

import { isReferenceExistsError } from '../src/helpers.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
// nunjucks only renders templates below the working directory, so scratch files live in the repo
const TMP_ROOT = path.join(ROOT_DIR, '.tmp/helpers-tests')

after(() => fs.remove(TMP_ROOT))

async function makeTmpDir() {
	await fs.ensureDir(TMP_ROOT)
	return fs.mkdtemp(path.join(TMP_ROOT, 'case-'))
}

async function writeTree(root, files) {
	for (const [file, content] of Object.entries(files)) {
		await fs.outputFile(path.join(root, file), content)
	}
}

const silentCore = {
	debug: () => {},
	info: () => {},
	warning: () => {},
	setSecret: () => {},
}

// helpers.js with @actions/core silenced; readdir sorted so that dot entries come first
async function loadHelpers() {
	return esmock('../src/helpers.js', {
		'@actions/core': silentCore,
		'fs-extra': { default: { ...fs, readdir: async (dir) => (await fs.readdir(dir)).sort() } },
	})
}

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

describe('copy with deleteOrphaned', () => {
	test('keeps deleting orphans after a .git entry', async () => {
		const { copy } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src/')
		const dest = path.join(dir, 'dest/')
		await writeTree(src, { 'kept.txt': 'source' })
		await writeTree(dest, {
			'.gitkeep': '',
			'.github/workflow.yml': 'target only',
			'kept.txt': 'old',
			'orphan.txt': 'target only',
		})

		await copy(src, dest, true, { deleteOrphaned: true })

		assert.equal(await fs.pathExists(path.join(dest, 'orphan.txt')), false)
		assert.equal(await fs.readFile(path.join(dest, 'kept.txt'), 'utf8'), 'source')
		assert.equal(await fs.pathExists(path.join(dest, '.gitkeep')), true)
		assert.equal(await fs.pathExists(path.join(dest, '.github/workflow.yml')), true)
	})
})
