<div align="center">

# Keelarr

**A control plane for your \*arr stack that generates Compose files you can read,
adopts the containers you already run, and wires the whole thing together —
without ever claiming it did something it didn't.**

[Quick start](#quick-start) · [What makes it different](#what-makes-it-different) ·
[What is actually tested](docs/testing.md) · [Help wanted](#help-wanted)

![The Keelarr dashboard: eight apps, their images, ports, Compose state and health](docs/images/dashboard.png)

</div>

---

## The problem

Running an \*arr stack is not hard because the containers are hard. It is hard
because of everything between them.

Nine apps, and each one has to be told about the others: the download client
registered in Radarr, Sonarr and Lidarr with a category apiece; every app
registered in Prowlarr, with an address that works *from Prowlarr's side of the
network*; Bazarr pointed at Radarr and Sonarr; FlareSolverr registered as
Prowlarr's proxy; root folders that exist inside the container *and* on the host,
owned by the right user. Then a container moves to a different network, or you
rebuild one, and half of those addresses silently stop resolving.

Most of that work is mechanical. It is also exactly the work that no tool does
for you.

## What Keelarr does

It runs as one container, reads your Docker socket, and gives you:

- **A dashboard** for the stack — what is deployed, running, reachable, and out of date.
- **One-click install** of any app in the catalog, with the Compose file written to disk.
- **Adoption** of containers you already run, read-only first, with a revert.
- **Wiring**: it works out what should be connected to what, resolves an address
  that works from each app's own position on the network, tests the connection
  using the app's own test endpoint, and only then writes it.
- **Upgrades and rollbacks**, including a config snapshot so a rollback restores
  the app's database, not just its image.
- **Removal that is reversible** — keep the config, reinstall later, and the app
  comes back as itself rather than as a fresh install.

Twelve apps in the catalog: Prowlarr, Radarr, Sonarr, Lidarr, Bazarr, SABnzbd,
qBittorrent, FlareSolverr, Jellyfin, Trailarr, Ombi, Tautulli.

The stack check is the clearest picture of what it is for — every connection,
the address each one resolved to, whether the app itself confirmed it, and the
short list of things only you can supply:

![Stack wiring: six connections confirmed, with Prowlarr still needing an indexer only the operator can add](docs/images/stack-check.png)

## What makes it different

### It writes Compose files, and they are yours

Keelarr is not a runtime. Every service it manages is a real `compose.yml` and
`.env` on disk, in a directory you choose, that you can read, edit, `docker
compose up` by hand, or commit to git. There is no hidden state describing your
infrastructure — the Compose file *is* the state.

Which means leaving costs nothing. Stop the controller and your stack keeps
running, because nothing about it depended on Keelarr being alive.

### It adopts what you already have

Most tools of this kind assume a greenfield. Keelarr assumes the opposite: you
have a stack, it works, and you are not going to rebuild it to try something.

So adoption is read-only first. It scans your containers, shows you the mounts,
ports, networks and env *key names* — never values — and produces a managed draft
that preserves the shape of what you already run, down to host networking, static
addresses on a macvlan, named volumes, and entrypoint overrides. Cutover is a
separate, explicit step. Revert is one click.

![The adoption scan listing existing containers, what each was recognised as, and one marked unsupported](docs/images/adoption.png)

Note the last row. Keelarr says when it does *not* recognise something, rather
than adopting it and hoping.

### It knows the difference between "no" and "I don't know"

This is the part that took the longest and matters the most.

A container that is running is not necessarily reachable. A connection that was
not written is not necessarily broken. An app that answered nothing might be
starting, or might be unreachable forever, and those need different words.

So Keelarr reports three states, not two. `reachable: null` means *not
determined*, and the dashboard says so rather than showing green. A wiring run
that changes nothing reports as finished, not failed — but only says "everything
is already configured" when every link was actually confirmed correct; if two
links were merely unreachable, it says that instead.

Every one of those distinctions exists because the honest-looking version was
wrong first, in a way a green dashboard hid. [docs/testing.md](docs/testing.md)
lists what has been proven and on which host, and keeps automated coverage and
live evidence in separate columns, because they prove different things.

### It never touches what is yours

- **API keys are never persisted, logged, or returned by the API.** They are read
  at the moment they are needed. What the API returns is a source path and a
  truncated fingerprint. A test asserts no 32-character hex key appears in any
  response.
- **Indexers are counted, never read or written.** They carry credentials you paid
  for. Keelarr has no business in them.
- **Existing configuration is never overwritten.** A download client pointing
  somewhere unexpected is reported as drift and left exactly as it is. Two
  candidates and no clear match is reported as ambiguous and left alone.
- **App databases are moved, never edited.** Config snapshots are tarballs. Nothing
  parses another app's schema, so nothing breaks on its next migration.
- **Command output that could contain secrets is withheld from the log** — byte
  counts instead of contents.

### It tells you what only you can supply

A stack can be perfectly wired and still not work, because it needs an indexer,
a Usenet account, or a Plex token — things no tool can invent. Keelarr separates
*wired* from *working*, and ends the stack check with the short list only you can
finish.

## Quick start

Requires Docker and the Compose plugin. No checkout needed — the image is
published.

```bash
mkdir -p ~/keelarr && cd ~/keelarr && curl -fsSLO https://raw.githubusercontent.com/tx-joshg/keelarr/main/deploy/compose.example.yml
```

```bash
docker compose -f compose.example.yml up -d
```

Then open <http://localhost:4687>. On first run it asks you to set a password,
detects your host, and suggests paths. Nothing needs editing before the first
start — the defaults land under `$HOME/keelarr`, and you change them in the app.

![Host detection scoring two host profiles, with per-field confidence and validation status](docs/images/host-detection.png)

Detection scores every profile it knows and shows you why, per field. It suggests
— it does not decide.

To run from a checkout instead:

```bash
git clone https://github.com/tx-joshg/keelarr.git && cd keelarr/deploy && docker compose -f compose.example.yml -f compose.build.yml up -d --build
```

### Try it without a stack

Demo mode runs against a simulated stack with no Docker socket behind it, so
there is nothing to break and no password in the way:

```bash
KEELARR_DEMO=1 npm start
```

## Where it runs

| Platform | State |
| --- | --- |
| QNAP Container Station (x86_64) | **Live** — the primary test host, a real stack with real media |
| macOS + Docker Desktop (arm64) | **Live** — a full lifecycle from an empty host |
| Linux x86_64 / arm64 | **Untested** — the most likely host of all. [Help wanted](#help-wanted) |
| Synology, Unraid, TrueNAS SCALE | **Untested** |
| Windows | **Unsupported** outside WSL2 — Keelarr mounts host paths at the same absolute path inside the container, which `C:\` cannot satisfy |

Being honest about this is the point: two hosts is not "runs anywhere", and the
table says so.

## How it works

The controller container mounts your Docker socket and the host roots your stack
uses, at the same absolute path inside the container as outside. That single rule
is what lets it generate a Compose file whose paths are correct for the host
while still being able to read them itself.

```
you ──▶ Keelarr controller ──▶ writes compose.yml + .env per service
                │                       │
                │                       └──▶ docker compose up
                │
                └──▶ each app's own REST API ──▶ download clients, indexer apps,
                                                 root folders, proxies, subtitles
```

Wiring resolves addresses per network topology — host, bridge, a shared
user-defined network, or macvlan — from the *source* app's position, because
"localhost" means something different in each. A pair that genuinely cannot reach
each other is reported as blocked, with the reason, rather than given an address
that will time out.

More detail in [docs/architecture.md](docs/architecture.md).

## Contributing

The most useful contribution right now is not code.

### Help wanted

Keelarr has been proven on two hosts. The table above is honest about that, and
the fastest way to make it less embarrassing is to run it somewhere else and say
what happened. **A report that it worked is worth as much as a bug report.**

[docs/testing.md](docs/testing.md#help-wanted) lists eleven scenarios written to
be closeable without a conversation first — run the steps, paste the output, say
what your host is. Please redact API keys, indexer names, Usenet hostnames and
Plex tokens.

### If you do want to write code

```bash
npm install && npm test
```

No framework, no build step, no transpiler. Plain ES modules, `node:test`, and
dependency injection through `*Impl` constructor parameters so everything is
testable without touching Docker.

Two rules the codebase actually holds to:

1. **Never claim something you have not verified.** If it cannot be determined,
   say so. Most of the guards in here exist because a cheerful default hid a real
   failure.
2. **Tests stub every injected implementation that touches Docker or the
   filesystem.** Stubbing one layer is not enough if a layer underneath still
   reaches the real machine — that mistake once overwrote a live controller's
   `.env` from a test fixture.

Comments explain *why*, not what. If the reason a line exists is a defect that
was found the hard way, the comment says so, because that is what stops it being
"simplified" back.

## Licence

[PolyForm Shield 1.0.0](LICENSE). In plain terms:

- **Use it free**, for anything — at home, at work, on a client's server, in a
  business. Run it, modify it, redistribute it.
- **The one exception**: you may not use it to build or sell a product that
  competes with Keelarr. If you want to sell it, or something built from it,
  talk to me about a commercial licence first.

This is source-available rather than OSI-approved open source, and the
distinction is worth stating plainly rather than burying: the code is here to
read, fork and change, and the only thing barred is reselling it as a rival
product.

## Support

Keelarr is free to use and always will be. If it saved you an evening, you can
[buy me a coffee](https://ko-fi.com/keelarr) — but a test report from a host
nobody has tried is worth more.

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/testing.md](docs/testing.md) | What has been tested, on which host, and what has not |
| [docs/architecture.md](docs/architecture.md) | How it is actually built, and which decisions a real host forced |
| [docs/demo-walkthrough.md](docs/demo-walkthrough.md) | A guided tour of demo mode, screen by screen |
| [docs/scenarios.md](docs/scenarios.md) | The three scenarios every change is checked against |
| [docs/host-support.md](docs/host-support.md) | How Keelarr thinks about hosts, and which adapters exist |
| [docs/roadmap.md](docs/roadmap.md) | What is next, what is not being built, and the known limits |

Kept as a record of intent rather than a description of the software:
[foundation.md](docs/foundation.md) and [product-spec.md](docs/product-spec.md)
(the original design), plus [qnap-first-test.md](docs/qnap-first-test.md) and
[live-cutover-test.md](docs/live-cutover-test.md) (dated test records). Where
any of them disagrees with the running code, the code is right.
