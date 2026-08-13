# Keelarr Architecture

This document defines the intended implementation shape for Keelarr after the current MVP.

It bridges product requirements into code boundaries.

## Architecture Goals

Keelarr should be built so that:

- host-specific logic stays isolated
- service-specific templates stay isolated
- runtime Docker operations stay isolated
- product features can expand without rewriting the whole controller

## High-Level System

Keelarr is a single-node web controller with four major concerns:

1. host discovery and validation
2. service modeling and Compose generation
3. runtime operations against Docker / Compose
4. UI and workflow orchestration

## Major Layers

### 1. Web Layer

Responsibilities:

- serve the UI
- expose API endpoints
- translate user actions into application commands

Current MVP files:

- `src/server.js`
- `public/*`

Future direction:

- keep a thin HTTP layer
- move workflow orchestration into services rather than route handlers

### 2. Application Layer

Responsibilities:

- execute user-intent workflows
- coordinate validation, generation, import, deployment, upgrade, and backup actions
- return structured outcomes for UI rendering

Examples of future application services:

- `setupService`
- `hostProfileService`
- `stackGenerationService`
- `importService`
- `adoptionService`
- `upgradeService`
- `healthService`

### 3. Domain Layer

Responsibilities:

- define core models
- define service catalog behavior
- define host profile rules
- define validation rules

Candidate domain concepts:

- `HostProfile`
- `ServiceTemplate`
- `ManagedService`
- `ImportedService`
- `ExternalService`
- `StackPlan`
- `AdoptionPlan`
- `UpgradePlan`

### 4. Infrastructure Layer

Responsibilities:

- filesystem access
- Docker / Compose command execution
- host probing
- HTTP probing
- persistence

Examples:

- Docker command adapter
- filesystem repository
- local JSON repository for MVP
- later database repository if needed

## Core Data Model

## HostProfile

Represents the shared configuration for one managed Docker host.

Suggested fields:

```text
id
label
adapterType
dockerBin
composeRoot
configRoot
mediaRoot
downloadsRoot
plexLogsRoot?
timezone
puid
pgid
baseUrl
initialized
confidence
createdAt
updatedAt
```

Notes:

- `confidence` should be per-field, not only global
- `adapterType` is the resolved host adapter such as `generic-docker`, `qnap`, or `synology`

## ServiceTemplate

Represents Keelarr's opinionated definition for one supported app.

Suggested fields:

```text
id
name
family
defaultImage
defaultPort
defaultMountStrategy
requiredPaths
defaultEnvironment
healthProbe
importMatchers
```

## ManagedService

Represents one Keelarr-managed service.

Suggested fields:

```text
id
templateId
name
containerName
image
port
enabled
stackDir
composePath
envPath
configPath
mediaPaths
downloadsPath?
appUrl
runtimeState
updateState
managedState
lastBackupAt?
createdAt
updatedAt
```

`managedState` should distinguish:

- `draft`
- `generated`
- `deployed`
- `adopted`
- `external`

## ExternalService

Represents observable but not fully managed services.

Suggested fields:

```text
id
name
kind
url
status
version?
managementMode = external
notes?
```

## StackPlan

Represents the generated plan before deployment.

Suggested fields:

```text
hostProfileId
services[]
warnings[]
artifacts[]
createdAt
```

## AdoptionPlan

Represents the preview of converting discovered Docker services into Keelarr-managed services.

Suggested fields:

```text
hostProfileId
discoveredServices[]
adoptionCandidates[]
globalInference
warnings[]
createdAt
```

## Host Adapter Interface

Host adapters should implement a stable capability interface.

Suggested interface shape:

```text
detect(): HostDetectionResult
validate(profile): HostValidationResult
scanExistingStacks(profile): ExistingStackScanResult
suggestPaths(profile): PathSuggestionResult
```

### Adapter Responsibilities

- detect likely defaults
- score confidence
- validate command availability
- gather platform-specific hints

### Adapter Non-Responsibilities

- generating Compose templates
- defining service templates
- controlling UI flow
- owning runtime Docker actions

## Import Scanner Design

Import scanning is a separate subsystem.

### Responsibilities

- inspect Docker containers
- inspect volumes
- inspect networks
- detect Compose projects where possible
- match discovered containers against supported templates
- infer shared defaults

### Inputs

- Docker inspect data
- Docker volume inspect data
- Docker network inspect data
- filesystem scans for stack folders if enabled

### Outputs

- discovered services
- inferred host defaults
- issue list
- adoption candidates

### Matching Strategy

Match services by:

1. image
2. container name pattern
3. known ports
4. known mount destinations

This should not depend on vendor GUIs.

## Compose Generation Pipeline

Compose generation should be deterministic and readable.

### Inputs

- HostProfile
- selected ServiceTemplates
- optional per-service overrides

### Outputs

- `compose.yml`
- `.env`
- optional `.env.example`

### Rules

- generated files must be stable between runs when inputs do not change
- generated files must be understandable by humans
- secrets must not be written to version-controlled artifacts unless explicitly intended

### Generation Steps

1. resolve service template defaults
2. apply host-level defaults
3. apply per-service overrides
4. validate paths and ports
5. render Compose document
6. write artifacts

## Runtime Operations Layer

This layer owns Docker and Compose commands.

### Responsibilities

- compose status
- deploy
- pull
- upgrade
- inspect backup
- later rollback

### Design Rules

- commands should return structured results
- stdout/stderr should be preserved
- timeouts should be enforced
- operations should be logged

### Important Future Improvement

The current MVP uses command-output heuristics for update detection. A stronger design will need:

- clearer image-state comparison
- explicit version snapshots
- rollback metadata

## Health Probing

Health should not rely on one mechanism.

### Sources

- Docker runtime state
- Docker healthcheck status if available
- HTTP probe status
- optional app-specific heuristics later

### Health Model

Suggested normalized states:

- `healthy`
- `degraded`
- `starting`
- `unreachable`
- `stopped`
- `unknown`

## Persistence Strategy

### Current MVP

- local JSON files

This is acceptable while the project is proving behavior.

### Expected Next Step

Stay file-based for longer than instinct suggests.

Suggested persisted artifacts:

- `host-profile.json`
- `managed-services.json`
- `activity-log.json`
- `update-state.json`
- `adoption-plans/*.json`
- `backups/*`

Only move to SQLite or another embedded DB when:

- concurrency becomes meaningful
- query complexity grows
- rollback/import history becomes hard to manage with structured files

## Backups And Rollback Metadata

Every risky operation should create a backup record.

### Minimum Backup Contents

- previous Compose file
- previous `.env`
- `docker inspect`
- operation timestamp
- service ID

### Future Rollback Artifact

Eventually each upgrade or adoption should produce a rollback package containing:

- previous image reference
- previous stack artifact
- previous runtime metadata

## API Design Direction

The current API is action-oriented and acceptable for MVP progression.

Expected resource groups:

- `/api/state`
- `/api/host-profile`
- `/api/services`
- `/api/import`
- `/api/adoption`
- `/api/activity`
- `/api/updates`

### API Principles

- responses must be structured and machine-readable
- action outcomes must include per-service detail
- partial failures must be explicit

## UI Architecture Direction

The current static frontend is fine for proving flows.

Future UI organization should separate:

- state queries
- host setup flows
- install flows
- import flows
- dashboard cards
- activity and diagnostics

Suggested future structure:

```text
ui/
  components/
  features/
    onboarding/
    dashboard/
    import/
    updates/
  api/
  state/
```

This does not require a framework migration immediately, but it should guide how complexity is contained.

## Security Model

Security is not complete in the MVP and must become explicit before recommending public exposure.

### Required Future Controls

- local auth for the controller
- CSRF-safe mutation actions
- secrets handling rules
- optional role separation later

## Logging Model

There should be three categories of logs:

### Activity Log

User-facing summary of actions.

### Operation Log

Structured internal execution records.

### Debug Log

Verbose command and probe context for troubleshooting.

## Testing Strategy

The current tests only cover small utility paths. The product needs layered tests.

### Unit Tests

- host profile normalization
- service template expansion
- compose rendering
- issue detection rules

### Integration Tests

- generated stack artifact correctness
- import matching against sample inspect payloads
- update result parsing

### Fixture-Based Tests

This product will benefit heavily from fixtures:

- QNAP container inspect examples
- Synology-like layouts
- generic Linux host profiles
- bad path mapping examples

## Planned Refactor Path From MVP

### Step 1

Split route handlers into application services.

### Step 2

Introduce host adapter abstractions.

### Step 3

Introduce import scanner and adoption planner.

### Step 4

Move service template logic into a clearer catalog/module structure.

### Step 5

Strengthen backup and rollback metadata.

## Definition Of A Healthy Architecture

The architecture is healthy when:

- vendor-specific logic is isolated to adapters
- service-specific logic is isolated to templates and domain rules
- risky operations are coordinated through explicit application services
- Compose remains the managed artifact
- adding a new supported app does not require rewriting runtime logic

