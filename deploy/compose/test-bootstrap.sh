#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_SCRIPT="${SCRIPT_DIR}/bootstrap.sh"
TEST_TMP_DIR="$(mktemp -d)"
OWNER_PUBKEY="$(printf 'a%.0s' {1..64})"
UPPERCASE_OWNER_PUBKEY="$(printf 'B%.0s' {1..64})"
REJECTION_COUNT=0
REAL_AWK="$(command -v awk)"
AWK_WRAPPER_DIR="${TEST_TMP_DIR}/bin"
AWK_ARGV_LOG="${TEST_TMP_DIR}/awk-argv.log"
AWK_REPLACEMENT_MODE_LOG="${TEST_TMP_DIR}/awk-replacement-mode.log"

cleanup() {
  rm -rf -- "${TEST_TMP_DIR}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="${key}" '
    $1 == key {
      sub(/^[^=]*=/, "")
      print
    }
  ' "${file}"
}

file_mode() {
  stat -f "%Lp" "$1" 2>/dev/null || stat -c "%a" "$1"
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "${actual}" == "${expected}" ]] ||
    fail "${label}: expected '${expected}', got '${actual}'"
}

assert_env_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local count

  count="$(awk -F= -v key="${key}" '$1 == key { count++ } END { print count + 0 }' "${file}")"
  assert_equal "${count}" "1" "${key} occurrence count"
  assert_equal "$(env_value "${key}" "${file}")" "${expected}" "${key}"
}

assert_secret() {
  local key="$1"
  local file="$2"
  local value

  value="$(env_value "${key}" "${file}")"
  [[ "${value}" =~ ^[0-9a-f]{64}$ ]] ||
    fail "${key} must be 64 lowercase hex characters"
}

expect_rejected() {
  local output

  REJECTION_COUNT=$((REJECTION_COUNT + 1))
  output="${TEST_TMP_DIR}/rejected-${REJECTION_COUNT}.env"
  if "${BOOTSTRAP_SCRIPT}" "$@" --output "${output}" >/dev/null 2>&1; then
    fail "expected bootstrap rejection: $*"
  fi
  [[ ! -e "${output}" && ! -L "${output}" ]] ||
    fail "rejected bootstrap left output behind: ${output}"
}

[[ -x "${BOOTSTRAP_SCRIPT}" ]] ||
  fail "bootstrap script is missing or not executable: ${BOOTSTRAP_SCRIPT}"

mkdir -p "${AWK_WRAPPER_DIR}"
awk_wrapper="${AWK_WRAPPER_DIR}/awk"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' ': "${REAL_AWK:?}"'
  printf '%s\n' ': "${AWK_ARGV_LOG:?}"'
  printf '%s\n' 'printf "%s\n" "$@" >>"${AWK_ARGV_LOG}"'
  printf '%s\n' 'for argument in "$@"; do'
  printf '%s\n' '  case "${argument}" in'
  printf '%s\n' '    replacement_file=*)'
  printf '%s\n' '      replacement_file="${argument#replacement_file=}"'
  printf '%s\n' '      mode="$(stat -f "%Lp" "${replacement_file}" 2>/dev/null || stat -c "%a" "${replacement_file}")"'
  printf '%s\n' '      printf "%s\n" "${mode}" >>"${AWK_REPLACEMENT_MODE_LOG:?}"'
  printf '%s\n' '      ;;'
  printf '%s\n' '  esac'
  printf '%s\n' 'done'
  printf '%s\n' 'if [[ -n "${AWK_FAIL_ON_CALL:-}" ]]; then'
  printf '%s\n' '  call_count=0'
  printf '%s\n' '  if [[ -f "${AWK_CALL_COUNT_FILE:?}" ]]; then'
  printf '%s\n' '    call_count="$(cat "${AWK_CALL_COUNT_FILE}")"'
  printf '%s\n' '  fi'
  printf '%s\n' '  call_count=$((call_count + 1))'
  printf '%s\n' '  printf "%s\n" "${call_count}" >"${AWK_CALL_COUNT_FILE}"'
  printf '%s\n' '  if [[ "${call_count}" == "${AWK_FAIL_ON_CALL}" ]]; then'
  printf '%s\n' '    exit 86'
  printf '%s\n' '  fi'
  printf '%s\n' 'fi'
  printf '%s\n' 'exec "${REAL_AWK}" "$@"'
} >"${awk_wrapper}"
chmod 700 "${awk_wrapper}"

generated_env="${TEST_TMP_DIR}/owned.env"
success_output="$(
  REAL_AWK="${REAL_AWK}" \
    AWK_ARGV_LOG="${AWK_ARGV_LOG}" \
    AWK_REPLACEMENT_MODE_LOG="${AWK_REPLACEMENT_MODE_LOG}" \
    PATH="${AWK_WRAPPER_DIR}:${PATH}" \
    "${BOOTSTRAP_SCRIPT}" \
    --domain office.example.com \
    --owner-pubkey "${UPPERCASE_OWNER_PUBKEY}" \
    --image ghcr.io/horizon-labs/ai-native-office:v1 \
    --output "${generated_env}"
)"

[[ -f "${generated_env}" ]] || fail "bootstrap did not create the requested output"
assert_equal "$(file_mode "${generated_env}")" "600" "generated file mode"
assert_env_value "${generated_env}" BUZZ_IMAGE "ghcr.io/horizon-labs/ai-native-office:v1"
assert_env_value "${generated_env}" BUZZ_DOMAIN "office.example.com"
assert_env_value "${generated_env}" RELAY_URL "wss://office.example.com"
assert_env_value "${generated_env}" BUZZ_MEDIA_BASE_URL "https://office.example.com/media"
assert_env_value "${generated_env}" BUZZ_MEDIA_SERVER_DOMAIN "office.example.com"
assert_env_value "${generated_env}" BUZZ_CORS_ORIGINS "https://office.example.com"
assert_env_value "${generated_env}" RELAY_OWNER_PUBKEY "$(printf 'b%.0s' {1..64})"
assert_env_value "${generated_env}" BUZZ_REQUIRE_AUTH_TOKEN "true"
assert_env_value "${generated_env}" BUZZ_REQUIRE_RELAY_MEMBERSHIP "true"
assert_env_value "${generated_env}" BUZZ_ALLOW_NIP_OA_AUTH "true"
assert_env_value "${generated_env}" BUZZ_AUTO_MIGRATE "true"

if grep -q "CHANGE_ME" "${generated_env}"; then
  fail "generated environment still contains CHANGE_ME"
fi
if grep -Eq '^OWNER_PRIVATE_KEY=|^RELAY_OWNER_PRIVATE_KEY=' "${generated_env}"; then
  fail "generated environment must not contain the human owner private key"
fi
[[ "${success_output}" == *"human owner private key"* ]] ||
  fail "success output must remind the operator that the human owner private key is external"

secret_keys=(
  BUZZ_RELAY_PRIVATE_KEY
  BUZZ_GIT_HOOK_HMAC_SECRET
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  BUZZ_S3_ACCESS_KEY
  BUZZ_S3_SECRET_KEY
)
secret_values=()
for secret_key in "${secret_keys[@]}"; do
  assert_secret "${secret_key}" "${generated_env}"
  secret_values+=("$(env_value "${secret_key}" "${generated_env}")")
done
unique_secret_count="$(printf '%s\n' "${secret_values[@]}" | sort -u | awk 'END { print NR }')"
assert_equal "${unique_secret_count}" "${#secret_keys[@]}" "independent secret count"
for secret_value in "${secret_values[@]}"; do
  if grep -Fq -- "${secret_value}" "${AWK_ARGV_LOG}"; then
    fail "generated secret appeared in awk process arguments"
  fi
done
assert_equal "$(cat "${AWK_REPLACEMENT_MODE_LOG}")" "600" "replacement map mode"

if find "${TEST_TMP_DIR}" -maxdepth 1 -type f \
  \( -name 'owned.env.tmp.*' -o -name 'owned.env.replacements.*' -o -name 'owned.env.*.ready' \) \
  -print -quit | grep -q .; then
  fail "successful bootstrap left a temporary file behind"
fi

default_image_env="${TEST_TMP_DIR}/default-image.env"
"${BOOTSTRAP_SCRIPT}" \
  --domain company.example \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --output "${default_image_env}" >/dev/null
assert_env_value "${default_image_env}" BUZZ_IMAGE "ghcr.io/block/buzz:main"
assert_env_value "${default_image_env}" RELAY_OWNER_PUBKEY "${OWNER_PUBKEY}"

digest_env="${TEST_TMP_DIR}/digest-image.env"
digest_hex="$(printf 'c%.0s' {1..64})"
"${BOOTSTRAP_SCRIPT}" \
  --domain company.example \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --image "ghcr.io/horizon-labs/ai-native-office@sha256:${digest_hex}" \
  --output "${digest_env}" >/dev/null
assert_env_value "${digest_env}" BUZZ_IMAGE \
  "ghcr.io/horizon-labs/ai-native-office@sha256:${digest_hex}"

expect_rejected
expect_rejected --domain office.example.com
expect_rejected --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain
expect_rejected --owner-pubkey
expect_rejected --image
expect_rejected --output
expect_rejected --unknown value
expect_rejected --domain office.example.com --domain other.example.com --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" --image first --image second
expect_rejected --domain OFFICE.EXAMPLE.COM --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain https://office.example.com --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com/path --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com:443 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain 'office example.com' --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain $'office.example.com\nPOSTGRES_PASSWORD=attacker' --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain '*.example.com' --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain .office.example.com --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com. --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain localhost --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain app.localhost --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.local --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain 127.0.0.1 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain 127.20.30.40 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain 0.0.0.0 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain 192.0.2.1 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain ::1 --owner-pubkey "${OWNER_PUBKEY}"
expect_rejected --domain office.example.com --owner-pubkey abc123
expect_rejected --domain office.example.com --owner-pubkey "$(printf 'a%.0s' {1..63})"
expect_rejected --domain office.example.com --owner-pubkey "$(printf 'g%.0s' {1..64})"
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" --image ""
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image https://ghcr.io/horizon/app:v1
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image ghcr.io/horizon/app:
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image ghcr.io/horizon/app@
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image horizon/app:v1
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image ghcr.io/Horizon/app:v1
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image $'ghcr.io/horizon/app:v1\nPOSTGRES_PASSWORD=attacker'
expect_rejected --domain office.example.com --owner-pubkey "${OWNER_PUBKEY}" \
  --image 'ghcr.io/horizon/app:v1;touch-pwned'

existing_env="${TEST_TMP_DIR}/existing.env"
printf '%s\n' "keep-this-value" >"${existing_env}"
if "${BOOTSTRAP_SCRIPT}" \
  --domain office.example.com \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --output "${existing_env}" >/dev/null 2>&1; then
  fail "bootstrap overwrote an existing output file"
fi
assert_equal "$(cat "${existing_env}")" "keep-this-value" "existing output contents"

symlink_target="${TEST_TMP_DIR}/symlink-target"
symlink_output="${TEST_TMP_DIR}/symlink.env"
printf '%s\n' "keep-symlink-target" >"${symlink_target}"
ln -s "${symlink_target}" "${symlink_output}"
if "${BOOTSTRAP_SCRIPT}" \
  --domain office.example.com \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --output "${symlink_output}" >/dev/null 2>&1; then
  fail "bootstrap followed an existing output symlink"
fi
assert_equal "$(cat "${symlink_target}")" "keep-symlink-target" "symlink target contents"

failed_env="${TEST_TMP_DIR}/render-failure.env"
if REAL_AWK="${REAL_AWK}" \
  AWK_ARGV_LOG="${AWK_ARGV_LOG}" \
  AWK_REPLACEMENT_MODE_LOG="${AWK_REPLACEMENT_MODE_LOG}" \
  AWK_FAIL_ON_CALL=2 \
  AWK_CALL_COUNT_FILE="${TEST_TMP_DIR}/awk-call-count" \
  PATH="${AWK_WRAPPER_DIR}:${PATH}" \
  "${BOOTSTRAP_SCRIPT}" \
  --domain office.example.com \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --output "${failed_env}" >/dev/null 2>&1; then
  fail "bootstrap unexpectedly succeeded when rendering failed"
fi
[[ ! -e "${failed_env}" && ! -L "${failed_env}" ]] ||
  fail "failed rendering left an output file behind"
if find "${TEST_TMP_DIR}" -maxdepth 1 -type f \
  \( -name 'render-failure.env.tmp.*' -o -name 'render-failure.env.replacements.*' -o -name 'render-failure.env.*.ready' \) \
  -print -quit | grep -q .; then
  fail "failed rendering left a secret-bearing temporary file behind"
fi

echo "compose bootstrap contract passed"
