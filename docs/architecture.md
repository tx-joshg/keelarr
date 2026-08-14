# Architecture

How Keelarr is actually built. Where a decision was forced by something that
went wrong on a real host, this says so — those are the parts most likely to
look arbitrary and be reverted by someone tidying up.

For the original design intent, see [foundation.md](foundation.md) and
[product-spec.md](product-spec.md). They are kept as a record of what was
planned, not a description of what exists.

## Shape

One Node process, no framework, no build step, no transpiler. Plain ES modules
and `node:test`.

```
src/server.js            listens, then initialises — in that order, deliberately
  create-http-app.js     routes, and the auth gate over /api/*
    keelarr-app-service  composes seven app services, each owning one concern
      host-profile       detection, validation, settings, deploy/.env
      dashboard          the state the UI renders
      import             read-only scan of containers Keelarr did not create
      managed-stack      install, deploy, upgrade, update checks
      cutover            adoption cutover and revert
      removal            removal with retention options
      wiring             what should be connected to what, and doing it
```

Underneath those sit the primitives: `runtime.js` (Docker and Compose),
`generator.js` (Compose files), `status.js` (the dashboard row), `jobs.js`
(background work), `store.js` (settings), `health.js`, `logger.js`.

### Dependency injection everywhere

Every service takes its collaborators as `*Impl` constructor parameters with
real defaults. That is what makes the suite runnable with no Docker and no
filesystem.

It is also load-bearing for correctness, not just testing: **a test must stub
every injected implementation that reaches Docker or the filesystem.** Stubbing
one layer is not enough when a layer underneath still reaches the real machine.
One test stubbed the settings layer but left the controller-env layer real, and
`npm test` overwrote a live controller's `deploy/.env` with a QNAP fixture — for
weeks, silently, because the write happened in the test process and never
reached the app's log.

## The path model

The single rule everything else follows: **the controller mounts each host root
at the same absolute path inside the container as outside.**

That is what lets Keelarr generate a Compose file whose paths are correct for
the host while still being able to read those paths itself. It is also why
Windows is unsupported outside WSL2 — `C:\Media` has no absolute-path
equivalent inside a Linux container.

`host-mounts.js` owns this: it renders `deploy/.env` from settings, and reports
roots that settings name but the controller cannot see.

## Host adapters

`host-adapters/` holds one module per host profile — currently QNAP and generic
Docker — each scoring itself against the machine and suggesting defaults.
Detection **suggests**; it never decides. The UI shows every candidate with its
score and reasoning, and the operator picks.

Detection is cached and explicitly invalidated on save and on detect, because it
probes every Docker binary candidate across every adapter, and running that on
each dashboard poll cost seconds per refresh.

## Jobs

Anything slow is a job: a declared list of steps, started with a 202, polled by
the UI.

Two rules learned the hard way:

- **A job's status is derived from its steps.** It once reported success with a
  failed step inside it.
- **Steps that did not need to run are `skipped`, not `succeeded`.** Upgrade All
  declared nine steps for three real upgrades and reported the six it skipped as
  successes.

## Wiring

The largest subsystem, and the reason Keelarr exists. `wiring/` splits into:

| Module | Responsibility |
| --- | --- |
| `topology.js` | Flattens `docker inspect` into an endpoint; classifies the network |
| `attach.js` | Resolves an address from *the source app's* position, and joins the controller to service networks |
| `api-keys.js` | Reads each app's key at the moment it is needed |
| `app-clients.js` | The Arr, SABnzbd, Bazarr and qBittorrent APIs |
| `reconcile.js` | Compares what exists against what should exist |
| `payloads.js` | Builds writes from each app's own schema |
| `path-plan.js`, `provision.js` | Library folders on both sides of the mount |
| `prerequisites.js` | What only the operator can supply |

### Addresses are resolved per source, not globally

"localhost" means something different from inside each container. An address is
resolved from the source app's position and classified: a shared user-defined
network resolves by container name, the default bridge by IP because it carries
no DNS, a published port by its *host* port when remapped. A pair that genuinely
cannot reach each other is reported as **blocked, with the reason**, rather than
handed an address that will time out.

### Reconcile has four states, and only one is written

`correct`, `drift`, `ambiguous`, `absent`. Only `absent` is ever written.
Drift — a download client pointing somewhere unexpected — is reported and left
alone, because it is usually a deliberate choice. Ambiguous means several
candidates and no clear match, which is not a safe thing to guess at.

### Written last, tested first

Every payload is built from the app's own schema, then submitted to the app's
own test endpoint, and only written if the app accepts it. A refusal is reported
in the app's words rather than surfacing as a bare 400 from a write that already
half-happened.

### Apps refuse for reasons that are not about the payload

Two live examples, both invisible to unit tests:

- A fresh **SABnzbd** whitelists only the hostname it sees itself as — inside a
  container, the container ID — and answers 403 to its own container name, which
  is what everything else addresses it by. Keelarr appends the name through
  SABnzbd's own API, addressed by IP, keeping every existing entry.
- An **Arr** refuses a download client with no category, and its error names a
  field rather than the actual problem. The category is checked, and created,
  before the write is attempted.

## Secrets

- API keys are **never persisted, logged, or returned**. What the API returns is a
  source path and a truncated fingerprint. A test asserts no 32-character hex
  key appears in any response.
- Command output that could contain secrets is marked `sensitive`, and the log
  records byte counts instead of contents. This exists because reading an app's
  config at debug level once wrote an Arr's API key, SABnzbd's Usenet password
  in cleartext and a Plex token straight into the log.
- Indexers are counted, never read or written.
- App databases are moved as tarballs, never parsed. Nothing depends on another
  app's schema, so nothing breaks on its next migration.

## Reporting

The rule the codebase keeps returning to: **never claim something that has not
been verified.**

- Reachability is tri-state. `null` means not determined, and the UI says so
  rather than showing green.
- A wiring run that changes nothing is a success, but only says "everything is
  already configured" when every link was confirmed correct — not when links
  were merely unreachable.
- A prerequisite check returning `null` means "no opinion", never "none".
- A long transfer is judged on progress, not a total deadline. A 90-second cap
  once killed a healthy image pull that went on to finish in 175 seconds.

## Persistence

Everything lives in one data directory: `settings.json`, `auth.json` (mode
`0600`), `jobs.json`, `updates.json`, `activity.json`, and a rotating log
(5MB, two kept). No database.

Per-service stack files live under the configured stack root — a real
`compose.yml` and `.env` you can read, edit, or run by hand. The Compose file
*is* the state. That is what makes leaving cost nothing.

## Startup order

`app.listen` runs **before** `initialize()`. Initialisation inspects every
container and attaches the controller to each service network, which took four
minutes on a busy NAS — and the container healthcheck allows twenty seconds and
three retries, so a perfectly healthy controller was marked unhealthy and
restarted mid-startup, forever.

`/api/health` only claims the process is answering, which is true the moment the
port is open. Everything else stays behind the auth gate.
