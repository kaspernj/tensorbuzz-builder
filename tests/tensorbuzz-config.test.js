import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {describe, expect, it} from "@velocious/testing"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function configuredPaths() {
  const lines = fs.readFileSync(path.join(repoRoot, "tensorbuzz.yml"), "utf8").split("\n")
  const pathsLine = lines.findIndex((line) => line === "paths:")
  const patterns = []

  for (let index = pathsLine + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^  - "([^"]+)"$/u)
    if (match) {
      patterns.push(match[1])
      continue
    }

    if (lines[index] !== "" && !lines[index].startsWith(" ")) break
  }

  return patterns
}

function patternMatches(pattern, changedPath) {
  let expression = "^"

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*"
        index += 1
      } else {
        expression += "[^/]*"
      }
      continue
    }

    if (character === "?") {
      expression += "[^/]"
      continue
    }

    expression += character.replace(/[.*+()[\]{}|\\^$]/gu, "\\$&")
  }

  return new RegExp(`${expression}$`, "u").test(changedPath)
}

function isIncluded(patterns, changedPath) {
  let included = false

  for (const configuredPattern of patterns) {
    const negated = configuredPattern.startsWith("!")
    const pattern = negated ? configuredPattern.slice(1) : configuredPattern
    if (patternMatches(pattern, changedPath)) included = !negated
  }

  return included
}

describe("TensorBuzz path-filter configuration", () => {
  it("keeps every Validate input covered while excluding docs-only changes", () => {
    const patterns = configuredPaths()
    const validateInputs = [
      "tensorbuzz.yml",
      "package.json",
      "package-lock.json",
      "tests/memory-contract.test.js",
      "tests/quiescence-probe.test.js",
      "tests/tensorbuzz-config.test.js",
      "scripts/verify-dind-data-volume.js",
      "scripts/quiescence-probe.js",
      "scripts/prepare-docker-server-host.sh",
      "scripts/prune-docker-server.sh",
      "scripts/recreate-docker-server.sh",
      ".env.example",
      "docker-compose.yml",
      "docker-compose.socketduct.yml",
      "docker-compose.network-name.yml",
      "shared/future-tooling.sh"
    ]

    expect(patterns).toContain("**")
    for (const input of validateInputs) {
      expect({input, included: isIncluded(patterns, input)}).toMatchObject({input, included: true})
    }

    expect(isIncluded(patterns, "README.md")).toBeFalse()
    expect(isIncluded(patterns, "docs/path-filtering.md")).toBeFalse()
    expect(isIncluded(patterns, "changelog.d/20261118-paths.md")).toBeFalse()
  })
})
