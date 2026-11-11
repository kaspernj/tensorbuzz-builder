# Builder DinD in-flight probe

`scripts/quiescence-probe.js` is the builder DinD's in-flight hook for a
Rollbridge compose roll. The DinD image (`docker:29.9.2-dind`) runs no Node and
has no quiescence hook to arm, so the roll cannot drain it: the in-flight gate
is the only protection an admitted build has, and this probe is what the gate
runs.

The probe runs on the builder host, not inside the DinD, and asks the daemon for
the containers the TensorBuzz build executor created. A build is mid-flight
while any container it labelled is still live.

## Contract

Exit codes are the same three the Socketduct `appctl` verbs use, because the
roll gates on them identically:

| Code | Meaning | Roll behaviour |
| --- | --- | --- |
| `0` | No build is mid-flight — every TensorBuzz-labelled container has finished. | The DinD may be recreated. |
| `1` | A build is mid-flight: a labelled container is `created`, `running`, or `paused`. | Fail at `stage: "in_flight"`; the DinD is not recreated and the builds keep running. |
| `2` | The probe cannot answer — the daemon is unreachable or the reply is not usable. | Fail; an unreachable DinD is never a settled DinD. |

`stdout` is one JSON line the roll reads; `stderr` is the human-readable reason.

Mid-flight is decided by the label `tensorbuzz_build_id` plus the daemon's own
state for that container. Containers the executor did not label — including the
DinD container itself — are not admitted build work and cannot hold a roll open.

## Running it

```sh
node scripts/quiescence-probe.js                       # DOCKER_HOST default: unix:///var/run/docker.sock
DOCKER_HOST=tcp://dind:2375 node scripts/quiescence-probe.js
node scripts/quiescence-probe.js --docker-host https://builder-host:8676   # with DOCKER_CERT_PATH, or --tls-ca/--tls-cert/--tls-key
```

The unit declaration in `rollbridge.js` names it:

```js
inFlight: {command: "node /srv/peakflow-builder/scripts/quiescence-probe.js", intervalMs: 5000, timeoutMs: 1800000}
```

`intervalMs` and `timeoutMs` stay as they are: a build that is mid-flight should
finish inside the roll's budget rather than be killed by a recreate.

## What is proven

- `tests/quiescence-probe.test.js` — the live-state classification, the settled
  branch with an all-exited build group, that unlabelled containers are not
  counted, the unix-socket read path the DinD defaults to, the exit-2 branch for
  an unreadable daemon, and the JSON line on stdout.
- Against the live shared DinD: with one labelled build container running the
  probe answered `1` (`BUILD_IN_FLIGHT`, `midFlight: 1`); after that container
  was removed it answered `0`; with no daemon reachable on the default socket it
  answered `2`.

## What the probe does not cover

It reports the daemon's view of build containers. It does not see a build that
is running inside a container the executor did not label, and it cannot tell a
build that is mid-flight from a container the executor left behind on purpose.
The DinD has no drain hook, so a roll that passes this gate can still recreate a
DinD whose buildkit session is active but whose containers have all exited — the
`inFlight.timeoutMs` budget is what a real build gets, and a drain hook would be
needed to make that gate exact.
