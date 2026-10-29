import fs from 'fs-extra'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { loadHelpers, makeTmpDir, writeTree } from './support.js'

describe('templates', () => {
	test('render values without HTML escaping', async () => {
		const { write } = await loadHelpers()
		const dir = await makeTmpDir()
		const src = path.join(dir, 'config.yml')
		const dest = path.join(dir, 'out.yml')
		await fs.writeFile(src, 'run: {{ command }}\n')

		await write(src, dest, { command: `echo "a & b" > 'c' <d>` })

		assert.equal(await fs.readFile(dest, 'utf8'), `run: echo "a & b" > 'c' <d>\n`)
	})

	// Renders the template in `files[entry]` and returns the output. `relative` passes the template
	// path relative to the working directory, as sync.yml paths are, and `tmpDir` is a directory
	// below the case directory to treat as TMP_DIR
	async function render(files, entry, context = {}, { relative = false, tmpDir } = {}) {
		const { write, setTmpDir } = await loadHelpers()
		const dir = await makeTmpDir()
		await writeTree(dir, files)
		if (tmpDir !== undefined) setTmpDir(path.join(dir, tmpDir))
		const src = path.join(dir, entry)
		const dest = path.join(dir, 'out')
		await write(relative ? path.relative(process.cwd(), src) : src, dest, context)
		return fs.readFile(dest, 'utf8')
	}

	test('inherit layouts and blocks relative to the template', async () => {
		const output = await render(
			{
				'shared/base.yml': 'name: {% block title %}base{% endblock %}\n',
				'child.yml': `{% layout './shared/base.yml' %}{% block title %}{{ app }}{% endblock %}`,
			},
			'child.yml',
			{ app: 'my-app' },
		)

		assert.equal(output, 'name: my-app\n')
	})

	test('keep GitHub Actions expressions inside raw blocks', async () => {
		const output = await render({
			'workflow.yml': '{% raw %}token: ${{ secrets.GH_PAT }}{% endraw %}',
		}, 'workflow.yml')

		assert.equal(output, 'token: ${{ secrets.GH_PAT }}')
	})

	test('treat empty strings and zero as false', async () => {
		const output = await render(
			{
				'flags.txt':
					'{% if empty %}empty{% endif %}{% if zero %}zero{% endif %}{% if name %}{{ name }}{% endif %}',
			},
			'flags.txt',
			{ empty: '', zero: 0, name: 'set' },
		)

		assert.equal(output, 'set')
	})

	test('do not let templates reach JavaScript objects', async () => {
		const output = await render(
			{
				'escape.txt':
					'{% assign s = "x" %}[{{ s.constructor }}][{{ obj.__proto__ }}][{{ obj.toString }}]',
			},
			'escape.txt',
			{ obj: { a: 1 } },
		)

		assert.equal(output, '[][][]')
	})

	test('reject unknown filters', async () => {
		await assert.rejects(
			render({ 'filter.txt': '{{ 1 | valueOf }}' }, 'filter.txt'),
			/undefined filter: valueOf/,
		)
	})

	test('include files below the working directory by relative path', async () => {
		const output = await render(
			{ 'parts/name.txt': 'inner', 'outer.txt': `[{% include './parts/name.txt' %}]` },
			'outer.txt',
			{},
			{ relative: true },
		)

		assert.equal(output, '[inner]')
	})

	test('refuse to include existing files outside the working directory', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-sync-outside-'))
		const secret = path.join(outside, 'secret.txt')
		await fs.writeFile(secret, 'secret')
		try {
			await assert.rejects(
				render({ 'include.txt': `{% include '${secret}' %}` }, 'include.txt'),
				/Failed to lookup/,
			)
			const dir = await makeTmpDir()
			await assert.rejects(
				render({ 'include.txt': `{% include '${path.relative(dir, secret)}' %}` }, 'include.txt'),
				/Failed to lookup/,
			)
		} finally {
			await fs.remove(outside)
		}
	})

	test('refuse to include files inside .git', async () => {
		await assert.rejects(
			render(
				{ 'repo/.git/config': 'token', 'include.txt': `{% include './repo/.git/config' %}` },
				'include.txt',
			),
			/Failed to lookup/,
		)
	})

	test('refuse to include files through a symlink into .git', async () => {
		const { write } = await loadHelpers()
		const dir = await makeTmpDir()
		await writeTree(dir, {
			'repo/.git/config': 'token',
			'include.txt': `{% include './link.txt' %}`,
		})
		await fs.symlink(path.join(dir, 'repo/.git/config'), path.join(dir, 'link.txt'))

		await assert.rejects(
			write(path.join(dir, 'include.txt'), path.join(dir, 'out'), {}),
			/Failed to lookup/,
		)
	})

	test('refuse to include files inside TMP_DIR', async () => {
		await assert.rejects(
			render(
				{
					'clones/target/file.txt': 'target',
					'include.txt': `{% include './clones/target/file.txt' %}`,
				},
				'include.txt',
				{},
				{ tmpDir: 'clones' },
			),
			/Failed to lookup/,
		)
	})

	test('print arrays comma separated', async () => {
		const output = await render({ 'CODEOWNERS': '* {{ owners }}' }, 'CODEOWNERS', {
			owners: ['@a', '@b'],
		})

		assert.equal(output, '* @a,@b')
	})

	test('stop templates that allocate too much', async () => {
		await assert.rejects(
			render({ 'loop.txt': '{% for i in (1..1000000000) %}x{% endfor %}' }, 'loop.txt'),
			/memory/i,
		)
	})
})
