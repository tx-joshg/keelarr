# Stackarr QNAP Validation And Migration Runbook

This document is the current source of truth for the live QNAP test environment.

It records what has already been proven, what is still manual, and the safest order for the remaining migrations.

## Safety Rules

- migrate one container at a time
- do not delete config directories
- do not delete named or unnamed volumes unless their purpose is confirmed
- use the running container as the source of truth
- create an inspect backup before every cutover
- leave rollback artifacts in place until the replacement container is validated

## Current Validated State

As of August 5, 2026:

- Stackarr is running on the QNAP as its own controller container
- host detection succeeds with the `qnap` adapter
- the validated controller-side Docker binary is `docker`
- the validated host paths are:

```text
/share/Container/docker
/share/Container
/share/Media
/share/Media/Downloads
/share/Container/plex/Logs
```

- adoption scan detects the live supported services already on the NAS
- managed draft generation is working for imported containers
- `trailarr` has been cut over successfully to Compose management

Trailarr now runs from:

```text
/share/Container/docker/trailarr/compose.yml
```

Trailarr validation after cutover:

- container name: `trailarr`
- image: `nandyalu/trailarr:latest`
- runtime: Compose-managed
- health: healthy
- port: `0.0.0.0:7889->7889/tcp`
- media mount: `/share/Media -> /Media`
- config mount: `/share/Container/trailarr/config -> /config`

The dashboard now shows Trailarr as:

- `Generated`
- `Running`
- `Healthy`
- `Managed`

Rollback artifacts were preserved for that cutover:

- inspect and compose backup under `/share/Container/docker/trailarr/cutover-backup-*`
- older exited container object left in place intentionally for reference

## What This Means Right Now

Stackarr has proven the following on a live QNAP:

1. detect and validate the host profile
2. scan existing supported containers safely
3. generate managed drafts that preserve the live container shape
4. detect Compose-managed runtime correctly after cutover
5. reflect that managed state back into the dashboard

What Stackarr does not do yet:

- execute the full cutover from one UI click
- provide in-app rollback automation
- finish update/version reporting for every imported service

## Current Service Inventory

Services already present on the live NAS that matter for the Stackarr MVP:

- `trailarr`: migrated and validated
- `ombi`: live, not yet managed
- `tautulli`: live, not yet managed
- `radarr`: live, not yet managed
- `sonarr`: live, not yet managed
- `sabnzbd`: live, not yet managed

Services currently selected in the catalog but not running in the live stack:

- `prowlarr`
- `bazarr`

Services intentionally outside the current Stackarr migration scope:

- `plex`
- `cloudflare-ddns*`

## Recommended Next Migration Order

Use this order for the remaining live cutovers:

1. `ombi`
2. `tautulli`
3. `radarr`
4. `sonarr`
5. `sabnzbd`

Reasoning:

- `ombi` is the simplest remaining bind-mounted app with low blast radius
- `tautulli` is still simple, but it adds the read-only Plex logs mount
- `radarr` and `sonarr` use host networking and named-volume-backed `/config`, so they need more careful validation
- `sabnzbd` is last because it uses a custom QNAP network with a fixed LAN IP, which is the highest-risk migration in the current group

## Standard Cutover Workflow

Apply this process to each remaining service.

### 1. Confirm The Draft

Review:

- `/share/Container/docker/<app>/compose.yml`
- `/share/Container/docker/<app>/.env`
- `/share/Container/docker/<app>/.env.example`
- `/share/Container/docker/<app>/import-summary.json`
- `/share/Container/docker/<app>/IMPORT-REVIEW.md`

Confirm:

- persistent config source is correct
- image matches the live container
- ports match the live container
- restart policy matches the live container
- mounts match the live container
- network mode and custom networks match the live container
- entrypoint and command match the live container when present

### 2. Create Cutover Backup

Before stopping anything, create:

- `docker inspect` backup
- resolved Compose backup
- copy of the persistent config directory when practical

Do not delete the original config directory after the backup.

### 3. Recreate Under Compose

Preferred manual flow today:

1. stop the live container
2. rename it to a rollback name if possible
3. run `docker compose up -d` from the generated stack folder
4. confirm the replacement container is healthy before touching any old artifacts

### 4. Validate Immediately

Check all of the following before moving on:

- container is running
- healthcheck is healthy when one exists
- expected port or host-network URL responds
- `/config` contains the expected application database or config files
- media and downloads mounts are visible inside the container
- the dashboard changes from `Detected` or `Draft` to `Managed`

### 5. Leave Rollback State In Place

Do not clean up old container objects or backup folders until the replacement app has been used successfully.

## Product Gaps Found During The Live QNAP Test

These are the concrete issues discovered during the first live migration pass:

- required host fields were previously hidden under advanced UI
- save flow needed clearer confirmation
- keyboard tab order needed correction
- path browsing is not implemented yet
- one-service Compose projects on QNAP returned single-object JSON from `docker compose ps --format json`
- update/version status is still incomplete for imported services
- one-click UI cutover is not implemented yet

The Compose runtime parsing issue has already been fixed. The other items remain product work.

## Exit Criteria For The Next Stage

The next stage is successful when:

- Ombi and Tautulli are both managed successfully under Compose
- at least one host-network Arr service is migrated safely
- the dashboard shows accurate managed state across those migrated apps
- the manual runbook is stable enough to turn into a one-click in-app cutover flow
