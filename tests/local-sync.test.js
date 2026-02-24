
import esmock from 'esmock';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_FILES_DIR = path.join(__dirname, 'test-files');
const TMP_TEST_DIR = path.join(__dirname, '../.tmp/tests');
const SOURCE_DIR = path.join(TMP_TEST_DIR, 'source-repo');
// The action writes to {TMP_DIR}/{repo-unique-name}
const TARGET_DIR = path.join(TMP_TEST_DIR, 'tmp-cleanup/gitrepo.local/owner/target-repo@default');

const configPath = path.join(TMP_TEST_DIR, 'sync.yml');
console.log('ROOT:', ROOT_DIR);
console.log('TEST_FILES:', TEST_FILES_DIR);
console.log('TMP:', TMP_TEST_DIR);

const MOCK_BIN_DIR = path.join(TMP_TEST_DIR, 'mock-bin');
const MOCK_GIT_PATH = path.join(MOCK_BIN_DIR, 'git');

// Cleanup and setup
console.log('\nSetting up test environment...');
if (fs.existsSync(TMP_TEST_DIR)) {
    fs.removeSync(TMP_TEST_DIR);
}
fs.ensureDirSync(SOURCE_DIR);
fs.ensureDirSync(MOCK_BIN_DIR);

// Create mock git
const mockGitScript = `#!/bin/sh
# echo "[MOCK GIT] $@" >&2

if [ "$1" = "clone" ]; then
    # Get last argument (the directory)
    for last; do true; done
    mkdir -p "$last"
    exit 0
fi

if [ "$1" = "status" ]; then
    # Return changes to ensure the action proceeds
    echo "M file1.txt"
    exit 0
fi

if [ "$1" = "rev-parse" ]; then
    echo "dummy-sha"
    exit 0
fi

# Always succeed for other commands (add, config, commit, push)
exit 0
`;
fs.writeFileSync(MOCK_GIT_PATH, mockGitScript);
fs.chmodSync(MOCK_GIT_PATH, '755');

// Update PATH
process.env.PATH = `${MOCK_BIN_DIR}:${process.env.PATH}`;
console.log(`Mock git created at ${MOCK_GIT_PATH}`);

// Copy test files to source dir
if (fs.existsSync(TEST_FILES_DIR)) {
    fs.copySync(TEST_FILES_DIR, SOURCE_DIR);
    console.log(`Copied ${TEST_FILES_DIR} to ${SOURCE_DIR}`);
} else {
    console.log('WARNING: test-files dir not found, creating dummy files');
    fs.outputFileSync(path.join(SOURCE_DIR, 'file1.txt'), 'content1');
    fs.outputFileSync(path.join(SOURCE_DIR, 'subdir/file2.txt'), 'content2');
}

// Get list of files to sync
const sourceFiles = fs.readdirSync(SOURCE_DIR).filter(f => !f.startsWith('.'));
console.log('Source files:', sourceFiles);

// Create config file
// Note: We need a REAL config file content because dist/index.js parses it.
// We mocked parseConfig before, but now we use real config.js inside dist.
const configContent = `
group:
  - repos: |
      owner/target-repo
    files:
${sourceFiles.map(f => `      - source: ${path.join(SOURCE_DIR, f)}\n        dest: ${f}`).join('\n')}
`;
fs.writeFileSync(configPath, configContent);
console.log('Config created at:', configPath);

console.log('\\nMocking dependencies...');

console.log('Starting sync execution...\\n');

try {
    // Set required env vars that dist/index.js will read
    process.env.INPUT_GITHUB_REPOSITORY = 'owner/current-repo';
    process.env.INPUT_GH_PAT = 'dummy-pat';
    process.env.INPUT_CONFIG_PATH = configPath;
    process.env.INPUT_TMP_DIR = path.join(TMP_TEST_DIR, 'tmp-cleanup');
    process.env.INPUT_DRY_RUN = 'false';
    process.env.INPUT_SKIP_PR = 'true';
    process.env.INPUT_SKIP_CLEANUP = 'true'; // Keep files for verification
    process.env.INPUT_GIT_EMAIL = 'test@example.com';
    process.env.INPUT_GIT_USERNAME = 'testuser';
    process.env.GITHUB_SERVER_URL = 'https://gitrepo.local'; // Mock server URL
    process.env.INPUT_GITHUB_SERVER_URL = 'https://gitrepo.local';
    
    // Ensure INPUT_TMP_DIR does NOT exist so that the randomizer logic in config.js isn't triggered
    if (fs.existsSync(process.env.INPUT_TMP_DIR)) {
        fs.removeSync(process.env.INPUT_TMP_DIR);
    }

    const distIndexJsPath = path.join(ROOT_DIR, 'dist/index.js');
    console.log(`Importing from: ${distIndexJsPath}`);
    
    // We import the module. It won't run automatically because of the guard.
    // We don't need esmock since we are mocking via PATH.
    const module = await import(distIndexJsPath);
    
    console.log('Running sync...');
    if (module.run) {
        await module.run();
    } else {
        // If run is default export or something else
        if (typeof module.default === 'function') {
             await module.default();
        } else if (module.default && module.default.run) {
             await module.default.run();
        } else {
             console.error('Could not find run function in exported module:', Object.keys(module));
             process.exit(1);
        }
    }

    // Verification
    console.log('\nVerifying files copied...');
    if (fs.existsSync(TARGET_DIR)) {
        console.log(`Target Dir contents: ${fs.readdirSync(TARGET_DIR)}`);
    } else {
        console.log(`Target Dir ${TARGET_DIR} does not exist!`);
        const parent = path.dirname(TARGET_DIR);
        if (fs.existsSync(parent)) {
            console.log(`Parent Dir ${parent} contents: ${fs.readdirSync(parent)}`);
        } else {
            console.log(`Parent Dir ${parent} does not exist!`);
        }
    }
    
    let success = true;
    for (const f of sourceFiles) {
        const destPath = path.join(TARGET_DIR, f);
        if (fs.existsSync(destPath)) {
            console.log(`✅ SUCCESS: ${f} copied correctly!`);
        } else {
            console.error(`❌ FAILURE: ${f} NOT found in target.`);
            success = false;
        }
    }

    if (!success) {
        process.exit(1);
    }

} catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
}
