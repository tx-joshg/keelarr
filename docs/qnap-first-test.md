# Stackarr First QNAP Test

This guide is for the first live Stackarr test against an existing QNAP Container Station setup.

The priority is safety:

- do not stop existing containers yet
- do not delete config directories
- do not delete Docker volumes
- use the running containers as the source of truth

## Goal Of The First Test

Prove that Stackarr can:

1. run as its own controller container
2. detect the QNAP host profile correctly
3. scan existing supported containers without writing changes
4. generate managed drafts that preserve the current container settings

The first test is successful even if no live container is recreated yet.

## Before You Start

Confirm these host paths match your QNAP:

```text
/share/Container/docker
/share/Container
/share/Media
/share/Media/Downloads
/share/Container/plex/Logs
```

Expected supported apps in the current MVP:

- Prowlarr
- Radarr
- Sonarr
- Lidarr
- Readarr
- Bazarr
- Trailarr
- Ombi
- Tautulli
- SABnzbd

## Deploy Stackarr

From the checked-out repo:

```bash
cd deploy
cp .env.example .env
docker compose -f compose.example.yml up -d --build
```

Then open:

```text
http://<qnap-ip>:4687
```

## First Validation Pass

In `Settings`:

1. Run `Detect Host`
2. Confirm the Docker binary path
3. Confirm stack root, config root, media root, downloads root, and Plex logs path
4. Save without deploy first

If validation fails, stop there and fix the reported Docker or path issue before continuing.

## Read-Only Import Pass

In `Adoption`:

1. Run `Scan Docker`
2. Confirm Stackarr recognizes the expected containers
3. Open the preview for one app at a time

The preview should preserve:

- current image tag
- current restart policy
- current bind mounts and named volumes
- current port mappings
- host networking or external Docker network settings
- current entrypoint and command

The generated `.env` file is local-only and may contain secret values copied from the existing container environment. Do not commit that file.

## Recommended First Adoption Candidate

Start with `trailarr`.

Reasons:

- simple bind mounts
- explicit port mapping
- already validated media path
- lower blast radius than Plex-adjacent or custom-network services

## What To Review Before Any Cutover

For the generated draft in `/share/Container/docker/<app>/`:

- `compose.yml`
- `.env`
- `.env.example`

Check that:

- `/config` still points to the current persistent source
- `/Media` still points to the current media source
- image matches the running container
- ports match the running container
- restart policy matches the running container
- custom network settings are preserved if the current container uses them

## Not Part Of The First Test

Do not do these in the first pass unless you have manually reviewed the draft:

- stop the live container
- recreate the live container under Stackarr control
- upgrade images
- run bulk actions

## Success Criteria

The first live test is good enough when all of the following are true:

- Stackarr stays up on the QNAP
- host detection succeeds
- read-only scan finds the existing supported apps
- at least one adoption preview looks accurate
- at least one managed draft is generated without touching the live container
