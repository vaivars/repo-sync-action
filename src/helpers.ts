import * as core from '@actions/core'
import * as childProcess from 'child_process'
import fs from 'fs-extra'
import { Liquid } from 'liquidjs'
import * as path from 'path'

import type { FileEntry, Template } from './config.ts'

// What copy and getSyncedFileList read of a file entry
export type CopyOptions = Partial<Pick<FileEntry, 'template' | 'deleteOrphaned' | 'exclude'>>

export interface ExecOptions {
	// Trim the output, true unless false
	trimResult?: boolean
	// Variables added to the program's environment
	env?: Record<string, string>
}

// The target repository clones live in TMP_DIR. index.ts passes it in, since importing config.ts
// here would read the action inputs
let tmpDir: string | undefined

export function setTmpDir(dir: string): void {
	tmpDir = path.resolve(dir)
}

function realpathOrSelf(file: string): string {
	try {
		return fs.realpathSync(file)
	} catch {
		return file
	}
}

// Paths that templates and sync sources must not read: git metadata, which can hold credentials,
// and the clones of the target repositories in TMP_DIR
export function isProtectedPath(file: string): boolean {
	const resolved = path.resolve(file)
	const candidates = [resolved, realpathOrSelf(resolved)]
	const tmpDirs = tmpDir === undefined ? [] : [tmpDir, realpathOrSelf(tmpDir)]

	return candidates.some((candidate) =>
		candidate.split(path.sep).includes('.git')
		|| tmpDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep))
	)
}

function assertUnprotected(file: string): void {
	if (isProtectedPath(file)) throw new Error(`Templates can't read ${file}`)
}

// LiquidJS' own file system, with protected paths treated as missing and never read
const liquidFs = new Liquid().options.fs
const templateFs: typeof liquidFs = {
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

// Runs a program without a shell, so that each argument reaches it as one literal value
function runFile(
	file: string,
	args: string[],
	workingDir: string | undefined,
	options: childProcess.ExecFileOptionsWithBufferEncoding,
): Promise<Buffer>
function runFile(
	file: string,
	args: string[],
	workingDir: string | undefined,
	options: childProcess.ExecFileOptions,
): Promise<string>
function runFile(
	file: string,
	args: string[],
	workingDir: string | undefined,
	options: childProcess.ExecFileOptions | childProcess.ExecFileOptionsWithBufferEncoding,
): Promise<string | Buffer> {
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
				if (error) reject(error)
				else resolve(stdout)
			},
		)
	})
}

// Runs a program without a shell and resolves with its stdout as text, trimmed unless trimResult
// is false. The variables in env are added to the program's environment
export async function execFile(
	file: string,
	args: string[],
	workingDir?: string,
	{ trimResult = true, env }: ExecOptions = {},
): Promise<string> {
	const stdout = await runFile(file, args, workingDir, {
		maxBuffer: 1024 * 1024 * 4,
		env: env === undefined ? undefined : { ...process.env, ...env },
	})
	return trimResult ? stdout.trim() : stdout
}

// Runs a program without a shell and resolves with its stdout as raw bytes, with no size limit
export function execFileBuffer(file: string, args: string[], workingDir?: string): Promise<Buffer> {
	return runFile(file, args, workingDir, {
		encoding: 'buffer',
		maxBuffer: Infinity,
	})
}

export function addTrailingSlash(str: string): string {
	return str.endsWith('/') ? str : str + '/'
}

export async function pathIsDirectory(path: string): Promise<boolean> {
	const stat = await fs.lstat(path)
	return stat.isDirectory()
}

export async function write(src: string, dest: string, context: Template): Promise<void> {
	if (typeof context !== 'object') {
		context = {}
	}
	const content = await liquid.renderFile(src, context)
	await fs.outputFile(dest, content)
}

// An exclude entry matches the path itself and everything below it, the same way fs.copy skips
// the whole subtree of a directory that the filter rejects. Entries carry the source prefix
function isExcluded(exclude: string[] | undefined, filePath: string): boolean {
	return exclude !== undefined
		&& exclude.some((entry) => filePath === entry || filePath.startsWith(addTrailingSlash(entry)))
}

export function createFilterFunc(file: CopyOptions): (filePath: string) => boolean {
	return (filePath) => {
		if (isExcluded(file.exclude, filePath)) {
			core.debug(`Excluding file ${filePath} since it or a parent directory is excluded.`)
			return false
		}
		return true
	}
}

export async function copy(
	src: string,
	dest: string,
	isDirectory: boolean,
	file: CopyOptions,
): Promise<void> {
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

export async function getSyncedFileList(
	src: string,
	dest: string,
	isDirectory: boolean,
	file: CopyOptions,
): Promise<string[]> {
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

export async function remove(src: string): Promise<void> {
	core.debug(`RM: ${src}`)

	return fs.remove(src)
}

export function arrayEquals(array1: unknown, array2: unknown): boolean {
	return (
		Array.isArray(array1)
		&& Array.isArray(array2)
		&& array1.length === array2.length
		&& array1.every((value, i) => value === array2[i])
	)
}

// Custom readfiles implementation to replace node-readfiles. The options are accepted, but hidden
// files are always listed
export async function readfiles(
	dir: string,
	options: { readContents?: boolean; hidden?: boolean } = {},
): Promise<string[]> {
	const files: string[] = []
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
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return []
		}
		throw err
	}
	return files
}
