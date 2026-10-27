import * as core from '@actions/core'
import { exec } from 'child_process'
import fs from 'fs-extra'
import nunjucks from 'nunjucks'
import * as path from 'path'

// Templates are config and code files, not HTML, so values are inserted as they are
nunjucks.configure({ autoescape: false, trimBlocks: true, lstripBlocks: true })

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

export function execCmd(command, workingDir, trimResult = true) {
	core.debug(`EXEC: "${command}" IN ${workingDir}`)
	return new Promise((resolve, reject) => {
		exec(
			command,
			{
				cwd: workingDir,
				maxBuffer: 1024 * 1024 * 4,
			},
			function(error, stdout) {
				error ? reject(error) : resolve(trimResult ? stdout.trim() : stdout)
			},
		)
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
	const content = nunjucks.render(src, context)
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
