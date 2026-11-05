#!/usr/bin/env node

import {execFileSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const containerName = process.env.BUILDER_CONTAINER_NAME || "peakflow_builder-docker-server-1"
const dataRoot = process.env.DIND_DATA_ROOT || "/var/lib/docker/volumes"

const dockerMountFormat = '{{range .Mounts}}{{if eq .Destination "/var/lib/docker"}}{{.Name}}{{end}}{{end}}'
// The \\n is deliberate: docker's Go template needs the two-character escape,
// not a real newline inside its quoted string.
const volumeMountFormat = '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\\n"}}{{end}}{{end}}'

// Only these docker verbs may reach the daemon. Everything else throws, so this
// script can report an unreferenced data-root volume but cannot remove one.
// Removal stays an operator decision on one exact volume id, taken only after the
// mount table, the container mounts, the engine-id inside the data root, and the
// newest mtime in it all agree that the volume is dead.
const readOnlyDockerCommands = [
  ["inspect"],
  ["ps"]
]

export function assertReadOnlyDockerCommand(args) {
  const isReadOnly = readOnlyDockerCommands.some(
    (command) => command.join(" ") === args.slice(0, command.length).join(" ")
  )

  if (!isReadOnly) {
    throw new Error(`Refusing non-read-only docker command: ${args.join(" ")}`)
  }
}

function dockerText(args) {
  assertReadOnlyDockerCommand(args)

  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
}

export function dataVolumeName(container) {
  return dockerText(["inspect", container, "--format", dockerMountFormat]).trim()
}

export function referencedVolumeNames() {
  const containerIds = dockerText(["ps", "--all", "--quiet"])
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean)

  const volumeNames = new Set()

  for (let index = 0; index < containerIds.length; index += 50) {
    const output = dockerText([
      "inspect",
      ...containerIds.slice(index, index + 50),
      "--format",
      volumeMountFormat
    ])

    for (const volumeName of output.split("\n")) {
      if (volumeName) volumeNames.add(volumeName)
    }
  }

  return volumeNames
}

export function dataRootVolumeNames(root) {
  return fs.readdirSync(root, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function dataRootEngineId(root, volumeName) {
  const engineIdPath = path.join(root, volumeName, "_data", "engine-id")

  if (!fs.existsSync(engineIdPath)) return "unknown"

  return fs.readFileSync(engineIdPath, "utf8").trim()
}

function main() {
  const ownedVolume = dataVolumeName(containerName)

  if (!ownedVolume) {
    console.error(`${containerName} has no volume mount at /var/lib/docker.`)
    process.exitCode = 1

    return
  }

  console.log(`Data volume owned by ${containerName}: ${ownedVolume}`)

  if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory()) {
    console.error(`Data root ${dataRoot} is not readable here; run this as root on the builder host.`)
    process.exitCode = 1

    return
  }

  const referenced = referencedVolumeNames()
  const volumeNames = dataRootVolumeNames(dataRoot)
  const unreferenced = volumeNames.filter((volumeName) => !referenced.has(volumeName))

  for (const volumeName of unreferenced) {
    console.log(`Unreferenced data-root volume: ${volumeName} engine-id=${dataRootEngineId(dataRoot, volumeName)}`)
  }

  console.log(`Data-root directories: ${volumeNames.length}, unreferenced: ${unreferenced.length}`)

  if (unreferenced.length > 0) {
    console.error("Report only. An unreferenced data-root volume is removed by exact name or not at all.")
    process.exitCode = 1

    return
  }

  console.log("Completed by verify-dind-data-volume.js.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`verify-dind-data-volume.js failed: ${error.message}`)
    process.exitCode = 1
  }
}
