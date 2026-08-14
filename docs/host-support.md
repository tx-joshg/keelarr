# Keelarr Host Support

This document defines how Keelarr thinks about hosts.

The goal is portability without pretending every environment is identical.

> **What is actually built:** two adapters, `qnap` and `generic-docker`. Sections
> below that describe a Synology adapter, or capabilities on Unraid and TrueNAS,
> are **design intent — no such adapter exists**. Those hosts fall back to generic
> detection today, and nobody has reported what that produces.
>
> Two hosts have run Keelarr at all: a QNAP and a Mac. See
> [testing.md](testing.md#platforms) for the honest platform table, and
> [help wanted](testing.md#help-wanted) if you have one of the untested ones.

## Core Principle

Keelarr is host-agnostic at the core and adapter-driven at the edge.

The core product should target a Docker Compose capability model, not a specific NAS vendor.

## Host Capability Contract

To qualify for managed mode, a host must allow Keelarr to:

- execute Docker commands
- execute Compose commands
- read and write stack files
- read and write config directories
- reach app URLs for health checks

If a host satisfies those capabilities, Keelarr should treat it as managed.

## Support Tiers By Host Type

### Tier 1: Managed

These environments are the intended first-class targets.

#### Generic Linux Docker Host

Examples:

- mini PC
- VM
- dedicated server
- NAS with normal shell access

Managed capabilities:

- full Keelarr flow
- new-stack install
- import existing Docker
- update and upgrade actions

#### QNAP With Container Station

Managed capabilities:

- full Keelarr flow
- QNAP-specific path and Docker binary detection
- import existing containers

Adapter expectations:

- detect nonstandard Docker binary path when present
- detect shared container and media roots

#### Synology With Docker / Container Manager

Intended capabilities — **not built, and never tested on a Synology**:

- full Keelarr flow
- Synology-oriented default path detection
- import existing containers and Compose folders

Adapter expectations:

- detect common volume roots
- detect common Docker project locations

### Tier 2: Import / Adopt

These hosts are Docker-capable but may need more validation before being declared fully managed.

Examples:

- custom appliance Linux installs
- vendor-modified systems with Docker access but unusual path rules

Keelarr behavior:

- allow scan and preview
- allow staged adoption
- warn when detection confidence is low

### Tier 3: Observe Only

These are not first-class managed in `v1`.

Examples:

- native Windows services
- native Linux services without Docker
- mixed hosts where Keelarr cannot safely own the lifecycle

Keelarr behavior:

- allow external links
- allow health checks
- mark as externally managed

## Adapter Responsibilities

Adapters should do detection and suggestion, not redefine core behavior.

### Adapter Inputs

- shell command availability
- Docker binary candidates
- compose availability
- candidate stack roots
- candidate config roots
- candidate media roots
- candidate logs paths

### Adapter Outputs

- host profile candidates
- confidence scores
- platform label
- warnings requiring manual confirmation

## Generic Docker Host Adapter

### Purpose

The baseline adapter.

### Behavior

- try `docker`
- verify `docker version`
- verify `docker compose version`
- ask user for stack root if no obvious default exists

### Default Assumptions

None beyond standard Docker availability.

## QNAP Adapter

### Purpose

Improve onboarding on QNAP without making QNAP special in the core architecture.

### Heuristic Responsibilities

- try standard `docker`
- try QNAP-specific Docker binary candidates
- detect likely stack roots under shared storage
- detect likely config root under shared storage
- detect likely media root under shared storage
- detect Plex logs path if present

### Special Concerns

- Docker may not be on the non-interactive shell path
- existing containers may come from Container Station rather than Compose
- some configs may live in Docker-managed volumes instead of bind mounts

## Synology Adapter — not built

Design intent only. There is no Synology adapter in `src/lib/host-adapters/`;
Synology hosts fall back to generic Docker detection, and no one has reported
what that suggests there.

### Purpose

Improve onboarding on Synology without creating a separate product fork.

### Heuristic Responsibilities

- detect Docker binary availability
- detect likely project or compose directories
- detect likely shared volume roots
- detect media and config paths

### Special Concerns

- Compose stacks may already exist outside of Keelarr conventions
- shared folders may differ between users and devices

## Custom Host Adapter

### Purpose

Serve any system where automatic detection is incomplete.

### Behavior

- show raw command validation
- let user specify every host profile field manually
- keep validation strict

## Detection Confidence

Each detected field should carry a confidence level:

- `High`
- `Medium`
- `Low`
- `Manual`

Examples:

- Docker binary validated by execution: `High`
- guessed media root from common path names: `Medium`
- inferred Plex logs path from Tautulli mount: `High`
- user-entered custom path: `Manual`

## Existing Docker Import Strategy

Import should not depend on vendor APIs.

It should rely on:

- Docker inspect data
- Docker volume data
- Docker network data
- discovered Compose files if present

That keeps the import model portable across QNAP, Synology, and generic Linux.

## Native Install Strategy

Native installs are not fully managed in `v1`.

### V1 Native Behavior

- optional later detection
- external service cards
- observe-only health and links

### Future Native Behavior

- migration guidance into Docker
- possibly host agents for deeper service control

## Host Profile Schema

Every managed host profile should eventually include:

- host label
- adapter type
- Docker binary path
- compose root
- config root
- media root
- downloads root
- optional Plex logs path
- timezone
- PUID
- PGID
- base URL or host address
- detection confidence per field

## Vendor Neutrality Rules

### Allowed Vendor Specificity

- heuristics
- documentation
- suggested defaults
- adapter messaging

### Forbidden Vendor Specificity In Core

- vendor GUI as system of record
- vendor-only configuration format
- vendor-only runtime contract

## Build Implications

Implementation should separate:

- host detection
- host validation
- host profile persistence
- service template generation
- runtime operations

The host adapter layer feeds the rest of the system, but the rest of the system should not need to know whether the host is QNAP, Synology, or generic Linux.

