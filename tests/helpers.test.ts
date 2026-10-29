import fs from 'fs-extra'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { isReferenceExistsError } from '../src/github.ts'
import { loadConfig, loadHelpers, makeTmpDir, writeTree } from './support.ts'

// Shaped like Octokit's RequestError for POST /repos/{owner}/{repo}/git/refs
function requestError(status: number, message: string) {
	const error: Error & { status?: number } = new Error(message)
	error.status = status
	return error
}

describe('isReferenceExistsError', () => {
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

describe('protected paths', () => {
	test('cover .git directories and TMP_DIR', async () => {
		const { isProtectedPath, setTmpDir } = await loadHelpers()
		setTmpDir('clones')

		assert.equal(isProtectedPath('.git/config'), true)
		assert.equal(isProtectedPath('nested/.git/HEAD'), true)
		assert.equal(isProtectedPath('clones/github.com/owner/repo@default/README.md'), true)
		assert.equal(isProtectedPath(path.resolve('clones')), true)
		assert.equal(isProtectedPath('.github/workflows/test.yml'), false)
		assert.equal(isProtectedPath('clones-not/file.txt'), false)
		assert.equal(isProtectedPath('templates/.gitignore'), false)
	})
})

describe('exclude', () => {
	// A source directory with excluded entries, parsed through the real config
	async function excludeSetup() {
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src')
		await writeTree(src, {
			'a.txt': '{{ name }}',
			'skip.txt': 'excluded file',
			'local/x.txt': 'excluded directory',
		})
		const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    dest: out/
    template:
      name: synced
    exclude: |
      skip.txt
      local/
`)
		const [{ files: [file] }] = await parseConfig()
		return { dir, file }
	}

	test('applies in template mode', async () => {
		const { copy } = await loadHelpers()
		const { dir, file } = await excludeSetup()
		const dest = path.join(dir, 'dest/')

		await copy(file.source, dest, true, file)

		assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'synced')
		assert.equal(await fs.pathExists(path.join(dest, 'skip.txt')), false)
		assert.equal(await fs.pathExists(path.join(dest, 'local')), false)
	})

	test('leaves excluded files out of the synced file list', async () => {
		const { getSyncedFileList } = await loadHelpers()
		const { file } = await excludeSetup()

		assert.deepEqual(await getSyncedFileList(file.source, file.dest, true, file), ['out/a.txt'])
	})

	for (const template of [false, true]) {
		test(`covers files nested below an excluded directory (template: ${template})`, async () => {
			const { copy, readfiles } = await loadHelpers()
			const dir = await makeTmpDir()
			const src = path.join(dir, 'src')
			await writeTree(src, {
				'a.txt': 'a',
				'local/x.txt': 'excluded',
				'local/sub/y.txt': 'excluded',
				'keep/k.txt': 'excluded',
				'keepsake.txt': 'not excluded',
			})
			const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    template: ${template}
    exclude: |
      local/
      keep
`)
			const [{ files: [file] }] = await parseConfig()
			const dest = path.join(dir, 'dest/')

			await copy(file.source, dest, true, file)

			assert.deepEqual((await readfiles(dest)).sort(), ['a.txt', 'keepsake.txt'])
		})
	}

	test('protects target files below an excluded directory from deleteOrphaned', async () => {
		const { copy } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'src')
		const dest = path.join(dir, 'dest/')
		await writeTree(src, { 'a.txt': 'source' })
		await writeTree(dest, {
			'a.txt': 'old',
			'local/custom.txt': 'target only',
			'local/sub/deep.txt': 'target only',
			'keep/k.txt': 'target only',
			'localfile.txt': 'orphan',
			'orphan.txt': 'orphan',
		})
		const { parseConfig } = await loadConfig(`
owner/target:
  - source: ${src}/
    deleteOrphaned: true
    exclude: |
      local/
      keep
`)
		const [{ files: [file] }] = await parseConfig()

		await copy(file.source, dest, true, file)

		assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'source')
		assert.equal(await fs.pathExists(path.join(dest, 'local/custom.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'local/sub/deep.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'keep/k.txt')), true)
		assert.equal(await fs.pathExists(path.join(dest, 'localfile.txt')), false)
		assert.equal(await fs.pathExists(path.join(dest, 'orphan.txt')), false)
	})
})
