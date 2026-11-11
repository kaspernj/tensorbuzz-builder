// @ts-check
import fs from "node:fs"
import path from "node:path"
import {createServer as createHttpServer} from "node:http"
import {createServer as createSocketServer} from "node:net"
import {tmpdir} from "node:os"
import {Writable} from "node:stream"

import {describe, expect, it, withTestCleanup} from "@velocious/testing"

import {
  EXIT_IN_FLIGHT,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  evaluate,
  readContainerList,
  runProbeCli
} from "../scripts/quiescence-probe.js"

/**
 * Shapes the probe was written against: the daemon reply for containers the
 * TensorBuzz build executor created, taken from a live builder DinD.
 */
function buildContainer(buildId, state, extraLabels = {}) {
  return {
    Id: `container-${buildId}`,
    Names: [`/tensorbuzz-build-build_${buildId}`],
    Image: "sha256:5e3894f9c4bd6bbbd963f30536fe60ab0ae5472df7451f2cb6782951b47f538e",
    Created: 1794038276,
    Labels: {
      tensorbuzz_build_group_id: "790796af-42b9-49a2-a4a2-56f14d225f58",
      tensorbuzz_build_id: buildId,
      tensorbuzz_build_run_id: "822d2673-44ef-4091-abb6-d7a7ec99611e",
      tensorbuzz_docker_server_id: "83de9ad4-9202-4de1-8412-d3f8177c557d",
      tensorbuzz_origin: "build_executor",
      tensorbuzz_resource: "build_container",
      ...extraLabels
    },
    State: state,
    Status: state === "exited" ? "Exited (0) 6 hours ago" : state
  }
}

function captureStream() {
  /** @type {string[]} */
  const chunks = []
  const stream = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString("utf8"))
      callback()
    }
  })
  return {stream, text: () => chunks.join("")}
}

/**
 * @param {unknown} reply - Body the fake daemon answers with.
 * @param {number} [status] - HTTP status.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} Fake daemon.
 */
async function startFakeDaemon(reply, status = 200) {
  const server = createHttpServer((req, res) => {
    if (req.url !== "/containers/json?all=true") {
      res.writeHead(404, {"content-type": "application/json"})
      res.end(JSON.stringify({message: "not found"}))
      return
    }
    res.writeHead(status, {"content-type": "application/json"})
    res.end(JSON.stringify(reply))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = /** @type {{port: number}} */ (server.address())
  return {
    url: `tcp://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

describe("builder DinD in-flight probe", () => {
  it("reports a build that is still live as in-flight, so the roll waits instead of recreating the DinD", async () => {
    const reply = [buildContainer("38011e7f-2ad8-4793-9cfc-d352a8a6eff5", "running"), buildContainer("00e573ca-712d-4f49-bd52-a44c3b6aaf02", "exited")]
    const result = evaluate(reply, "unix:///var/run/docker.sock")

    expect({value: result.exitCode, context: "a live build container holds the roll open"}).toMatchObject({value: EXIT_IN_FLIGHT})
    expect({value: result.record}).toMatchObject({
      value: {
        command: "in-flight",
        status: "in_flight",
        code: "BUILD_IN_FLIGHT",
        buildContainers: 2,
        midFlight: 1,
        builds: [{buildId: "38011e7f-2ad8-4793-9cfc-d352a8a6eff5", state: "running"}]
      }
    })
    expect(result.reason).toContain("1 build container(s) still live of 2 labelled")
  });

  it("reports an all-exited build group as settled, which is the branch that lets the roll recreate", async () => {
    const reply = [buildContainer("23bcd7a6-db8c-42fa-84dd-c3ec36829a7d", "exited"), buildContainer("436d2a10-5bea-4b2f-ba35-c75f66d959b4", "exited")]
    const result = evaluate(reply, "unix:///var/run/docker.sock")

    expect({value: result.exitCode, context: "nothing accepted is left, so the DinD may be recreated"}).toMatchObject({value: EXIT_OK})
    expect({value: result.record}).toMatchObject({value: {status: "settled", buildContainers: 2, midFlight: 0}})
  })

  it("counts only build containers the executor labelled, so unrelated live work cannot hold the roll open", async () => {
    const reply = [
      {Id: "dind-itself", Names: ["/peakflow_builder-docker-server-1"], Labels: {}, State: "running"},
      buildContainer("ea7c6a05-30bd-47ce-8e69-8fa6e19920a6", "exited")
    ]

    const result = evaluate(reply, "unix:///var/run/docker.sock")
    expect({value: result.exitCode, context: "the DinD's own container is not admitted build work"}).toMatchObject({value: EXIT_OK})
    expect({value: result.record}).toMatchObject({value: {buildContainers: 1, midFlight: 0}})
  })

  it("reads the daemon over the unix socket the DinD defaults to", async () => {
    await withTestCleanup(async (after) => {
      // A socket path longer than the sun_path field fails to bind, so the fixture
      // uses the process temporary directory rather than a path inside the checkout.
      const directory = fs.mkdtempSync(path.join(tmpdir(), "probe-socket-"))
      after(() => fs.rmSync(directory, {force: true, recursive: true}))
      const socketPath = path.join(directory, "daemon.sock")
      const reply = [buildContainer("66fdeaa6-8d30-4554-a224-eb49860636ee", "created")]
      const server = createSocketServer((socket) => {
        socket.on("data", () => {
          const body = JSON.stringify(reply)
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`)
          socket.end()
        })
      })
      server.once("error", (error) => { throw error })
      await new Promise((resolve) => server.listen(socketPath, resolve))
      after(() => new Promise((resolve) => server.close(() => resolve(undefined))))

      const parsed = await readContainerList(`unix://${socketPath}`)
      const result = evaluate(parsed, `unix://${socketPath}`)
      expect({value: result.exitCode, context: "a build container still in created state is admitted work that has not finished"}).toMatchObject({value: EXIT_IN_FLIGHT})
    })
  })

  it("answers 2 when the daemon cannot be read, so the roll cannot mistake an unreachable DinD for a settled one", async () => {
    await withTestCleanup(async (after) => {
      const daemon = await startFakeDaemon({message: "daemon offline"}, 500)
      after(() => daemon.close())
      const stdout = captureStream()
      const stderr = captureStream()

      const code = await runProbeCli(["--docker-host", daemon.url], {stdout: stdout.stream, stderr: stderr.stream})
      expect({value: code, context: "an unreadable daemon is not a settled DinD"}).toMatchObject({value: EXIT_UNAVAILABLE})
      expect(stderr.text()).toContain("could not read the daemon")
      expect(stdout.text()).toBe("")
    })
  })

  it("writes the one JSON line the roll reads on stdout", async () => {
    await withTestCleanup(async (after) => {
      const daemon = await startFakeDaemon([buildContainer("1f87c054-0eaa-4811-b730-09f63a3f5f58", "paused")])
      after(() => daemon.close())
      const stdout = captureStream()
      const stderr = captureStream()

      const code = await runProbeCli(["--docker-host", daemon.url], {stdout: stdout.stream, stderr: stderr.stream})
      expect({value: code, context: "a paused build container is still mid-flight"}).toMatchObject({value: EXIT_IN_FLIGHT})
      const record = JSON.parse(stdout.text().trim())
      expect({value: record}).toMatchObject({
        value: {command: "in-flight", status: "in_flight", code: "BUILD_IN_FLIGHT", midFlight: 1, builds: [{state: "paused"}]}
      })
    })
  })
})
