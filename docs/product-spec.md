# Stackarr Product Spec

This document converts the product foundation into implementable behavior.

It defines:

- the first-run wizard
- the dashboard
- install and import flows
- upgrade behavior
- the minimum interaction contract for `v1`

## Product Goal

Stackarr should let a user:

1. install one controller
2. confirm a small number of host-level defaults
3. install or adopt Arr ecosystem apps with minimal extra input
4. monitor and operate those apps from one dashboard

## Primary User

The primary user is someone running a media automation stack who wants:

- less Docker knowledge
- fewer path mistakes
- one place to launch apps
- one place to upgrade apps
- safer migration from ad hoc container setups to managed Compose stacks

## Supported App Set For V1

### First-Class

- Prowlarr
- Radarr
- Sonarr
- Lidarr
- Readarr
- Bazarr
- Trailarr
- Ombi
- Tautulli

### Core Companion

- SABnzbd

## UX Principles

### 1. Shared Answers Once

Host-level answers must be collected once and reused:

- Docker path
- stack root
- config root
- media root
- downloads root
- timezone
- PUID
- PGID

### 2. App Install Should Be Near One-Click

If host defaults are valid, installing a new app should require:

- no extra questions in the common case
- only optional `Advanced` overrides

### 3. Risky Actions Must Be Explicit

Actions like import adoption or upgrade-all must:

- show what will change
- create backup metadata first
- report per-service outcomes

### 4. Safe Defaults Beat Wide Configuration

Ports, images, restart policy, standard mounts, and common paths should default automatically.

## Terminology

### Host Profile

The saved shared configuration for the current Docker host.

### Service Template

The Stackarr default model for one supported app.

### Managed Service

A service whose Compose stack is generated and controlled by Stackarr.

### Imported Service

A service discovered from an existing Docker setup and then adopted into Stackarr management.

### External Service

A service visible in the dashboard but not managed by Stackarr.

## First-Run Modes

### Mode A: New Stack

Used when the user wants Stackarr to create and optionally deploy the stack from scratch.

### Mode B: Import Existing Stack

Used when the user already has Docker containers or Compose stacks and wants Stackarr to adopt them safely.

## Reviewable Demo Mode

Stackarr should also support a safe review mode for product evaluation.

Purpose:

- let a user explore the full dashboard without a real Docker host
- exercise install, upgrade, and adoption flows end to end
- provide stub destinations for deep links so the UX can be reviewed

Behavior:

- clearly label the controller as demo mode
- simulate Docker mutations rather than calling the real Docker binary
- seed sample managed services and import candidates
- allow reset back to the original sample scenario

Scope:

- this is a product review tool, not a fake backend for production use

## First-Run Wizard

The wizard should be shown on first launch and remain accessible later as `Host Settings`.

### Screen 1: Welcome

Purpose:

- explain what Stackarr manages
- choose onboarding mode

Controls:

- button: `New Stack`
- button: `Import Existing Stack`

Helper copy:

- “Stackarr manages Arr ecosystem apps from one place.”
- “Start clean or import what you already run.”

### Screen 2: Host Detection

Purpose:

- detect likely host defaults
- let the user confirm or edit them

Required fields:

- Docker binary path
- stack root
- config root
- media root
- downloads root
- timezone
- PUID
- PGID

Optional field:

- Plex logs path

Advanced-only fields:

- host URL base
- custom backup root
- default image tag policy

Behavior:

- attempt automatic detection first
- show confidence hints like `Detected`, `Guessed`, or `Manual`
- block continue if Docker binary or stack root is missing

Validation:

- Docker binary must execute
- `docker version` must succeed
- `docker compose version` must succeed
- stack root must be writable

### Screen 3: Library Layout

Purpose:

- confirm how media and downloads are laid out

Fields:

- Movies path
- TV path
- Music path
- Books path
- Downloads path

Derived values:

- default container media root: `/Media`
- container config root remains app-specific, not shared

Behavior:

- auto-suggest paths beneath the host media root
- allow blank Music and Books if those apps are not selected

Warnings:

- downloads path outside media root
- obvious overlap or duplicated paths

### Screen 4: Apps To Install

Purpose:

- choose the service set

Default selected:

- Prowlarr
- Radarr
- Sonarr
- Bazarr
- Trailarr
- Ombi
- Tautulli
- SABnzbd

Optional unselected by default:

- Lidarr
- Readarr

Each card must show:

- app name
- short description
- default port
- category
- install toggle

Advanced per-card overrides:

- image
- port

### Screen 5: Download Strategy

Purpose:

- choose the downloader direction without forcing detailed configuration

Choices:

- `Use SABnzbd`
- `Managers only for now`
- `I will add a downloader later`

If SABnzbd is selected:

- keep the default port
- do not ask for categories in `v1`

### Screen 6: Ports Review

Purpose:

- show proposed ports and resolve conflicts

Behavior:

- show all selected services with their default ports
- only prompt for edits where a conflict exists

Default ports:

- Prowlarr `9696`
- Radarr `7878`
- Sonarr `8989`
- Lidarr `8686`
- Readarr `8787`
- Bazarr `6767`
- Trailarr `7889`
- Ombi `3579`
- Tautulli `8181`
- SABnzbd `8080`

Conflict rules:

- if a port is unused, keep default
- if in use by the same recognized imported app, allow it
- if in use by another process or service, force user choice

### Screen 7: Review Plan

Purpose:

- show what Stackarr will create or manage before anything changes

Must show:

- selected apps
- image per app
- host config path per app
- media mount paths
- ports
- stack file locations
- whether deployment will happen now

Actions:

- `Generate Only`
- `Generate And Install`

### Screen 8: Progress

Purpose:

- show per-service execution progress

Each selected service should show:

- generating files
- writing `.env`
- pulling image
- creating container
- health check
- ready / failed

Failure behavior:

- one app failure must not erase the progress of others
- failure details must be visible inline and in the activity log

### Screen 9: Post-Install Actions

Purpose:

- guide the user to the next useful steps

Suggested tasks:

- connect Prowlarr to Radarr and Sonarr
- connect SABnzbd to Arr apps
- connect Tautulli to Plex
- verify media path consistency

This screen should be optional and skippable.

## Import Existing Stack Flow

Import mode is read-only until the user confirms adoption.

### Stage 1: Docker Scan

Must inspect:

- containers
- images
- ports
- env vars
- bind mounts
- volumes
- restart policies
- networks
- existing Compose folders when discoverable

### Stage 2: Service Recognition

Each discovered container should be categorized as:

- `Supported`
- `Unsupported`
- `Ignored`

Supported containers must be matched to the Stackarr service catalog.

### Stage 3: Shared Defaults Inference

Stackarr should infer likely shared host settings from existing containers.

Examples:

- config root from repeated bind mount patterns
- media root from repeated media mounts
- Plex logs path from Tautulli mounts
- timezone, PUID, PGID from current env values

### Stage 4: Service Cards

Each supported app should show:

- current container name
- image
- current port
- config source
- media mounts
- runtime status
- detected issues

### Stage 5: Problem Detection

Import should flag:

- inconsistent container path conventions
- bad or suspicious media mounts
- anonymous Docker volumes for `/config`
- duplicate or conflicting ports
- host network use where bridge would be safer
- Tautulli without Plex logs
- download path mismatches

Each issue should have:

- severity
- explanation
- recommended action

### Stage 6: Adoption Strategy

Per service, the user can choose:

- `Adopt As-Is`
- `Generate Only`
- `Skip`

Defaults:

- safe, recognized apps should default to `Adopt As-Is`
- unclear or risky apps should default to `Skip`

### Stage 7: Preview

Before adoption, Stackarr must generate preview stack files and show:

- what remains unchanged
- what will be normalized
- where backups will be written
- whether current data stays in a bind mount or existing Docker volume

### Stage 8: Adoption Execution

Adoption should run one app at a time:

1. inspect backup
2. compose preview backup
3. stop old container
4. rename old container to fallback
5. start Stackarr-managed replacement
6. verify health

### Stage 9: Completion

Once adopted, the service becomes `Managed`.

Dashboard state should then use:

- generated Compose files
- Stackarr backups
- Stackarr update checks

## Dashboard Spec

The dashboard is the main operating surface after onboarding.

### Required Sections

- host summary
- diagnostics
- activity log
- managed services board

### Host Summary

Must show:

- host mode
- Docker path
- stack root
- count of managed services
- count of healthy services
- count of updates available

### Diagnostics

Should surface:

- path mismatches
- unreachable apps
- missing optional dependencies
- update failures

### Activity Log

Must record:

- setup saves
- generation actions
- deploy actions
- upgrade actions
- import actions
- failures

### Service Card

Each service card must include:

- app name
- description
- status chip
- update status chip
- runtime state
- HTTP status if probed
- latency if probed
- deep link

### Service Actions

Each managed card needs:

- `Generate`
- `Deploy`
- `Check Update`
- `Upgrade`
- `Open`

Future actions:

- `Rollback`
- `Edit Advanced`
- `Pause`

### Global Actions

Dashboard-level actions:

- `Refresh`
- `Check All Updates`
- `Upgrade All`

## Service Install Behavior

When the user clicks `Install` or `Deploy` on a service:

1. ensure host settings are saved
2. ensure stack files exist
3. back up current metadata if the service already exists
4. run `docker compose up -d`
5. probe the service
6. log the result

### Common Case

For a new service on a configured host:

- no extra prompt
- use saved defaults

### Advanced Override

Advanced install/edit allows:

- custom image
- custom port
- custom config path
- custom media path override

## Update Behavior

### Check Update

The service action `Check Update` should:

- run the Docker/Compose update check strategy
- store last checked time
- mark service as `Current`, `Update Ready`, or `Unknown`

### Upgrade One

The service action `Upgrade` should:

1. back up current stack metadata
2. pull image
3. recreate service
4. verify health
5. log result

### Upgrade All

Should:

- run per service
- show per-service status
- not abort the entire operation because one service fails

## Rollback Model

Full rollback is not complete in the current MVP, but the product contract should be:

- retain backup metadata before risky changes
- retain enough information to reconstruct previous service state
- later allow one-click rollback to the prior known-good image and Compose definition

## Security Rules

For `v1`:

- do not assume public exposure
- do not encourage public exposure without auth
- do not commit secrets into Git-managed stack definitions

Implemented:

- controller authentication: one password, chosen on first run, required by
  every `/api` route except the health probe. Stored as a salted scrypt hash;
  sessions are HMAC-signed cookies so a controller restart does not sign you
  out. The demo runs without it, having no Docker socket behind it.

## Error Handling

### User-Facing Errors Must Be Actionable

Bad examples:

- `Command failed`

Good examples:

- `Docker binary could not be executed`
- `Port 7878 is already in use by another service`
- `Config root is not writable`
- `Tautulli was deployed but is not reachable on the expected URL`

### Partial Failure Must Be Preserved

If five services succeed and one fails:

- the five successes stay visible
- the one failure keeps its logs and next-step guidance

## V1 Definition Of Done

Stackarr `v1` is successful when:

1. a user can configure host defaults once
2. a user can generate and deploy a new Arr stack
3. a user can import and adopt an existing Docker-based stack one app at a time
4. the dashboard shows health, deep links, and update state
5. the user can upgrade one app or all apps from one place
