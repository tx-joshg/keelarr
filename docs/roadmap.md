# Stackarr Roadmap

This roadmap translates the product and architecture documents into a staged implementation plan.

Dates are intentionally omitted at this stage. The goal is sequencing, not calendar promises.

## Phase 0: Foundation

Status:

- partially complete

Outcomes:

- Arr-focused product scope
- host support model
- first product spec
- initial MVP code scaffold

Artifacts:

- `docs/foundation.md`
- `docs/product-spec.md`
- `docs/host-support.md`
- `docs/architecture.md`

## Phase 1: Solidify The Current MVP

Goal:

Make the current controller stable enough for local demos and iterative development.

Required work:

- harden route handlers
- move workflow logic out of `server.js`
- improve update result handling
- improve error messages
- add more tests around compose rendering and state building
- make the first-run flow fully predictable

Exit criteria:

- reliable local boot
- stable dashboard refresh
- stable generate/deploy flow on a Docker host

## Phase 2: Host Profiles And Adapters

Goal:

Introduce adapter-driven host detection without changing the core product model.

Required work:

- create a host adapter interface
- implement generic Docker adapter
- implement QNAP adapter
- stub Synology adapter
- store field-level detection confidence
- separate validation from UI flow

Exit criteria:

- host profile detection is modular
- QNAP-specific logic is not mixed into core service logic

## Phase 3: Better Stack Generation

Goal:

Turn Compose generation into a stable artifact pipeline.

Required work:

- formalize service templates
- support advanced overrides cleanly
- add template validation
- write versioned stack artifacts
- improve `.env` generation rules

Exit criteria:

- deterministic Compose output
- readable generated files
- per-service overrides no longer require ad hoc code paths

## Phase 4: Import Existing Docker

Goal:

Support the real-world migration path for users with messy existing stacks.

Required work:

- container scan
- image/mount/port/env inference
- service recognition
- issue detection
- adoption preview generation
- per-service adoption workflow

Exit criteria:

- a Docker-based existing stack can be previewed
- one supported service can be adopted safely

## Phase 5: Guided App Linking

Goal:

Reduce manual setup inside the Arr ecosystem after deployment.

Required work:

- Prowlarr to Arr linking guidance
- SABnzbd linking guidance
- Tautulli to Plex guidance
- path consistency validation

Future direction:

- optional API-driven setup automation where safe

Exit criteria:

- post-install setup burden is reduced meaningfully

## Phase 6: Stronger Upgrade And Rollback

Goal:

Make updates safer and more trustworthy.

Required work:

- explicit pre-upgrade snapshot model
- better image version tracking
- rollback metadata
- per-service rollback flow

Exit criteria:

- upgrade is no longer just pull + recreate
- rollback path is explicit and testable

## Phase 7: Security And Production Readiness

Goal:

Make Stackarr safe enough for broader real-world use.

Required work:

- controller authentication
- secret handling rules
- mutation protection
- safer install guidance
- audit logging improvements

Exit criteria:

- Stackarr can be recommended beyond LAN-only development use

## Phase 8: Observe-Only External Services

Goal:

Start supporting non-Docker users without overpromising lifecycle management.

Required work:

- external service cards
- link and health-only records
- manual service registration
- import path for native installs as external services

Exit criteria:

- a user can include externally managed apps in the dashboard

## Phase 9: Native Migration Helpers

Goal:

Help native-install users move into Docker-managed mode.

Required work:

- migration planning
- data path guidance
- service cutover checklists

Exit criteria:

- Stackarr can guide a native user into a Docker-managed stack without claiming full native lifecycle management

## Explicit Non-Goals Until Later

The following should stay out of scope unless the product proves demand:

- generic app marketplace
- Kubernetes
- multi-host orchestration
- public reverse proxy automation
- vendor-specific GUI integrations as the source of truth

## Practical Next Build Step

The best immediate implementation step after the current documentation set is:

1. refactor `server.js` into application services
2. define the host adapter interface
3. add a generic Docker adapter and QNAP adapter

That path aligns directly with the current codebase and the product direction.

