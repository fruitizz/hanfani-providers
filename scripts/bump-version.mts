#!/usr/bin/env node
/**
 * Automatic semantic versioning based on conventional commits.
 *
 * Analyzes recent commits (feat: → minor, fix: → patch, BREAKING CHANGE: → major)
 * and updates package.json accordingly.
 *
 * Usage: pnpm version:bump
 *
 * Then tag and push to publish via release.yml:
 *   git tag vX.Y.Z && git push origin vX.Y.Z
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dir, '..')

interface Version {
  major: number
  minor: number
  patch: number
}

/** Parse semver string like "1.2.3" into { major, minor, patch }. */
function parseVersion(v: string): Version {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map((x) => parseInt(x, 10))
  return { major, minor, patch }
}

/** Format Version back to "1.2.3". */
function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`
}

/** Increment major, minor, or patch. */
function bump(v: Version, type: 'major' | 'minor' | 'patch'): Version {
  if (type === 'major') return { major: v.major + 1, minor: 0, patch: 0 }
  if (type === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major, minor: v.minor, patch: v.patch + 1 }
}

/** Get the highest bump level across recent commits. */
function analyzeCommits(since?: string): 'major' | 'minor' | 'patch' | null {
  try {
    const cmd = since ? `git log ${since}..HEAD --oneline` : 'git log --oneline'
    const output = execSync(cmd, { encoding: 'utf8', cwd: rootDir }).trim()
    if (!output) return null

    let hasMajor = false
    let hasMinor = false
    let hasPatch = false

    for (const line of output.split('\n')) {
      if (!line) continue
      // Extract the commit type from "hash subject"
      const subject = line.slice(8) // skip "hash "

      if (subject.includes('BREAKING CHANGE:')) {
        hasMajor = true
      } else if (subject.startsWith('feat')) {
        hasMinor = true
      } else if (subject.startsWith('fix')) {
        hasPatch = true
      }
    }

    if (hasMajor) return 'major'
    if (hasMinor) return 'minor'
    if (hasPatch) return 'patch'
    return null
  } catch {
    return null
  }
}

/** Read current version from package.json. */
function getCurrentVersion(): string {
  const pkgPath = path.join(rootDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version as string
}

/** Get the git tag for a version (e.g., "v1.2.3"). */
function getTagForVersion(v: string): string {
  return `v${v}`
}

/** Update package.json version. */
function updatePackageJson(version: string): void {
  const pkgPath = path.join(rootDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

async function main() {
  const current = getCurrentVersion()
  const currentVersion = parseVersion(current)

  // Analyze commits: prefer commits since the last tag, but if the tag doesn't
  // exist yet, analyze all commits (for bootstrapping new repos).
  const lastTag = getTagForVersion(current)
  let bumpType = analyzeCommits(lastTag)

  // If analyzing since a tag returned nothing (tag doesn't exist or no new commits),
  // try analyzing all commits to bootstrap version bumping.
  if (!bumpType) {
    bumpType = analyzeCommits()
  }

  if (!bumpType) {
    console.log(`✓ No changes to version. Current: ${current}`)
    return
  }

  const nextVersion = bump(currentVersion, bumpType)
  const nextVersionStr = formatVersion(nextVersion)

  console.log(`📌 Bumping version: ${current} → ${nextVersionStr} (${bumpType})`)

  updatePackageJson(nextVersionStr)

  console.log(`✓ Updated package.json`)
  console.log(
    `✓ Commit this as: git commit -m "chore(providers): bump version to ${nextVersionStr}"`
  )
  console.log(`✓ Then tag & push: git tag v${nextVersionStr} && git push origin v${nextVersionStr}`)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
