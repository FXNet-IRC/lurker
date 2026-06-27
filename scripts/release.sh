#!/usr/bin/env bash
#
# fxnet/lurker — build and push the production Docker image to the
# private registry at reg.xfnet.org/fxnet/lurker.
#
# This is the FXNet downstream fork of lurker. The image is built from the
# repo's own Dockerfile (Vue client + Node server) and tagged for our registry.
#
# Versioning model:
#   - Semver, tracked in the `VERSION` file at the repo root.
#   - Each run bumps the version (default: patch) so every push gets a
#     fresh, monotonically increasing tag.
#   - Three tags are pushed per build:
#       :v<X.Y.Z>      immutable release tag — what humans pin against
#       :latest        mutable convenience — what fresh installs pull
#       :sha-<short>   immutable build reference — what CI/rollbacks pin
#
# After a successful push, the script:
#   - Writes the new version into VERSION
#   - Creates a local git tag `vX.Y.Z` (not pushed automatically — you
#     review and `git push --tags` when ready)
#
# Before building, the script runs the full quality gate (typecheck, client
# typecheck, lint, format check, and the test suite) so a broken build never
# becomes a pushed image. Skip it with --skip-checks when you know better.
#
# The image is stamped with OCI provenance labels (version, git revision, build
# time, source) so `docker inspect` / the registry can tell exactly what's inside.
#
# Usage:
#   scripts/release.sh                  # check, build, push; bump patch (default)
#   scripts/release.sh --minor          # bump minor
#   scripts/release.sh --major          # bump major
#   scripts/release.sh --version 1.2.0  # explicit version
#   scripts/release.sh --no-bump        # rebuild current VERSION as-is
#   scripts/release.sh --dry-run        # check + build + tag but skip push
#   scripts/release.sh --no-latest      # skip the :latest tag
#   scripts/release.sh --skip-checks    # skip the typecheck/lint/test gate
#   scripts/release.sh --platform P     # build for a target arch (e.g. linux/amd64)
#   scripts/release.sh --help
#
# Pre-flight:
#   - Working tree should be clean; pass --force-dirty to override.
#   - The quality gate must pass; pass --skip-checks to bypass.
#   - You must be `docker login`'d to reg.xfnet.org.

set -euo pipefail

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
readonly REGISTRY="reg.xfnet.org"
readonly NAMESPACE="fxnet"
readonly REPOSITORY="lurker"
readonly IMAGE="${REGISTRY}/${NAMESPACE}/${REPOSITORY}"

# Resolve repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly VERSION_FILE="${REPO_ROOT}/VERSION"

# -----------------------------------------------------------------------------
# Output helpers — colorless if not a TTY so log files stay clean.
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
    readonly C_BLUE="\033[34m"
    readonly C_GREEN="\033[32m"
    readonly C_YELLOW="\033[33m"
    readonly C_RED="\033[31m"
    readonly C_DIM="\033[2m"
    readonly C_RESET="\033[0m"
else
    readonly C_BLUE="" C_GREEN="" C_YELLOW="" C_RED="" C_DIM="" C_RESET=""
fi

info()  { echo -e "${C_BLUE}==>${C_RESET} $*"; }
ok()    { echo -e "${C_GREEN}\xE2\x9C\x93${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}!${C_RESET} $*" >&2; }
fail()  { echo -e "${C_RED}\xE2\x9C\x97${C_RESET} $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
bump="patch"          # patch | minor | major | none | explicit
explicit_version=""
dry_run=0
tag_latest=1
force_dirty=0
skip_checks=0
platform=""           # empty = native build; else passed to docker build --platform

usage() {
    # Print the leading comment block as the help text. awk stops at the
    # first non-comment line so we don't dump the implementation.
    awk '
        /^#!/ { next }
        /^#/  { sub(/^# ?/, ""); print; next }
        { exit }
    ' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --patch)        bump="patch"; shift ;;
        --minor)        bump="minor"; shift ;;
        --major)        bump="major"; shift ;;
        --no-bump)      bump="none"; shift ;;
        --version)
            bump="explicit"
            explicit_version="${2:-}"
            if [[ -z "${explicit_version}" ]]; then
                fail "--version requires a value (e.g. --version 1.2.0)"
            fi
            shift 2
            ;;
        --dry-run)      dry_run=1; shift ;;
        --no-latest)    tag_latest=0; shift ;;
        --force-dirty)  force_dirty=1; shift ;;
        --skip-checks)  skip_checks=1; shift ;;
        --platform)
            platform="${2:-}"
            if [[ -z "${platform}" ]]; then
                fail "--platform requires a value (e.g. --platform linux/amd64)"
            fi
            shift 2
            ;;
        -h|--help)      usage 0 ;;
        *)              warn "Unknown argument: $1"; usage 1 ;;
    esac
done

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is not installed."
command -v git    >/dev/null 2>&1 || fail "git is not installed."
if [[ "${skip_checks}" -eq 0 ]]; then
    command -v npm >/dev/null 2>&1 || fail "npm is not installed (needed for the quality gate; use --skip-checks to bypass)."
fi

cd "${REPO_ROOT}"

if [[ ! -f "${VERSION_FILE}" ]]; then
    warn "No VERSION file at ${VERSION_FILE} — initialising to 0.1.0."
    echo "0.1.0" > "${VERSION_FILE}"
fi

# Working tree must be clean — a dirty tree means the image won't match
# the committed source, which silently undermines the immutable :sha-X
# tag's promise.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    if [[ "${force_dirty}" -eq 1 ]]; then
        warn "Working tree is dirty; proceeding because --force-dirty was set."
    else
        git status --short
        fail "Working tree is dirty. Commit/stash first, or pass --force-dirty."
    fi
fi

# -----------------------------------------------------------------------------
# Version computation
# -----------------------------------------------------------------------------
current_version="$(tr -d '[:space:]' < "${VERSION_FILE}")"

if [[ ! "${current_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "VERSION file contains an invalid semver: '${current_version}'"
fi

IFS='.' read -r cur_major cur_minor cur_patch <<<"${current_version}"

case "${bump}" in
    patch)    new_version="${cur_major}.${cur_minor}.$((cur_patch + 1))" ;;
    minor)    new_version="${cur_major}.$((cur_minor + 1)).0" ;;
    major)    new_version="$((cur_major + 1)).0.0" ;;
    none)     new_version="${current_version}" ;;
    explicit)
        if [[ ! "${explicit_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            fail "--version must be semver (got '${explicit_version}')"
        fi
        new_version="${explicit_version}"
        ;;
esac

git_sha="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"

info "Build plan"
echo -e "  ${C_DIM}registry  :${C_RESET} ${REGISTRY}"
echo -e "  ${C_DIM}image     :${C_RESET} ${IMAGE}"
echo -e "  ${C_DIM}from      :${C_RESET} v${current_version}"
echo -e "  ${C_DIM}to        :${C_RESET} v${new_version}"
echo -e "  ${C_DIM}git sha   :${C_RESET} ${git_sha}"
echo -e "  ${C_DIM}tags      :${C_RESET} v${new_version}, sha-${git_sha}$([[ "${tag_latest}" -eq 1 ]] && echo ", latest")"
echo -e "  ${C_DIM}platform  :${C_RESET} $([[ -n "${platform}" ]] && echo "${platform}" || echo "native")"
echo -e "  ${C_DIM}checks    :${C_RESET} $([[ "${skip_checks}" -eq 1 ]] && echo "skipped" || echo "yes")"
echo -e "  ${C_DIM}dry run   :${C_RESET} $([[ "${dry_run}" -eq 1 ]] && echo "yes" || echo "no")"
echo

# -----------------------------------------------------------------------------
# Tag list
# -----------------------------------------------------------------------------
declare -a tag_args=(
    --tag "${IMAGE}:v${new_version}"
    --tag "${IMAGE}:sha-${git_sha}"
)
if [[ "${tag_latest}" -eq 1 ]]; then
    tag_args+=(--tag "${IMAGE}:latest")
fi

# -----------------------------------------------------------------------------
# Quality gate
#
# The Dockerfile builds the client and runs the server straight from TS via tsx —
# it never typechecks or tests. So we gate here: typecheck (server + client),
# lint, format check (all via `npm run check`) and the full test suite. A failure
# aborts before we build or push, so a broken commit can't become a release.
# -----------------------------------------------------------------------------
if [[ "${skip_checks}" -eq 1 ]]; then
    warn "Skipping quality gate (--skip-checks)."
else
    info "Running quality gate (typecheck, lint, format, tests)..."
    npm run check
    npm test
    ok "Quality gate passed."
fi

# -----------------------------------------------------------------------------
# Build
#
# OCI provenance labels are baked in so `docker inspect <image>` and the registry
# UI report exactly which version/commit the image was built from, and when.
# -----------------------------------------------------------------------------
build_created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_sha_full="$(git rev-parse HEAD 2>/dev/null || echo 'nogit')"
git_remote="$(git config --get remote.origin.url 2>/dev/null || true)"

declare -a label_args=(
    --label "org.opencontainers.image.title=fxnet-lurker"
    --label "org.opencontainers.image.version=${new_version}"
    --label "org.opencontainers.image.revision=${git_sha_full}"
    --label "org.opencontainers.image.created=${build_created}"
)
[[ -n "${git_remote}" ]] && label_args+=(--label "org.opencontainers.image.source=${git_remote}")

declare -a platform_args=()
if [[ -n "${platform}" ]]; then
    platform_args+=(--platform "${platform}")
    info "Targeting platform: ${platform}"
fi

info "Building image..."
DOCKER_BUILDKIT=1 docker build \
    "${tag_args[@]}" \
    "${label_args[@]}" \
    "${platform_args[@]}" \
    --file Dockerfile \
    .
ok "Built ${IMAGE}:v${new_version}"

# -----------------------------------------------------------------------------
# Push (skipped in --dry-run)
# -----------------------------------------------------------------------------
if [[ "${dry_run}" -eq 1 ]]; then
    warn "Dry run — skipping push and VERSION/git-tag updates."
    info "Local image tags:"
    docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' \
        | grep "${IMAGE}" || true
    exit 0
fi

# Sanity check: are we logged in to the registry?
if ! docker info 2>/dev/null | grep -q "Username"; then
    if [[ ! -f "${HOME}/.docker/config.json" ]] \
       || ! grep -q "${REGISTRY}" "${HOME}/.docker/config.json" 2>/dev/null; then
        warn "No saved credentials for ${REGISTRY} found in ~/.docker/config.json."
        warn "If push fails, run: docker login ${REGISTRY}"
    fi
fi

info "Pushing tags to ${REGISTRY}..."
docker push "${IMAGE}:v${new_version}"
docker push "${IMAGE}:sha-${git_sha}"
if [[ "${tag_latest}" -eq 1 ]]; then
    docker push "${IMAGE}:latest"
fi
ok "Pushed ${IMAGE}:v${new_version} (+ ${IMAGE}:sha-${git_sha}$([[ "${tag_latest}" -eq 1 ]] && echo " + :latest"))"

# -----------------------------------------------------------------------------
# Bump VERSION + create matching git tag (local only)
# -----------------------------------------------------------------------------
if [[ "${new_version}" != "${current_version}" ]]; then
    echo "${new_version}" > "${VERSION_FILE}"
    ok "Wrote VERSION = ${new_version}"

    git_tag="v${new_version}"
    if git rev-parse "${git_tag}" >/dev/null 2>&1; then
        warn "Git tag ${git_tag} already exists locally — not re-tagging."
    else
        git tag -a "${git_tag}" -m "Release ${git_tag}"
        ok "Created local git tag ${git_tag}"
    fi

    echo
    info "Next steps:"
    echo "  git add VERSION"
    echo "  git commit -m 'Release ${git_tag}'"
    echo "  git push origin fxnet"
    echo "  git push origin ${git_tag}"
else
    info "Version unchanged — no VERSION bump or git tag created."
fi
