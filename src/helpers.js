import * as core from '@actions/core'
import * as childProcess from 'child_process'
import fs from 'fs-extra'
import { Liquid } from 'liquidjs'
import * as path from 'path'

// The target repository clones live in TMP_DIR. index.js passes it in, since importing config.js
// here would read the action inputs
let tmpDir

export function setTmpDir(dir) {
	tmpDir = path.resolve(dir)
}

function realpathOrSelf(file) {
	try {
		return fs.realpathSync(file)
	} catch {
		return file
	}
}

// Paths that templates and sync sources must not read: git metadata, which can hold credentials,
// and the clones of the target repositories in TMP_DIR
export function isProtectedPath(file) {
	const resolved = path.resolve(file)
	const candidates = [resolved, realpathOrSelf(resolved)]
	const tmpDirs = tmpDir === undefined ? [] : [tmpDir, realpathOrSelf(tmpDir)]

	return candidates.some((candidate) =>
		candidate.split(path.sep).includes('.git')
		|| tmpDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep))
	)
}

function assertUnprotected(file) {
	if (isProtectedPath(file)) throw new Error(`Templates can't read ${file}`)
}

// LiquidJS' own file system, with protected paths treated as missing and never read
const liquidFs = new Liquid().options.fs
const templateFs = {
	...liquidFs,
	exists: async (file) => !isProtectedPath(file) && liquidFs.exists(file),
	existsSync: (file) => !isProtectedPath(file) && liquidFs.existsSync(file),
	readFile: async (file) => {
		assertUnprotected(file)
		return liquidFs.readFile(file)
	},
	readFileSync: (file) => {
		assertUnprotected(file)
		return liquidFs.readFileSync(file)
	},
}

// Templates may come from anyone who can change the source repository, so they are rendered
// without access to JavaScript objects, can only load files below the working directory outside
// of protected paths, and are limited in what they can parse, allocate and spend rendering
const liquid = new Liquid({
	root: process.cwd(),
	fs: templateFs,
	cache: true,
	strictFilters: true,
	// Already the LiquidJS default, set explicitly so templates never read inherited properties
	ownPropertyOnly: true,
	// Empty strings and 0 are false, as they were with Nunjucks in v1
	jsTruthy: true,
	// Values are inserted as they are, since templates are config and code files, not HTML.
	// Arrays print comma separated, as they did with Nunjucks in v1
	outputEscape: (value) => (Array.isArray(value) ? value.join(',') : value),
	parseLimit: 10_000_000,
	memoryLimit: 100_000_000,
	renderLimit: 30_000,
})

// From https://github.com/MartinKolarik/dedent-js/blob/master/src/index.ts - MIT © 2015 Martin Kolárik
export function dedent(templateStrings, ...values) {
	const matches = []
	const strings = typeof templateStrings === 'string'
		? [templateStrings]
		: templateStrings.slice()
	strings[strings.length - 1] = strings[strings.length - 1].replace(
		/\r?\n([\t ]*)$/,
		'',
	)
	for (let i = 0; i < strings.length; i++) {
		let match
		if ((match = strings[i].match(/\n[\t ]+/g))) {
			matches.push(...match)
		}
	}
	if (matches.length) {
		const size = Math.min(...matches.map((value) => value.length - 1))
		const pattern = new RegExp(`\n[\t ]{${size}}`, 'g')
		for (let i = 0; i < strings.length; i++) {
			strings[i] = strings[i].replace(pattern, '\n')
		}
	}
	strings[0] = strings[0].replace(/^\r?\n/, '')
	let string = strings[0]
	for (let i = 0; i < values.length; i++) {
		string += values[i] + strings[i + 1]
	}
	return string
}

// Runs a program without a shell, so that each argument reaches it as one literal value
function runFile(file, args, workingDir, options) {
	core.debug(`EXEC: "${file} ${args.join(' ')}" IN ${workingDir}`)
	return new Promise((resolve, reject) => {
		childProcess.execFile(
			file,
			args,
			{
				cwd: workingDir,
				...options,
			},
			function(error, stdout) {
				error ? reject(error) : resolve(stdout)
			},
		)
	})
}

// Runs a program without a shell and resolves with its stdout as text, trimmed unless trimResult
// is false. The variables in env are added to the program's environment
export async function execFile(file, args, workingDir, { trimResult = true, env } = {}) {
	const stdout = await runFile(file, args, workingDir, {
		maxBuffer: 1024 * 1024 * 4,
		env: env === undefined ? undefined : { ...process.env, ...env },
	})
	return trimResult ? stdout.trim() : stdout
}

// Runs a program without a shell and resolves with its stdout as raw bytes, with no size limit
export function execFileBuffer(file, args, workingDir) {
	return runFile(file, args, workingDir, {
		encoding: 'buffer',
		maxBuffer: Infinity,
	})
}

export function addTrailingSlash(str) {
	return str.endsWith('/') ? str : str + '/'
}

export async function pathIsDirectory(path) {
	const stat = await fs.lstat(path)
	return stat.isDirectory()
}

export async function write(src, dest, context) {
	if (typeof context !== 'object') {
		context = {}
	}
	const content = await liquid.renderFile(src, context)
	await fs.outputFile(dest, content)
}

// An exclude entry matches the path itself and everything below it, the same way fs.copy skips
// the whole subtree of a directory that the filter rejects. Entries carry the source prefix
function isExcluded(exclude, filePath) {
	return exclude !== undefined
		&& exclude.some((entry) => filePath === entry || filePath.startsWith(addTrailingSlash(entry)))
}

export function createFilterFunc(file) {
	return (filePath) => {
		if (isExcluded(file.exclude, filePath)) {
			core.debug(`Excluding file ${filePath} since it or a parent directory is excluded.`)
			return false
		}
		return true
	}
}

export async function copy(src, dest, isDirectory, file) {
	const deleteOrphaned = isDirectory && file.deleteOrphaned
	const filterFunc = createFilterFunc(file)

	if (file.template) {
		if (isDirectory) {
			core.debug(`Render all files in directory ${src} to ${dest}`)

			const srcFileList = await readfiles(src, {
				readContents: false,
				hidden: true,
			})
			for (const srcFile of srcFileList) {
				const srcPath = path.join(src, srcFile)
				// Exclude entries carry the source prefix, like the paths fs.copy passes to the filter
				if (!filterFunc(srcPath)) {
					continue
				}

				const destPath = path.join(dest, srcFile)
				await write(srcPath, destPath, file.template)
			}
		} else {
			core.debug(`Render file ${src} to ${dest}`)

			await write(src, dest, file.template)
		}
	} else {
		core.debug(`Copy ${src} to ${dest}`)
		await fs.copy(
			src,
			dest,
			file.exclude !== undefined ? { filter: filterFunc } : undefined,
		)
	}

	// If it is a directory and deleteOrphaned is enabled - check if there are any files that were removed from source dir and remove them in destination dir
	if (deleteOrphaned) {
		const srcFileList = await readfiles(src, {
			readContents: false,
			hidden: true,
		})
		const destFileList = await readfiles(dest, {
			readContents: false,
			hidden: true,
		})

		for (const destFile of destFileList) {
			if (destFile.startsWith('.git')) continue
			if (srcFileList.indexOf(destFile) === -1) {
				const filePath = path.join(dest, destFile)
				core.debug(`Found an orphaned file in the target repo - ${filePath}`)

				if (isExcluded(file.exclude, path.join(src, destFile))) {
					core.debug(`Excluding file ${destFile}`)
				} else {
					core.debug(`Removing file ${destFile}`)
					await fs.remove(filePath)
				}
			}
		}
	}
}

export async function getSyncedFileList(src, dest, isDirectory, file) {
	const filterFunc = createFilterFunc(file)

	if (isDirectory) {
		const srcFileList = await readfiles(src, {
			readContents: false,
			hidden: true,
		})
		return srcFileList
			.filter((srcFile) => filterFunc(path.join(src, srcFile)))
			.map((srcFile) => path.join(dest, srcFile))
	} else {
		return [dest]
	}
}

export async function remove(src) {
	core.debug(`RM: ${src}`)

	return fs.remove(src)
}

export function arrayEquals(array1, array2) {
	return (
		Array.isArray(array1)
		&& Array.isArray(array2)
		&& array1.length === array2.length
		&& array1.every((value, i) => value === array2[i])
	)
}

// GitHub rejects pull request bodies longer than this
export const PR_BODY_MAX_LENGTH = 65536

// Renders the changed files of each synced source ({ header, files }) as a collapsed list. Files
// that do not fit into maxLength characters are summed up in an "...and N more" line instead
export function formatChangedFiles(sections, maxLength = Infinity) {
	if (sections.length === 0) return ''

	const start = '<details>\n<summary>Changed files</summary>\n<ul>\n'
	const end = '\n</ul>\n</details>'
	const full = start
		+ sections.map(({ header, files }) => `<li>${header}\n\n${files.join('\n')}</li>`).join('')
		+ end
	if (full.length <= maxLength) return full

	const total = sections.reduce((count, { files }) => count + files.length, 0)
	const pieces = sections.flatMap(({ header, files }, i) => [
		{ text: `${i === 0 ? '' : '</li>'}<li>${header}\n` },
		...files.map((file) => ({ text: `\n${file}`, isFile: true })),
	])
	// Room for the "...and N more" line and the closing tags
	const reserve = `<li>...and ${total} more</li>`.length + end.length

	let text = start
	let listed = 0
	for (const piece of pieces) {
		if (text.length + piece.text.length + reserve > maxLength) break
		text += piece.text
		if (piece.isFile) listed++
	}

	return `${text}${text === start ? '<li>' : '\n'}...and ${total - listed} more</li>${end}`
}

// GitHub's answer when createRef targets a branch that already exists. Octokit
// appends the docs URL to the message, so match its start, not all of it.
export function isReferenceExistsError(error) {
	return error.status === 422 && error.message.startsWith('Reference already exists')
}

// Custom readfiles implementation to replace node-readfiles
export async function readfiles(dir, options = {}) {
	const files = []
	try {
		const items = await fs.readdir(dir)
		for (const item of items) {
			const fullPath = path.join(dir, item)
			const stat = await fs.stat(fullPath)
			if (stat.isDirectory()) {
				const subFiles = await readfiles(fullPath, options)
				files.push(...subFiles.map((f) => path.join(item, f)))
			} else {
				files.push(item)
			}
		}
	} catch (err) {
		if (err.code === 'ENOENT') {
			return []
		}
		throw err
	}
	return files
}
