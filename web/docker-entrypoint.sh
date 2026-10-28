#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")
PLATFORM_BASE=$(printf '%s' "${PLATFORM_API_BASE:-}" | base64 | tr -d '\n')
PRODUCT_NAME=$(printf '%s' "${BRAND_NAME:-}" | base64 | tr -d '\n')
# 只接受 true，其余一律视为关闭。
ALLOW_BYOK_VALUE=$([ "${ALLOW_BYOK:-}" = "true" ] && echo true || echo false)
PROMPT_LIBRARY_VALUE=$([ "${PROMPT_LIBRARY:-}" = "true" ] && echo true || echo false)

cat > /usr/share/nginx/html/config.js <<EOF
(() => {
const decode = (value) => new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
window.__RUNTIME_CONFIG__ = {
  PLATFORM_API_BASE: decode("${PLATFORM_BASE}"),
  BRAND_NAME: decode("${PRODUCT_NAME}"),
  ALLOW_BYOK: "${ALLOW_BYOK_VALUE}",
  PROMPT_LIBRARY: "${PROMPT_LIBRARY_VALUE}",
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}"
};
})();
EOF
