#!/usr/bin/env node
// @ts-check
import {readFile} from "node:fs/promises"
import {get as httpGet} from "node:http"
import {get as httpsGet} from "node:https"
import {Socket} from "node:net"
import {join} from "node:path"
import {URL} from "node:url"

/*
 * In-flight probe for the builder DinD.
 *
 * The DinD image runs no Node and has no quiescence hook to arm, so the roll's
 * in-flight stage is the only protection an admitted build has. This probe runs
 * on the builder host and asks the DinD daemon for the containers TensorBuzz
 * labelled for a build: a build is mid-flight while any of its containers is
 * still live.
 *
 * Exit codes match `appctl drain` / `appctl in-flight`, because the roll gates
 * on them the same way:
 *   0 - no build is mid-flight, so the DinD may be recreated
 *   1 - a build is mid-flight; the roll must wait, not recreate
 *   2 - the probe cannot answer (daemon unreachable or the reply is not usable)
 */

export const EXIT_OK = 0
export const EXIT_IN_FLIGHT = 1
export const EXIT_UNAVAILABLE = 2

export const BUILD_ID_LABEL = "tensorbuzz_build_id"

/** States the daemon reports for a container that has not finished its work. */
export const LIVE_STATES = new Set(["created", "running", "paused"])

/**
 * @typedef {object} BuildContainer
 * @property {string} id - Container id.
 * @property {string} name - Container name as the daemon reports it.
 * @property {string} state - Daemon state, for example `running` or `exited`.
 * @property {Record<string, string>} labels - Container labels.
 */

/**
 * @typedef {object} ProbeResult
 * @property {number} exitCode - Code the roll gates on.
 * @property {Record<string, unknown>} record - The JSON line written to stdout.
 * @property {string} reason - Human-readable line written to stderr.
 */

/**
 * @param {unknown} value - Daemon reply body.
 * @returns {BuildContainer[]} Build containers only.
 */
export function buildContainers(value) {
  if (!Array.isArray(value)) return []
  /** @type {BuildContainer[]} */
  const containers = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const container = /** @type {Record<string, unknown>} */ (entry)
    const labels = typeof container.Labels === "object" && container.Labels !== null ? container.Labels : {}
    containers.push({
      id: typeof container.Id === "string" ? container.Id : "",
      name: typeof container.Names === "string" ? container.Names : Array.isArray(container.Names) ? String(container.Names[0] ?? "") : "",
      state: typeof container.State === "string" ? container.State : "",
      labels: /** @type {Record<string, string>} */ (labels)
    })
  }
  return containers.filter((container) => typeof container.labels[BUILD_ID_LABEL] === "string")
}

/**
 * @param {BuildContainer[]} containers - Build containers the daemon reported.
 * @returns {BuildContainer[]} Containers whose build has not finished.
 */
export function midFlightBuilds(containers) {
  return containers.filter((container) => LIVE_STATES.has(container.state))
}

/**
 * Runs the probe against a daemon reply and returns what the roll reads.
 * @param {unknown} value - Daemon reply body.
 * @param {string} daemon - Daemon address the probe read.
 * @returns {ProbeResult} Exit code, stdout record, and stderr reason.
 */
export function evaluate(value, daemon) {
  const containers = buildContainers(value)
  const midFlight = midFlightBuilds(containers)
  if (midFlight.length > 0) {
    return {
      exitCode: EXIT_IN_FLIGHT,
      record: {
        command: "in-flight",
        status: "in_flight",
        code: "BUILD_IN_FLIGHT",
        daemon,
        buildContainers: containers.length,
        midFlight: midFlight.length,
        builds: midFlight.map((container) => ({
          buildId: container.labels[BUILD_ID_LABEL],
          state: container.state,
          container: container.name || container.id
        }))
      },
      reason: `probe in-flight: ${midFlight.length} build container(s) still live of ${containers.length} labelled by TensorBuzz`
    }
  }
  return {
    exitCode: EXIT_OK,
    record: {command: "in-flight", status: "settled", daemon, buildContainers: containers.length, midFlight: 0},
    reason: `probe in-flight: no TensorBuzz build container is live (${containers.length} labelled, all finished)`
  }
}

/**
 * @param {string} dockerHost - `unix://<path>`, `tcp://host:port`, `http://…`, or `https://…`.
 * @param {{caFile?: string, certFile?: string, keyFile?: string}} [tls] - Client certificate material for an https daemon.
 * @returns {Promise<unknown>} Parsed daemon reply.
 */
export async function readContainerList(dockerHost, tls = {}) {
  const url = new URL(dockerHost)
  const search = "/containers/json?all=true"
  if (url.protocol === "unix:") {
    const path = url.pathname
    return await new Promise((resolve, reject) => {
      const socket = new Socket()
      let body = ""
      socket.once("error", reject)
      socket.connect(path, () => {
        socket.write(`GET ${search} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`)
      })
      socket.on("data", (chunk) => { body += chunk.toString("utf8") })
      socket.once("close", () => {
        const separator = body.indexOf("\r\n\r\n")
        if (separator < 0) {
          reject(new Error("The daemon reply has no HTTP header section"))
          return
        }
        resolve(JSON.parse(body.slice(separator + 4)))
      })
    })
  }
  const options = {hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: search}
  if (url.protocol === "https:") {
    const cert = tls.certFile
    const key = tls.keyFile
    const ca = tls.caFile
    if (cert !== undefined && key !== undefined && ca !== undefined) {
      options.ca = await readFile(ca)
      options.cert = await readFile(cert)
      options.key = await readFile(key)
    }
  }
  const transport = url.protocol === "https:" ? httpsGet : httpGet
  return await new Promise((resolve, reject) => {
    const req = transport(options, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk.toString() })
      res.once("end", () => {
        if (res.statusCode === undefined || res.statusCode >= 400) {
          reject(new Error(`The daemon answered ${String(res.statusCode)}`))
          return
        }
        resolve(JSON.parse(body))
      })
    })
    req.once("error", reject)
    req.end()
  })
}

/** @typedef {import('node:stream').Writable} OutputStream */

/** @param {string[]} argv - Arguments after the command name. @returns {{dockerHost: string, tls: {caFile?: string, certFile?: string, keyFile?: string}}} */
function parseOptions(argv) {
  const certPath = process.env.DOCKER_CERT_PATH
  const options = {
    dockerHost: process.env.DOCKER_HOST?.trim() || "unix:///var/run/docker.sock",
    tls: /** {caFile?: string, certFile?: string, keyFile?: string} */ (certPath === undefined ? {} : {
      caFile: join(certPath, "ca.pem"),
      certFile: join(certPath, "cert.pem"),
      keyFile: join(certPath, "key.pem")
    })
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (flag === "--docker-host") {
      if (value === undefined || value.length === 0) throw new Error("--docker-host must name a daemon address")
      options.dockerHost = value
      continue
    }
    if (flag === "--tls-ca") {
      options.tls.caFile = value
      continue
    }
    if (flag === "--tls-cert") {
      options.tls.certFile = value
      continue
    }
    if (flag === "--tls-key") {
      options.tls.keyFile = value
      continue
    }
    throw new Error(`Unknown probe option: ${flag}`)
  }
  for (const [name, path] of Object.entries(options.tls)) {
    if (path === undefined) continue
    if (typeof path !== "string" || path.length === 0) throw new Error(`${name} must name a file`)
  }
  return options
}

/**
 * @param {string[]} argv - Arguments after the command name.
 * @param {{stdout?: OutputStream, stderr?: OutputStream}} [streams] - Output destinations.
 * @returns {Promise<number>} Process exit code.
 */
export async function runProbeCli(argv, streams = {}) {
  const stdout = streams.stdout ?? process.stdout
  const stderr = streams.stderr ?? process.stderr
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_UNAVAILABLE
  }
  let reply
  try {
    reply = await readContainerList(options.dockerHost, options.tls)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`probe in-flight: could not read the daemon at ${options.dockerHost}: ${message}. The DinD must be reachable from the host running the roll\n`)
    return EXIT_UNAVAILABLE
  }
  const result = evaluate(reply, options.dockerHost)
  stdout.write(`${JSON.stringify(result.record)}\n`)
  stderr.write(`${result.reason}\n`)
  return result.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await runProbeCli(process.argv.slice(2))
