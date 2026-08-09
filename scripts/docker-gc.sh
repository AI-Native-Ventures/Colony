#!/usr/bin/env bash
# =============================================================================
# docker-gc.sh — stop Colony Compose stacks whose worktree no longer exists.
#
# Every worktree that runs the isolated test harness starts its own Postgres,
# Redis, and MinIO under a Compose project named for its relay port (see
# scripts/harness-ports.sh). Deleting the worktree does not stop them, and
# nothing else ever does, so they accumulate: on 2026-08-09 four ghost stacks
# had been running for 29 to 35 hours against directories that no longer
# existed, holding ~730 MB of dead Postgres volumes and burning CPU.
#
# What this reclaims is small. Rust `target/` directories in the same worktrees
# run 12 to 28 GB each, so if the machine is actually short on disk, look there
# first. This exists so idle stacks stop piling up, not as a disk remedy.
#
#   just docker-gc          # dry run: print what would be removed
#   just docker-gc --yes    # actually remove it
#
# Safety rules, in order of application. A stack must fail ALL of them to be
# collected:
#
#   1. Its `com.docker.compose.project.working_dir` label still resolves to a
#      directory that exists  -> keep.
#   2. Any of its containers has a client connected to Postgres  -> keep. This
#      is the check that matters: the working_dir label records whoever created
#      the stack first, not who is using it now. Colony's main checkout runs
#      its relay against a stack labelled for a long-deleted worktree.
#   3. The project is on the never-collect list (see PROTECTED)  -> keep.
#
# Volumes are only removed for projects this script collected, and only ones
# named `<project>_*`. It never runs `docker volume prune`, because this machine
# also holds Supabase databases for other products whose volumes are dangling by
# design and do not reseed.
# =============================================================================
set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) APPLY=1 ;;
    --help | -h)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "docker-gc: unknown argument: $arg" >&2
      echo "usage: just docker-gc [--yes]" >&2
      exit 1
      ;;
  esac
done

# Projects never collected regardless of the checks above. `colony-dev` is the
# main checkout's own stack: its working_dir is the repo root, so rule 1 already
# protects it, but naming it here means a rename of the repo directory cannot
# turn a routine cleanup into a wiped dev database.
PROTECTED=("colony-dev")

if ! docker info >/dev/null 2>&1; then
  echo "docker-gc: Docker is not running; nothing to do."
  exit 0
fi

# --- collect the distinct Compose projects present ---------------------------
# macOS ships bash 3.2, which has no associative arrays, so this keeps a plain
# newline-separated list and looks a project's directory up on demand.
projects="$(docker ps -a --format '{{.Names}}' |
  xargs -r -n1 docker inspect -f \
    '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null |
  grep -v '^$' | sort -u || true)"

if [ -z "$projects" ]; then
  echo "docker-gc: no Compose projects found."
  exit 0
fi

# Every working_dir label in a project, deduped.
#
# Containers in one project can disagree: Colony's `buzz` project holds both a
# container created from a since-deleted worktree and one created from the main
# checkout. Reading only the first container's label makes the verdict depend on
# container ordering, so this reads all of them and the caller keeps the project
# if ANY of them still exists.
project_working_dirs() {
  docker ps -aq --filter "label=com.docker.compose.project=$1" |
    xargs -r -n1 docker inspect -f \
      '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null |
    grep -v '^$' | sort -u || true
}

# True when at least one of a project's working_dir labels still resolves.
project_dir_exists() {
  local dir
  while read -r dir; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] && return 0
  done <<EOF
$(project_working_dirs "$1")
EOF
  return 1
}

# --- does any container in this project have a live Postgres client? ---------
has_live_client() {
  local project="$1" container count
  while read -r container; do
    [ -n "$container" ] || continue
    count="$(docker exec "$container" psql -U buzz -d buzz -tAc \
      "select count(*) from pg_stat_activity
        where backend_type = 'client backend' and pid <> pg_backend_pid();" \
      2>/dev/null | tr -d '[:space:]' || true)"
    # Non-numeric means this container is not a Postgres we can query (redis,
    # minio, a stopped container). Not evidence of use either way; keep looking.
    case "$count" in
      '' | *[!0-9]*) continue ;;
    esac
    [ "$count" -gt 0 ] && return 0
  done < <(docker ps -q --filter "label=com.docker.compose.project=${project}" |
    xargs -r -n1 docker inspect -f '{{.Name}}' | sed 's|^/||')
  return 1
}

is_protected() {
  local candidate="$1" entry
  for entry in "${PROTECTED[@]}"; do
    [ "$candidate" = "$entry" ] && return 0
  done
  return 1
}

# --- decide ------------------------------------------------------------------
collect=""
collect_count=0

while read -r project; do
  [ -n "$project" ] || continue
  dir="$(project_working_dirs "$project" | head -1)"

  if is_protected "$project"; then
    printf 'keep    %-24s protected\n' "$project"
    continue
  fi
  if project_dir_exists "$project"; then
    printf 'keep    %-24s worktree exists\n' "$project"
    continue
  fi
  if has_live_client "$project"; then
    printf 'keep    %-24s live database client\n' "$project"
    continue
  fi

  printf 'collect %-24s worktree gone: %s\n' "$project" "${dir:-<unlabelled>}"
  collect="${collect}${project}
"
  collect_count=$((collect_count + 1))
done <<EOF
$projects
EOF

echo
if [ "$collect_count" -eq 0 ]; then
  echo "docker-gc: nothing to collect."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "docker-gc: ${collect_count} project(s) would be removed. Re-run with --yes to apply:"
  echo "  just docker-gc --yes"
  exit 0
fi

# --- apply -------------------------------------------------------------------
while read -r project; do
  [ -n "$project" ] || continue
  echo "removing ${project}"
  docker ps -aq --filter "label=com.docker.compose.project=${project}" |
    xargs -r docker rm -f >/dev/null
  # Only this project's own volumes, and only ones nothing else holds.
  docker volume ls -q --filter dangling=true |
    grep "^${project}_" |
    xargs -r docker volume rm >/dev/null || true
done <<EOF
$collect
EOF

echo
echo "docker-gc: removed ${collect_count} project(s)."
docker system df | head -5
