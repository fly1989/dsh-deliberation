import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const forbiddenPaths = tracked.filter(path =>
  path === '.env'
  || path.startsWith('.tmp-dsh-home/')
  || path.startsWith('coverage/')
  || path.startsWith('debug/')
  || path.startsWith('dist/')
  || path.startsWith('lib/')
  || path.startsWith('node_modules/')
  || path.endsWith('.log')
  || path.endsWith('.tgz'))

const personalPathPatterns = [
  { label: 'Windows user profile path', pattern: /[A-Za-z]:\\Users\\[^\\\r\n]+/u },
  { label: 'local project workspace path', pattern: /[A-Za-z]:\\ys\\ai_lab(?:\\|\b)/u },
]

const leakedLocations = []
for (const path of tracked) {
  const content = readFileSync(path)
  if (content.includes(0)) continue
  const text = content.toString('utf8')
  for (const { label, pattern } of personalPathPatterns) {
    if (pattern.test(text)) leakedLocations.push(`${path}: ${label}`)
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const versions = new Set([
  packageJson.version,
  packageLock.version,
  packageLock.packages?.['']?.version,
])
if (versions.size !== 1 || versions.has(undefined)) {
  leakedLocations.push('package.json and package-lock.json versions do not match')
}

const failures = [
  ...forbiddenPaths.map(path => `${path}: forbidden release-path`),
  ...leakedLocations,
]

if (failures.length > 0) {
  console.error('Repository hygiene check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Repository hygiene check passed (${tracked.length} tracked files).`)
}
