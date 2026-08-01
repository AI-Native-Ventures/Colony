#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_TEMPLATE="${SCRIPT_DIR}/.env.example"
temporary_file=""
installed_file=""
replacement_file=""

cleanup() {
  if [[ -n "${temporary_file}" ]]; then
    rm -f -- "${temporary_file}"
  fi
  if [[ -n "${installed_file}" ]]; then
    rm -f -- "${installed_file}"
  fi
  if [[ -n "${replacement_file}" ]]; then
    rm -f -- "${replacement_file}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: deploy/compose/bootstrap.sh --domain <host> --owner-pubkey <64-hex> [options]

Required:
  --domain <host>          Lowercase public DNS hostname for the relay
  --owner-pubkey <64-hex>  Human owner's Nostr public key

Options:
  --image <reference>      Fully qualified registry/repository with an optional
                           tag or sha256 digest (default: .env.example value)
  --output <path>          Destination (default: deploy/compose/.env)
  -h, --help               Show this help

The human owner private key is never generated or stored by this script.
USAGE
}

error() {
  echo "error: $*" >&2
}

require_option_value() {
  local option="$1"
  local remaining="$2"
  local value="${3:-}"

  if ((remaining < 2)) || [[ -z "${value}" || "${value}" == --* ]]; then
    error "${option} requires a value"
    usage >&2
    exit 2
  fi
}

validate_domain() {
  local candidate="$1"
  local label
  local label_count=0
  local labels=()

  [[ -n "${candidate}" && ${#candidate} -le 253 ]] || return 1
  [[ "${candidate}" =~ ^[a-z0-9.-]+$ ]] || return 1
  [[ "${candidate}" != .* && "${candidate}" != *. && "${candidate}" != *..* ]] ||
    return 1
  [[ "${candidate}" != "localhost" && "${candidate}" != *.localhost ]] || return 1
  [[ "${candidate}" != "local" && "${candidate}" != *.local ]] || return 1
  [[ ! "${candidate}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1

  IFS='.' read -r -a labels <<<"${candidate}"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 ]] || return 1
    [[ "${label}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
    label_count=$((label_count + 1))
  done

  ((label_count >= 2))
}

validate_image() {
  local candidate="$1"
  local component
  local digest=""
  local last_segment
  local reference
  local registry
  local repository
  local repository_components=()
  local tag=""

  [[ -n "${candidate}" && ${#candidate} -le 512 ]] || return 1
  [[ "${candidate}" != *//* && "${candidate}" != *@*@* ]] || return 1

  reference="${candidate}"
  if [[ "${reference}" == *@* ]]; then
    digest="${reference##*@}"
    reference="${reference%@*}"
    [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  else
    last_segment="${reference##*/}"
    if [[ "${last_segment}" == *:* ]]; then
      tag="${last_segment##*:}"
      reference="${reference%:*}"
      [[ "${tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || return 1
    fi
  fi

  # Keep the supported grammar deliberately narrow: a public DNS registry,
  # lowercase repository components, no registry port, and either a tag or
  # sha256 digest (not both).
  [[ "${reference}" == */* && "${reference}" != *:* && "${reference}" != *@* ]] ||
    return 1
  registry="${reference%%/*}"
  repository="${reference#*/}"
  validate_domain "${registry}" || return 1
  [[ -n "${repository}" && "${repository}" != */ && "${repository}" != /* ]] ||
    return 1

  IFS='/' read -r -a repository_components <<<"${repository}"
  for component in "${repository_components[@]}"; do
    [[ "${component}" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] || return 1
  done

  ((${#repository_components[@]} >= 1))
}

generate_secret() {
  local secret

  if ! secret="$(openssl rand -hex 32)"; then
    error "openssl could not generate a secret"
    return 1
  fi
  if [[ ! "${secret}" =~ ^[0-9a-f]{64}$ ]]; then
    error "openssl returned a malformed secret"
    return 1
  fi
  printf '%s' "${secret}"
}

if ! command -v openssl >/dev/null 2>&1; then
  error "openssl is required"
  exit 1
fi

if [[ ! -f "${ENV_TEMPLATE}" ]]; then
  error "environment template not found: ${ENV_TEMPLATE}"
  exit 1
fi

default_image="$(
  awk -F= '
    $1 == "BUZZ_IMAGE" {
      sub(/^[^=]*=/, "")
      print
      count++
    }
    END {
      if (count != 1) {
        exit 1
      }
    }
  ' "${ENV_TEMPLATE}"
)"
domain=""
owner_pubkey=""
image="${default_image}"
output="${SCRIPT_DIR}/.env"
seen_domain=false
seen_owner_pubkey=false
seen_image=false
seen_output=false

while (($#)); do
  case "$1" in
    --domain)
      require_option_value "$1" "$#" "${2:-}"
      if [[ "${seen_domain}" == "true" ]]; then
        error "--domain may only be provided once"
        exit 2
      fi
      domain="$2"
      seen_domain=true
      shift 2
      ;;
    --owner-pubkey)
      require_option_value "$1" "$#" "${2:-}"
      if [[ "${seen_owner_pubkey}" == "true" ]]; then
        error "--owner-pubkey may only be provided once"
        exit 2
      fi
      owner_pubkey="$2"
      seen_owner_pubkey=true
      shift 2
      ;;
    --image)
      require_option_value "$1" "$#" "${2:-}"
      if [[ "${seen_image}" == "true" ]]; then
        error "--image may only be provided once"
        exit 2
      fi
      image="$2"
      seen_image=true
      shift 2
      ;;
    --output)
      require_option_value "$1" "$#" "${2:-}"
      if [[ "${seen_output}" == "true" ]]; then
        error "--output may only be provided once"
        exit 2
      fi
      output="$2"
      seen_output=true
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      error "unknown argument: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${domain}" ]]; then
  error "--domain is required"
  usage >&2
  exit 2
fi
if ! validate_domain "${domain}"; then
  error "domain must be an already-lowercase public DNS hostname without a scheme, port, path, wildcard, or trailing dot"
  exit 2
fi

if [[ -z "${owner_pubkey}" ]]; then
  error "--owner-pubkey is required"
  usage >&2
  exit 2
fi
if [[ ! "${owner_pubkey}" =~ ^[0-9A-Fa-f]{64}$ ]]; then
  error "owner public key must be exactly 64 hexadecimal characters"
  exit 2
fi
owner_pubkey="$(printf '%s' "${owner_pubkey}" | tr '[:upper:]' '[:lower:]')"

if ! validate_image "${image}"; then
  error "image must use registry/repository with lowercase path components and an optional tag or sha256 digest"
  exit 2
fi

if [[ -z "${output}" || "${output}" =~ [[:cntrl:]] ]]; then
  error "output must be a non-empty path without control characters"
  exit 2
fi
if [[ -e "${output}" || -L "${output}" ]]; then
  error "refusing to overwrite existing output: ${output}"
  exit 1
fi
if [[ ! -d "$(dirname "${output}")" ]]; then
  error "output directory does not exist: $(dirname "${output}")"
  exit 1
fi

umask 077
relay_key="$(generate_secret)"
hook_secret="$(generate_secret)"
postgres_password="$(generate_secret)"
redis_password="$(generate_secret)"
s3_access_key="$(generate_secret)"
s3_secret_key="$(generate_secret)"

temporary_file="$(mktemp "${output}.tmp.XXXXXX")"
replacement_file="$(mktemp "${output}.replacements.XXXXXX")"
chmod 600 "${replacement_file}"
{
  printf 'BUZZ_IMAGE=%s\n' "${image}"
  printf 'BUZZ_DOMAIN=%s\n' "${domain}"
  printf 'RELAY_URL=wss://%s\n' "${domain}"
  printf 'BUZZ_MEDIA_BASE_URL=https://%s/media\n' "${domain}"
  printf 'BUZZ_MEDIA_SERVER_DOMAIN=%s\n' "${domain}"
  printf 'BUZZ_CORS_ORIGINS=https://%s\n' "${domain}"
  printf 'RELAY_OWNER_PUBKEY=%s\n' "${owner_pubkey}"
  printf 'BUZZ_RELAY_PRIVATE_KEY=%s\n' "${relay_key}"
  printf 'BUZZ_GIT_HOOK_HMAC_SECRET=%s\n' "${hook_secret}"
  printf 'POSTGRES_PASSWORD=%s\n' "${postgres_password}"
  printf 'REDIS_PASSWORD=%s\n' "${redis_password}"
  printf 'BUZZ_S3_ACCESS_KEY=%s\n' "${s3_access_key}"
  printf 'BUZZ_S3_SECRET_KEY=%s\n' "${s3_secret_key}"
} >"${replacement_file}"

awk -v replacement_file="${replacement_file}" '
BEGIN {
  FS = "="
  while ((getline replacement_line < replacement_file) > 0) {
    separator = index(replacement_line, "=")
    replacement_key = substr(replacement_line, 1, separator - 1)
    replacements[replacement_key] = substr(replacement_line, separator + 1)
  }
  close(replacement_file)
}
$1 in replacements { print $1 "=" replacements[$1]; next }
/^#/ && index($0, "CHANGE_ME") {
  print "# Generated by bootstrap.sh; keep this file private and stable."; next
}
{ print }
' "${ENV_TEMPLATE}" >"${temporary_file}"

rm -f -- "${replacement_file}"
replacement_file=""

if grep -q "CHANGE_ME" "${temporary_file}"; then
  error "generated environment still contains CHANGE_ME placeholders"
  exit 1
fi

installed_file="${temporary_file}.ready"
install -m 600 "${temporary_file}" "${installed_file}"
if ! ln "${installed_file}" "${output}" 2>/dev/null; then
  error "refusing to overwrite existing output: ${output}"
  exit 1
fi

rm -f -- "${temporary_file}" "${installed_file}"
temporary_file=""
installed_file=""

echo "Generated ${output} with mode 600."
echo "The human owner private key is external to this deployment; back it up separately with its recovery material."
