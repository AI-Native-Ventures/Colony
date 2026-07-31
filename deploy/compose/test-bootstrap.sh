#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_SCRIPT="${SCRIPT_DIR}/bootstrap.sh"
TEST_TMP_DIR="$(mktemp -d)"
OWNER_PUBKEY="$(printf 'a%.0s' {1..64})"
UPPERCASE_OWNER_PUBKEY="$(printf 'B%.0s' {1..64})"
REJECTION_COUNT=0

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

generated_env="${TEST_TMP_DIR}/owned.env"
success_output="$(
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

default_image_env="${TEST_TMP_DIR}/default-image.env"
"${BOOTSTRAP_SCRIPT}" \
  --domain company.example \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --output "${default_image_env}" >/dev/null
assert_env_value "${default_image_env}" BUZZ_IMAGE "ghcr.io/block/buzz:main"
assert_env_value "${default_image_env}" RELAY_OWNER_PUBKEY "${OWNER_PUBKEY}"

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

echo "compose bootstrap contract passed"
