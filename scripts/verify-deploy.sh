#!/usr/bin/env bash
# verify-deploy.sh — objective QA harness for vibinpsybin-site production.
#
# Usage:
#   scripts/verify-deploy.sh [BASE_URL]
#
# Exits 0 if the live site looks healthy:
#   - Home page returns 200
#   - Home HTML contains zero `_image?href=` dynamic URLs (those 404 on static deploys)
#   - Home HTML references at least one /_astro/ hashed asset
#   - A sample /_astro/ asset referenced in the HTML returns 200
#   - Key pages (/, /music, /shows, /videos, /contact, /producer) return 2xx/3xx
#
# Exits non-zero with a clear error message otherwise.

set -u
BASE_URL="${1:-https://vibinpsybin.band}"
BASE_URL="${BASE_URL%/}"
FAIL=0

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

fail() { red "FAIL: $*"; FAIL=1; }
pass() { green "PASS: $*"; }

echo "verify-deploy: checking ${BASE_URL}"

# 1. Home page fetch
BUST="$(date +%s)-$RANDOM"
home_html="$(curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "${BASE_URL}/?cb=${BUST}" 2>/dev/null || true)"
if [ -z "$home_html" ]; then
  fail "home page fetch returned empty/error"
else
  pass "home page fetched ($(printf '%s' "$home_html" | wc -c | tr -d ' ') bytes)"
fi

# 2. No dynamic image URLs
if printf '%s' "$home_html" | grep -q '_image?href='; then
  count=$(printf '%s' "$home_html" | grep -oE '_image\?href=' | wc -l | tr -d ' ')
  fail "home HTML contains ${count} legacy /_image?href=... URLs (these 404 on static deploys)"
else
  pass "home HTML has no legacy /_image?href= URLs"
fi

# 3. Has /_astro/ references
if printf '%s' "$home_html" | grep -q '/_astro/'; then
  pass "home HTML references /_astro/ hashed assets"
else
  fail "home HTML has no /_astro/ asset references"
fi

# 4. Sample asset resolvable
sample_asset="$(printf '%s' "$home_html" | grep -oE '/_astro/[A-Za-z0-9._@-]+\.(webp|png|jpg|jpeg|css|js|svg)' | head -n1 || true)"
if [ -n "$sample_asset" ]; then
  status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}${sample_asset}")
  if [ "$status" = "200" ]; then
    pass "sample asset ${sample_asset} -> 200"
  else
    fail "sample asset ${sample_asset} -> ${status}"
  fi
else
  yellow "WARN: could not extract a sample /_astro/ asset to probe"
fi

# 5. Key pages
for path in / /music /shows /videos /contact /producer; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}${path}?cb=${BUST}")
  case "$status" in
    2??|3??) pass "${path} -> ${status}" ;;
    *) fail "${path} -> ${status}" ;;
  esac
done

echo
if [ "$FAIL" -eq 0 ]; then
  green "verify-deploy: ALL CHECKS PASSED"
  exit 0
else
  red "verify-deploy: FAILED"
  exit 1
fi
