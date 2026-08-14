import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const rootPackage = readJson(path.join(projectRoot, 'package.json'))
const queue = Object.entries(rootPackage.dependencies ?? {}).map(([name]) => ({
  name,
  fromDirectory: projectRoot,
  optional: false,
}))
const visitedPaths = new Set()
const runtimePackages = new Map()
const missingDependencies = []

while (queue.length > 0) {
  const request = queue.shift()
  const packageJsonPath = resolvePackageJson(request.name, request.fromDirectory)

  if (packageJsonPath === undefined) {
    if (!request.optional) missingDependencies.push(request.name)
    continue
  }

  const realPackageJsonPath = fs.realpathSync(packageJsonPath)
  if (visitedPaths.has(realPackageJsonPath)) continue
  visitedPaths.add(realPackageJsonPath)

  const packageDirectory = path.dirname(realPackageJsonPath)
  const packageJson = readJson(realPackageJsonPath)
  runtimePackages.set(packageJson.name, packageJson)

  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    queue.push({ name, fromDirectory: packageDirectory, optional: false })
  }

  for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
    queue.push({ name, fromDirectory: packageDirectory, optional: true })
  }
}

const missingPeers = []

for (const packageJson of runtimePackages.values()) {
  if (!packageJson.name?.startsWith('@deepseek-ai/')) continue

  for (const [peerName, versionRange] of Object.entries(packageJson.peerDependencies ?? {})) {
    if (!peerName.startsWith('@deepseek-ai/')) continue
    if (packageJson.peerDependenciesMeta?.[peerName]?.optional === true) continue
    if (runtimePackages.has(peerName)) continue

    missingPeers.push(`${packageJson.name} requires ${peerName}@${versionRange}`)
  }
}

if (missingDependencies.length > 0 || missingPeers.length > 0) {
  if (missingDependencies.length > 0) {
    console.error(`Missing production dependencies:\n- ${missingDependencies.join('\n- ')}`)
  }

  if (missingPeers.length > 0) {
    console.error(
      `DeepSeek runtime peer dependencies are not reachable from package.json dependencies:\n- ${missingPeers.join('\n- ')}`,
    )
  }

  process.exit(1)
}

console.log(
  `Runtime dependency closure is complete (${runtimePackages.size} packages checked).`,
)

function resolvePackageJson(packageName, fromDirectory) {
  let currentDirectory = fromDirectory

  while (true) {
    const candidate = path.join(
      currentDirectory,
      'node_modules',
      ...packageName.split('/'),
      'package.json',
    )

    if (fs.existsSync(candidate)) return candidate

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) return undefined
    currentDirectory = parentDirectory
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}
