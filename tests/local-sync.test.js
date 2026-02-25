import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const TEST_FILES_DIR = path.join(__dirname, 'test-files')
const TMP_TEST_DIR = path.join(__dirname, '../.tmp/tests')
const SOURCE_DIR = path.join(TMP_TEST_DIR, 'source-repo')
const TARGET_DIR = path.join(TMP_TEST_DIR, 'tmp-cleanup/gitrepo.local/owner/target-repo@default')
const configPath = path.join(TMP_TEST_DIR, 'sync.yml')
const MOCK_BIN_DIR = path.join(TMP_TEST_DIR, 'mock-bin')
const MOCK_GIT_PATH = path.join(MOCK_BIN_DIR, 'git')

// Suppress ::debug:: and ::add-mask:: workflow command output outside of GitHub Actions
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
	const str = typeof chunk === 'string' ? chunk : chunk.toString()
	if (str.startsWith('::debug::') || str.startsWith('::add-mask::')) return true
	return originalStdoutWrite(chunk, ...args)
}

console.log('Setting up test environment...')
if (fs.existsSync(TMP_TEST_DIR)) {
	fs.removeSync(TMP_TEST_DIR)
}
fs.ensureDirSync(SOURCE_DIR)
fs.ensureDirSync(MOCK_BIN_DIR)

const mockGitScript = `#!/bin/sh
if [ "$1" = "clone" ]; then
    for last; do true; done
    mkdir -p "$last"
    exit 0
fi

if [ "$1" = "status" ]; then
    echo "M file1.txt"
    exit 0
fi

if [ "$1" = "rev-parse" ]; then
    echo "dummy-sha"
    exit 0
fi

exit 0
`
fs.writeFileSync(MOCK_GIT_PATH, mockGitScript)
fs.chmodSync(MOCK_GIT_PATH, '755')

process.env.PATH = `${MOCK_BIN_DIR}:${process.env.PATH}`

if (fs.existsSync(TEST_FILES_DIR)) {
	fs.copySync(TEST_FILES_DIR, SOURCE_DIR)
} else {
	console.error('ERROR: test-files dir not found')
	process.exit(1)
}

const sourceFiles = fs.readdirSync(SOURCE_DIR).filter(f => !f.startsWith('.'))
console.log('Source files:', sourceFiles)

const configContent = `
group:
  - repos: |
      owner/target-repo
    files:
${
	sourceFiles.map(f => `      - source: ${path.join(SOURCE_DIR, f)}\n        dest: ${f}`).join('\n')
}
`
fs.writeFileSync(configPath, configContent)

try {
	process.env.INPUT_GITHUB_REPOSITORY = 'owner/current-repo'
	process.env.INPUT_GH_PAT = 'dummy-pat'
	process.env.INPUT_CONFIG_PATH = configPath
	process.env.INPUT_TMP_DIR = path.join(TMP_TEST_DIR, 'tmp-cleanup')
	process.env.INPUT_DRY_RUN = 'false'
	process.env.INPUT_SKIP_PR = 'true'
	process.env.INPUT_SKIP_CLEANUP = 'true'
	process.env.INPUT_GIT_EMAIL = 'test@example.com'
	process.env.INPUT_GIT_USERNAME = 'testuser'
	process.env.GITHUB_SERVER_URL = 'https://gitrepo.local'
	process.env.INPUT_GITHUB_SERVER_URL = 'https://gitrepo.local'

	if (fs.existsSync(process.env.INPUT_TMP_DIR)) {
		fs.removeSync(process.env.INPUT_TMP_DIR)
	}

	const module = await import(path.join(ROOT_DIR, 'dist/index.js'))

	console.log('Running sync...')
	await module.run()

	console.log('\nVerifying files copied...')
	if (!fs.existsSync(TARGET_DIR)) {
		console.error(`Target Dir ${TARGET_DIR} does not exist!`)
		process.exit(1)
	}

	let success = true
	for (const f of sourceFiles) {
		const destPath = path.join(TARGET_DIR, f)
		if (fs.existsSync(destPath)) {
			console.log(`✅ SUCCESS: ${f} copied correctly!`)
		} else {
			console.error(`❌ FAILURE: ${f} NOT found in target.`)
			success = false
		}
	}

	if (!success) {
		process.exit(1)
	}
} catch (err) {
	console.error('Test execution failed:', err)
	process.exit(1)
}
