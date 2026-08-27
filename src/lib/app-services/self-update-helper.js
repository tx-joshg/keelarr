/**
 * The script the updater container runs.
 *
 * It executes in a container that outlives Keelarr, because the process issuing
 * a recreate is the one being recreated: `compose up -d` from inside dies
 * between the remove and the create, and can leave nothing running at all.
 *
 * Every value it needs arrives as an environment variable rather than being
 * interpolated in here, so a deploy path containing a quote cannot rewrite what
 * runs. It writes plain text to a log and reports its verdict as an exit code —
 * generating JSON from shell would be a bug farm, and the controller derives the
 * real outcome from the running container anyway.
 *
 * Exit codes:
 *   0  the new version came up and acknowledged the update
 *   10 rolled back, and the previous version acknowledged
 *   11 rolled back, but nothing acknowledged
 *   1  could not recreate at all
 */
export const HELPER_SCRIPT = `set -u

log() {
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$SU_LOG" 2>/dev/null
  echo "$*"
}

compose_up() {
  # shellcheck disable=SC2086
  docker compose -p "$SU_PROJECT" $SU_FILE_ARGS --env-file "$SU_ENV_FILE" \\
    --project-directory "$SU_PROJECT_DIR" up -d "$SU_SERVICE"
}

image_now() {
  docker inspect --format '{{.Image}}' "$SU_CONTAINER" 2>/dev/null || echo none
}

# Docker health only proves the HTTP port is open, and Keelarr listens before it
# finishes starting. The new controller writes this file after it has reconciled
# the update, so waiting for it is waiting for the answer rather than the port.
wait_ack() {
  i=0
  while [ "$i" -lt "$SU_HEALTH_TIMEOUT" ]; do
    [ -f "$1" ] && return 0
    state=$(docker inspect --format '{{.State.Status}}' "$SU_CONTAINER" 2>/dev/null || echo missing)
    case "$state" in
      exited|dead) return 1 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Long enough for the controller to finish answering this request and for the
# handoff to be flushed to disk before anything is stopped.
sleep "\${SU_SETTLE:-5}"
log "recreating $SU_CONTAINER on $SU_TARGET_IMAGE_ID"

if ! compose_up; then
  log "compose up failed on the target version"
  cp -f "$SU_ENV_BACKUP" "$SU_ENV_FILE" 2>/dev/null || log "could not restore the env file"
  KEELARR_VERSION="$SU_ROLLBACK_VERSION" compose_up || { log "rollback failed to start"; exit 1; }
  wait_ack "$SU_ACK_ROLLBACK" && { log "rolled back and acknowledged"; exit 10; }
  log "rolled back, no acknowledgement"
  exit 11
fi

# up -d compares resolved image ids, so a moved tag does recreate. A missed
# recreate here would be silent and fatal, so it is checked rather than assumed.
if [ "$(image_now)" != "$SU_TARGET_IMAGE_ID" ]; then
  log "still on the old image; forcing a recreate"
  # shellcheck disable=SC2086
  docker compose -p "$SU_PROJECT" $SU_FILE_ARGS --env-file "$SU_ENV_FILE" \\
    --project-directory "$SU_PROJECT_DIR" up -d --force-recreate "$SU_SERVICE" || log "forced recreate failed"
fi

if wait_ack "$SU_ACK_TARGET"; then
  log "acknowledged on the target version"
  exit 0
fi

log "no acknowledgement on the target version; rolling back"
# The original bytes, not a rewritten pin: leaving KEELARR_VERSION on an
# internal rollback tag would be carried across every future settings save.
cp -f "$SU_ENV_BACKUP" "$SU_ENV_FILE" 2>/dev/null || log "could not restore the env file"
KEELARR_VERSION="$SU_ROLLBACK_VERSION" compose_up || { log "rollback failed to start"; exit 1; }

if wait_ack "$SU_ACK_ROLLBACK"; then
  log "rolled back and acknowledged"
  exit 10
fi

log "rolled back, no acknowledgement"
exit 11
`;
