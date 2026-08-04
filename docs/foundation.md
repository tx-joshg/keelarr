# Stackarr Foundation

This document captures the product decisions that define Stackarr's initial architecture and scope. It exists so implementation decisions stay consistent as the project grows.

## Product Definition

Stackarr is an Arr-focused control plane.

It is not:

- a generic homelab dashboard
- a full self-hosted marketplace
- a vendor-specific NAS app

It is:

- one controller install
- one host-level setup flow
- one dashboard for the Arr ecosystem
- one place to generate, deploy, observe, upgrade, and eventually roll back supported apps

## Core User Promise

The user installs Stackarr once, confirms host-level defaults once, and then installs or manages the rest of the stack with minimal per-app input.

That means Stackarr should prefer:

- opinionated defaults
- host-level shared configuration
- one-click app installs when possible
- advanced options only when needed

## Supported App Scope

### First-Class Apps

- Prowlarr
- Radarr
- Sonarr
- Lidarr
- Readarr
- Bazarr
- Trailarr
- Ombi
- Tautulli

### Core Companions

- SABnzbd

Future companion support can include torrent clients and Recyclarr, but they are not required to validate the initial product loop.

## Support Model

Stackarr is hardware-agnostic and Docker-first.

The target is not "QNAP support" or "Synology support" as separate product lines. The target is any host that can satisfy the Stackarr runtime contract.

### Managed Host Contract

To be first-class managed, a host must provide:

- Docker Engine access
- Compose access
- readable and writable stack directories
- readable and writable config directories
- access to media and download paths
- network reachability for app health checks

If a host supports that contract, Stackarr should manage it regardless of whether it is QNAP, Synology, Unraid, or generic Linux.

## Support Tiers

### Tier 1: Managed

Stackarr can:

- generate Compose stacks
- deploy containers
- check health
- check updates
- upgrade one service
- upgrade all services
- back up managed stack metadata

### Tier 2: Import / Adopt

Stackarr can:

- scan existing Docker containers or Compose projects
- identify supported apps
- infer ports, paths, images, mounts, networks, and restart settings
- preview a Stackarr-managed version
- adopt apps one at a time into managed mode

### Tier 3: Observe Only

Stackarr can:

- show status
- show deep links
- mark services as externally managed

This tier is for native installs or unsupported environments until deeper support exists.

## Platform Adapters

Platform adapters should only improve detection and defaults. They should not fork the core product logic.

### Generic Docker Host

The baseline supported platform.

### QNAP Adapter

Should detect likely:

- Docker binary path
- stack root
- config root
- media root
- downloads root
- Plex logs path

### Synology Adapter

Should detect common Synology volume and Docker layouts.

### Custom Host

Allows manual configuration when detection is incomplete.

## Source Of Truth

For managed services, Docker Compose is the source of truth.

Stackarr should manage:

- generated `compose.yml`
- generated `.env`
- host-level defaults
- service metadata
- backup metadata for upgrades and adoption

It should not depend on vendor-specific GUI state as the primary control plane.

## Onboarding Modes

### Mode A: New Stack

For users starting clean.

Flow:

1. install Stackarr
2. confirm host profile
3. choose apps
4. review generated stack plan
5. generate and optionally deploy

### Mode B: Import Existing Stack

For users who already run containers.

Flow:

1. scan Docker
2. recognize supported apps
3. infer shared paths and defaults
4. show app mapping cards
5. flag problems
6. generate preview Compose
7. adopt one app at a time

## First-Run Wizard

The first-run wizard should configure host-level answers once.

### Screen 1: Welcome

Choices:

- New Stack
- Import Existing Stack

### Screen 2: Host Detection

Detect and prefill:

- Docker binary
- Compose root
- config root
- media root
- downloads root
- Plex logs path
- timezone
- PUID
- PGID

### Screen 3: Library Layout

Confirm:

- Movies path
- TV path
- Music path
- Books path
- Downloads path

Stackarr should prefer one consistent container media root, such as `/Media`, to reduce path mismatch bugs.

### Screen 4: Apps To Install

Default cards should include:

- Prowlarr
- Radarr
- Sonarr
- Bazarr
- Trailarr
- Ombi
- Tautulli
- SABnzbd

Optional:

- Lidarr
- Readarr

### Screen 5: Download Strategy

Minimal choices:

- use SABnzbd
- install managers only for now
- add other download clients later

### Screen 6: Ports Review

Show defaults and only ask for changes if there is a conflict.

### Screen 7: Review Plan

Show:

- folders that will be created
- compose stacks that will be generated
- app images
- paths and ports
- whether deployment will happen now

### Screen 8: Install Progress

Show each app separately with:

- generating
- deploying
- health check
- ready

### Screen 9: Post-Install Connections

This should be a guided next step, not part of the initial burden.

Examples:

- connect Prowlarr to Sonarr and Radarr
- connect SABnzbd to Arr apps
- connect Tautulli to Plex

## Import Existing Stack Design

Import must be safe and mostly read-only until the adoption step.

### Import Stages

1. inspect existing containers and Compose stacks
2. match supported apps
3. infer global defaults from current reality
4. identify configuration problems
5. generate proposed Stackarr-managed Compose files
6. preview differences
7. adopt services one at a time

### Problems Import Should Flag

- wrong media mounts
- inconsistent container paths
- anonymous Docker volumes for `/config`
- duplicate port usage
- missing Plex log access for Tautulli
- downloads outside the media tree
- network modes that do not match the selected app model

### Adoption Rules

- take inspect backup first
- preserve current config paths or volumes
- never bulk adopt everything by default
- keep fallback containers for rollback
- verify each app before moving to the next

## Native Install Strategy

Stackarr should not try to fully manage native installs in the first release.

### Initial Native Strategy

- detectable later
- observable later
- migratable later

The first goal is Docker-first management, not Windows service orchestration or distro-specific package management.

## Product Principles

### 1. Global Questions Once

Do not ask for timezone, PUID, PGID, base paths, or similar host-level settings on every app install.

### 2. Minimal Per-App Configuration

Only ask app-specific questions when there is no safe default.

### 3. One App At A Time For Risky Operations

Import, adoption, and rollback-sensitive upgrades should be isolated per service.

### 4. Compose Is The Managed Artifact

Generated stack files must be understandable, portable, and versionable.

### 5. Vendor-Agnostic Core

Adapters help detect paths and defaults. They do not define the architecture.

## Non-Goals For The Initial Release

- generic app marketplace
- Kubernetes support
- public reverse proxy automation
- native install management
- multi-node cluster orchestration
- replacement for general Docker control planes

## Immediate Build Implications

The current MVP should evolve toward:

1. host detection profiles
2. import scanning for existing Docker containers
3. one-click install flows from shared defaults
4. guided post-install app linking
5. backup and rollback metadata that is stronger than the current pre-upgrade file backup

## Definition Of A Good V1

A user should be able to:

1. install Stackarr once
2. confirm a small number of host defaults
3. click install on core Arr apps
4. open those apps from one dashboard
5. check health and update availability
6. upgrade a service or the whole stack from one place

If the user has an existing Docker-based stack, they should be able to:

1. scan it
2. preview it
3. adopt one app at a time safely

