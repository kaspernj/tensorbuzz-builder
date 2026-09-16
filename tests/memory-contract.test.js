import {execFileSync, spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {describe, expect, it} from "@velocious/testing"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const gibibyte = 1024 ** 3
const composeFiles = [
  "docker-compose.yml",
  "docker-compose.network-name.yml",
  "docker-compose.socketduct.yml"
]
const emptyEnvFile = path.join(repoRoot, "tests", "fixtures", "empty.env")
const testComposeProjectName = "tensorbuzz-builder-memory-contract-test"

const legacySysctlContent = `# Peakflow builder host tuning for a process-heavy Docker-in-Docker service.
fs.file-max = 2097152
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 1048576
kernel.pid_max = 4194304
vm.max_map_count = 262144
`

const legacyLimitsContent = `# Raise login-session limits so large container ulimits are not blocked by the host.
* soft nofile 262144
* hard nofile 524288
* soft nproc 65535
* hard nproc 65535
root soft nofile 262144
root hard nofile 524288
root soft nproc 65535
root hard nproc 65535
`

function composeInterpolationVariables() {
  const variables = new Set(["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME"])

  for (const composeFile of composeFiles) {
    const source = fs.readFileSync(path.join(repoRoot, composeFile), "utf8")

    for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)) {
      variables.add(match[1])
    }
  }

  return variables
}

function renderCompose({
  composeEnvironment = {},
  inheritedEnvironment = {},
  memoryLimit,
  projectDirectory,
  projectName = testComposeProjectName,
  socketduct = false
} = {}) {
  const args = ["compose"]

  if (projectName) args.push("--project-name", projectName)
  if (projectDirectory) args.push("--project-directory", projectDirectory)

  args.push(
    "--env-file",
    emptyEnvFile,
    "--file",
    path.join(repoRoot, "docker-compose.yml")
  )

  if (socketduct) {
    args.push("--file", path.join(repoRoot, "docker-compose.socketduct.yml"))
  }

  args.push("config", "--format", "json")

  const env = {...process.env, ...inheritedEnvironment}
  for (const key of composeInterpolationVariables()) {
    delete env[key]
  }

  Object.assign(env, composeEnvironment)
  if (memoryLimit) env.DOCKER_SERVER_MEMORY_LIMIT = memoryLimit

  return JSON.parse(execFileSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  }))
}

function runLegacyTuningMigration(sysctlContent, limitsContent) {
  const fixtureDirectory = fs.mkdtempSync(path.join(repoRoot, "tests", "fixtures", "host-tuning-"))
  const sysctlDirectory = path.join(fixtureDirectory, "sysctl.d")
  const limitsDirectory = path.join(fixtureDirectory, "limits.d")
  const sysctlFile = path.join(sysctlDirectory, "99-peakflow-builder.conf")
  const limitsFile = path.join(limitsDirectory, "99-peakflow-builder.conf")

  fs.mkdirSync(sysctlDirectory)
  fs.mkdirSync(limitsDirectory)
  fs.writeFileSync(sysctlFile, sysctlContent)
  fs.writeFileSync(limitsFile, limitsContent)

  const script = path.join(repoRoot, "scripts", "prepare-docker-server-host.sh")
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; migrate_known_legacy_tuning_files "$2" "$3"',
      "host-tuning-migration-test",
      script,
      sysctlFile,
      limitsFile
    ],
    {encoding: "utf8"}
  )

  return {
    cleanup: () => fs.rmSync(fixtureDirectory, {force: true, recursive: true}),
    limitsFile,
    result,
    sysctlFile
  }
}

function dockerServer(config) {
  return config.services["docker-server"]
}

function expectContainedParent(service, expectedBytes) {
  expect(Number(service.mem_limit)).toBe(expectedBytes)
  expect(Number(service.memswap_limit)).toBe(expectedBytes)
  expect(service.privileged).toBeTrue()
  expect(Number(service.shm_size)).toBe(2 * gibibyte)
}

describe("tensorbuzz-builder identity and runtime compatibility", () => {
  it("uses the canonical package name and test-only Compose identity", () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"))
    const config = renderCompose()

    expect(packageManifest.name).toBe("tensorbuzz-builder")
    expect(packageManifest.private).toBeTrue()
    expect(packageLock.name).toBe("tensorbuzz-builder")
    expect(packageLock.packages[""].name).toBe("tensorbuzz-builder")
    expect(config.name).toBe(testComposeProjectName)
  })

  it("pins the production default independently of the checkout basename", () => {
    const config = renderCompose({
      projectDirectory: path.join(repoRoot, "tests", "fixtures"),
      projectName: null
    })

    expect(config.name).toBe("peakflow_builder")
    expect(config.services["docker-server"].networks["peakflow-builder"]).toBeDefined()
    expect(config.networks["peakflow-builder"].name).toBe("peakflow_builder_peakflow-builder")
    expect(`${config.name}-docker-server-1`).toBe("peakflow_builder-docker-server-1")
  })

  it("allows an explicit operator project-name override", () => {
    const config = renderCompose({
      composeEnvironment: {COMPOSE_PROJECT_NAME: "operator-approved-builder"},
      projectDirectory: path.join(repoRoot, "tests", "fixtures"),
      projectName: null
    })

    expect(config.name).toBe("operator-approved-builder")
    expect(config.networks["peakflow-builder"].name).toBe("operator-approved-builder_peakflow-builder")
  })

  it("documents the exact legacy runtime compatibility allowlist", () => {
    const documentation = fs.readFileSync(
      path.join(repoRoot, "docs", "naming-and-runtime-compatibility.md"),
      "utf8"
    )

    for (const legacyIdentifier of [
      "peakflow_builder",
      "docker-server",
      "peakflow_builder-docker-server-1",
      "peakflow-builder",
      "peakflow_builder_peakflow-builder",
      "/etc/sysctl.d/99-peakflow-builder.conf",
      "/etc/security/limits.d/99-peakflow-builder.conf"
    ]) {
      expect(documentation).toContain(legacyIdentifier)
    }
  })

  it("migrates exact known tuning files but leaves modified legacy files untouched", () => {
    const known = runLegacyTuningMigration(legacySysctlContent, legacyLimitsContent)

    try {
      expect(known.result.status).toBe(0)
      expect(fs.existsSync(known.sysctlFile)).toBeFalse()
      expect(fs.existsSync(known.limitsFile)).toBeFalse()
    } finally {
      known.cleanup()
    }

    const modified = runLegacyTuningMigration(
      legacySysctlContent,
      `${legacyLimitsContent}# local change\n`
    )

    try {
      expect(modified.result.status).toBe(1)
      expect(modified.result.stderr).toContain("modified or unknown legacy tuning file")
      expect(fs.existsSync(modified.sysctlFile)).toBeTrue()
      expect(fs.existsSync(modified.limitsFile)).toBeTrue()
    } finally {
      modified.cleanup()
    }
  })
})

describe("docker-server memory containment", () => {
  it("reserves 16 GiB for admitted work and 4 GiB for DinD overhead", () => {
    const service = dockerServer(renderCompose())

    expectContainedParent(service, 20 * gibibyte)
    expect(Number(service.mem_limit) - (16 * gibibyte)).toBe(4 * gibibyte)
  })

  it("isolates checked-in defaults from inherited deployment configuration", () => {
    const service = dockerServer(renderCompose({
      inheritedEnvironment: {
        COMPOSE_FILE: "docker-compose.yml:docker-compose.socketduct.yml",
        COMPOSE_PROJECT_NAME: "production-builder",
        DOCKER_SERVER_MEMORY_LIMIT: "22g"
      }
    }))

    expectContainedParent(service, 20 * gibibyte)
  })

  it("inherits the same hard RAM and no-swap ceiling in Socketduct mode", () => {
    const service = dockerServer(renderCompose({socketduct: true}))

    expectContainedParent(service, 20 * gibibyte)
    expect(service.ports).toBeUndefined()
    expect(service.command).toContain("--host=tcp://0.0.0.0:2375")
  })

  it("configures parent RAM and total RAM-plus-swap ceilings together", () => {
    const service = dockerServer(renderCompose({memoryLimit: "22g"}))

    expectContainedParent(service, 22 * gibibyte)
  })

  it("preserves persistent nested-Docker and certificate mounts", () => {
    const service = dockerServer(renderCompose())
    const mountsByTarget = new Map(service.volumes.map((mount) => [mount.target, mount]))

    expect(mountsByTarget.has("/shared")).toBeTrue()
    expect(mountsByTarget.get("/etc/docker/certs.d").read_only).toBeTrue()
  })
})
