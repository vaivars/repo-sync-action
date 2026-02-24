import * as yaml from 'js-yaml'
import fs from 'fs-extra'

// Simplified version of the resolveRepoList function for testing
const resolveRepoList = (reposValue, repoGroups) => {
  if (Array.isArray(reposValue)) {
    return reposValue
  }

  if (typeof reposValue === 'string') {
    const trimmedValue = reposValue.trim()
    
    if (!trimmedValue.includes('\n') && repoGroups[trimmedValue]) {
      console.log(`  ✓ Resolved group reference: ${trimmedValue}`)
      const groupRepos = repoGroups[trimmedValue]
      
      if (!Array.isArray(groupRepos)) {
        console.warn(`  ⚠ Repo group "${trimmedValue}" is not an array`)
        return reposValue.split('\n').map((n) => n.trim()).filter((n) => n)
      }
      
      return groupRepos
    }
    
    return reposValue.split('\n').map((n) => n.trim()).filter((n) => n)
  }

  console.warn(`  ⚠ Unexpected repos value type: ${typeof reposValue}`)
  return []
}

async function testConfig(configPath) {
  console.log(`\n📝 Testing: ${configPath}`)
  console.log('='.repeat(50))
  
  try {
    const fileContent = await fs.promises.readFile(configPath)
    const configObject = yaml.load(fileContent.toString())
    
    const repoGroups = configObject.repo_groups || {}
    
    if (Object.keys(repoGroups).length > 0) {
      console.log(`\n🔑 Loaded ${Object.keys(repoGroups).length} repo group(s):`)
      Object.keys(repoGroups).forEach(groupName => {
        console.log(`  - ${groupName}: ${repoGroups[groupName].length} repos`)
      })
    } else {
      console.log('\n📋 No repo_groups defined (legacy config)')
    }
    
    const result = {}
    
    Object.keys(configObject).forEach((key) => {
      if (key === 'repo_groups') {
        return
      }
      
      if (key === 'group') {
        const rawObject = configObject[key]
        const groups = Array.isArray(rawObject) ? rawObject : [rawObject]
        
        console.log(`\n👥 Processing ${groups.length} group(s):`)
        groups.forEach((group, idx) => {
          console.log(`\n  Group ${idx + 1}:`)
          const repos = resolveRepoList(group.repos, repoGroups)
          console.log(`    Repos (${repos.length}): ${repos.join(', ')}`)
          console.log(`    Files: ${group.files.length}`)
          
          repos.forEach((name) => {
            if (!result[name]) {
              result[name] = []
            }
            result[name].push(...group.files)
          })
        })
      } else {
        console.log(`\n📦 Direct repo config: ${key}`)
        result[key] = configObject[key]
      }
    })
    
    console.log(`\n✅ Successfully parsed config!`)
    console.log(`📊 Total target repos: ${Object.keys(result).length}`)
    Object.keys(result).forEach(repo => {
      console.log(`  - ${repo}: ${result[repo].length} file(s)`)
    })
    
  } catch (error) {
    console.error(`\n❌ Error parsing config:`, error.message)
  }
}

// Test all configs
const configs = [
  'test-configs/test-basic.yml',
  'test-configs/test-mixed.yml',
  'test-configs/test-legacy.yml'
]

for (const config of configs) {
  await testConfig(config)
}

console.log('\n' + '='.repeat(50))
console.log('✨ All tests completed!\n')
