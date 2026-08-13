# The Three Scenarios

Every change to setup, deployment, wiring, or removal gets checked against all
three of these. They are written down because they were being remembered ad hoc,
and a change that improves one of them can quietly break another — that has
already happened more than once.

The scenarios differ in what already exists, which is exactly what makes them
catch different bugs.

| | What exists beforehand | What it proves |
| --- | --- | --- |
| **A. Build new** | Nothing | Keelarr can create a working stack from an empty host |
| **B. Delete and redeploy** | Config on disk, no containers | Keelarr can put back what it removed, unchanged |
| **C. Adopt existing** | A running stack nobody told Keelarr about | Keelarr can take over without disturbing it |

---

## A. Build everything new

A host with Docker and nothing else.

1. The controller starts from the documented quick start alone. It creates the
   shared network itself — nothing is declared external, and nothing has to
   exist first.
2. The first page asks for a password and nothing else works until one is set.
   The container's own healthcheck still passes, because it probes
   `/api/health`, which is deliberately outside the gate.
3. The setup wizard detects the host, and every path it suggests is a path the
   controller can actually see. A root outside its own mounts is reported as
   unmounted, naming the variable that fixes it, rather than as missing.
4. Deploying writes `compose.yml` and `.env` per service and brings them up on
   the shared network.
5. Wiring runs on its own afterwards. Download clients, library folders and
   Prowlarr applications are configured without being asked for, and what an
   app needs in order to accept them — a download category, a library directory
   — is created rather than left as homework.
6. The check ends at **needs you**, listing only what Keelarr cannot supply:
   an indexer key, a Usenet account, a Plex token. Each with what it breaks and
   a link to the page that fixes it.

**The trap:** a fresh app has not written its API key yet. That is `pending`,
not `absent`, and wiring waits for it rather than concluding there is nothing
to do.

## B. Delete everything and redeploy

The same host, after removing every service but keeping configuration.

1. Removal keeps enough to reinstall the same service — mode, image, port,
   container name — and archives its stack files. Dropping that record turns an
   imported service into a catalog one, pointing at a config path that has never
   existed.
2. Removing the last service leaves an empty stack. An empty selection after
   setup is a decision, not an absence, and must not be refilled with defaults.
3. Reinstalling restores the archived compose rather than generating a new one.
   For an imported service that file is the only surviving record of its image,
   network mode, entrypoint and named volume.
4. The app returns with its database intact: same API key, same library, same
   indexers, same download client. Nothing is reconfigured by hand.
5. Wiring reports everything already correct and writes nothing.
6. Recreating the controller itself does not ask for a new password, and does
   not sign anyone out: the hash lives in `data/`, and the session cookie is
   signed rather than held in memory.

**The trap:** configuration in a named volume looks like nothing at all once the
container is gone. Resolve it while the container still exists, or a 112MB
database gets reported as absent.

## C. Adopt an existing stack

A host already running these apps, configured by hand over years, where Keelarr
is being introduced to manage them.

1. The read-only scan reports what is running without exposing secrets, and
   recognises services by image and name.
2. A managed draft preserves the live container exactly: image, ports, restart
   policy, mounts, entrypoint, command, and whatever network it is on. Catalog
   defaults must not leak into it.
3. Cutover is reversible, verified before the old container is discarded.
4. Addresses are resolved from what the containers actually are. A macvlan app
   answers on its own address, a host-networked one on the host's, and two
   bridge containers that cannot route to each other are reported blocked
   rather than given an address that times out.
5. Existing configuration is read, never overwritten. A download client already
   pointing somewhere is reported as drift; two of them are ambiguous and are
   left alone.
6. The password is Keelarr's own, set on first run like any other install. It
   is not an account in any of the adopted apps and does not touch their logins.

**The trap:** composing an address from the host URL and a port. It produces
something that answers — on a QNAP, the NAS admin interface — and a health check
that can never fail.

---

## Running them

A and B can be run end to end against a live host. C needs a stack that predates
Keelarr, so it is exercised against the imported services already present
rather than staged from scratch.

Order matters when running these for real: least valuable service first, and
take an independent copy of anything irreplaceable before touching it. The
config snapshot Keelarr writes is not a substitute for that when the code
taking it is the code under test.
