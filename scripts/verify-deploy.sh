#!/usr/bin/env bash
# verify-deploy.sh — QA harness for vibinpsybin.band
#
# Fetches every HTML page, verifies every referenced asset, and sanity-checks
# the Bandsintown-powered shows section. Zero npm dependencies; only bash +
# curl + standard *nix text tools.
#
# Usage:
#   scripts/verify-deploy.sh [BASE_URL]
#
# Exits 0 on all-green, 1 on any failure.

set -u
# Do NOT set -e: we intentionally keep going after failures so the final
# report shows every problem, not just the first one.

BASE_URL="${1:-https://vibinpsybin.band}"
BASE_URL="${BASE_URL%/}"  # strip trailing slash

PAGES=(/ /music /shows /videos /contact /producer)

# ---------- colors ----------
if [[ -t 1 ]]; then
  C_GREEN=$'\e[32m'; C_RED=$'\e[31m'; C_YEL=$'\e[33m'; C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
else
  C_GREEN=''; C_RED=''; C_YEL=''; C_DIM=''; C_BOLD=''; C_RESET=''
fi

pass_count=0
fail_count=0
warn_count=0
FAILURES=()
WARNINGS=()

pass() { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; pass_count=$((pass_count+1)); }
fail() { printf "  %s✗%s %s\n" "$C_RED"   "$C_RESET" "$1"; fail_count=$((fail_count+1)); FAILURES+=("$1"); }
warn() { printf "  %s!%s %s\n" "$C_YEL"   "$C_RESET" "$1"; warn_count=$((warn_count+1)); WARNINGS+=("$1"); }
info() { printf "%s%s%s\n" "$C_BOLD" "$1" "$C_RESET"; }
dim()  { printf "%s%s%s\n" "$C_DIM"  "$1" "$C_RESET"; }

# ---------- tmp workspace ----------
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t vpsb-verify)"
trap 'rm -rf "$TMP"' EXIT

# ---------- helpers ----------

# Fetch a URL, following redirects; writes body to $1, echoes final status.
fetch_follow() {
  local out="$1" url="$2"
  curl -sL --max-time 20 -o "$out" -w "%{http_code}" "$url" 2>/dev/null || echo "000"
}

# HEAD-ish probe: we use GET with -I then -sL fallback because some CDNs
# (Cloudflare) lie on HEAD. We follow redirects and report the FINAL status.
probe_url() {
  local url="$1"
  # First try HEAD, follow redirects
  local code
  code="$(curl -sLI --max-time 15 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo 000)"
  # If HEAD was blocked, retry with a ranged GET so we don't download full assets
  if [[ "$code" == "405" || "$code" == "403" || "$code" == "000" ]]; then
    code="$(curl -sL --max-time 15 -H 'Range: bytes=0-0' -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo 000)"
    # 206 is the expected success for a Range request; treat as 200
    [[ "$code" == "206" ]] && code="200"
  fi
  echo "$code"
}

# Resolve a possibly-relative URL against BASE_URL. Protocol-relative //host
# gets https:. Anchor-only (#...) and data:/javascript: get rejected (empty).
resolve_url() {
  local u="$1"
  # Decode HTML entities commonly seen in Astro-rendered markup
  u="${u//&#38;/&}"
  u="${u//&amp;/&}"
  case "$u" in
    ''|'#'*|'javascript:'*|'data:'*|'mailto:'*|'tel:'*) echo ""; return ;;
    http://*|https://*) echo "$u" ;;
    //*)   echo "https:$u" ;;
    /*)    echo "$BASE_URL$u" ;;
    *)     echo "$BASE_URL/$u" ;;
  esac
}

# Extract attribute values from HTML. Handles single/double/unquoted.
# Usage: extract_attr <attr> <file>
extract_attr() {
  local attr="$1" file="$2"
  # Double-quoted
  grep -oE "${attr}=\"[^\"]*\"" "$file" | sed -E "s/${attr}=\"([^\"]*)\"/\1/"
  # Single-quoted
  grep -oE "${attr}='[^']*'" "$file" | sed -E "s/${attr}='([^']*)'/\1/"
}

# Expand a srcset value into individual URLs (strip the " 1x"/"720w" descriptor).
expand_srcset() {
  # Split on commas, then take the first whitespace-separated token of each.
  tr ',' '\n' <<<"$1" | awk '{print $1}' | sed '/^$/d'
}

# ---------- banner ----------
echo
info "═══ VPSB Deploy Verify ═══"
echo "Base URL: $BASE_URL"
echo "Pages:    ${PAGES[*]}"
echo

# ---------- phase 1: fetch all pages ----------
# We use two parallel indexed arrays (OK_PAGES + OK_FILES) instead of an
# associative array so this works on default macOS bash 3.2.
info "▸ Phase 1: Fetch HTML pages"
OK_PAGES=()
OK_FILES=()
page_file_of() {
  # echo the local file for a given page path, or empty
  local target="$1" i
  for i in "${!OK_PAGES[@]}"; do
    if [[ "${OK_PAGES[$i]}" == "$target" ]]; then
      echo "${OK_FILES[$i]}"
      return
    fi
  done
}
for p in "${PAGES[@]}"; do
  url="$BASE_URL$p"
  safe=$(echo "$p" | sed 's|/|_|g; s|^_||; s|^$|root|')
  [[ -z "$safe" ]] && safe=root
  file="$TMP/page-$safe.html"
  code=$(fetch_follow "$file" "$url")
  if [[ "$code" == "200" ]]; then
    pass "GET $p → 200"
    OK_PAGES+=("$p")
    OK_FILES+=("$file")
  else
    fail "GET $p → $code"
  fi
done
echo

# ---------- phase 2: collect asset URLs ----------
info "▸ Phase 2: Extract src/srcset/href from HTML"
ASSET_LIST="$TMP/assets.txt"
CSS_LIST="$TMP/css.txt"
INT_LINKS="$TMP/internal-links.txt"
: > "$ASSET_LIST"; : > "$CSS_LIST"; : > "$INT_LINKS"

for p in "${OK_PAGES[@]}"; do
  file="$(page_file_of "$p")"
  [[ -z "$file" ]] && continue
  # src="..."
  while IFS= read -r u; do
    [[ -z "$u" ]] && continue
    resolved=$(resolve_url "$u")
    [[ -n "$resolved" ]] && echo "$resolved" >> "$ASSET_LIST"
  done < <(extract_attr "src" "$file")

  # srcset="...": expand into individual URLs
  while IFS= read -r ss; do
    [[ -z "$ss" ]] && continue
    # Decode entities before splitting
    ss="${ss//&#38;/&}"; ss="${ss//&amp;/&}"
    while IFS= read -r u; do
      [[ -z "$u" ]] && continue
      resolved=$(resolve_url "$u")
      [[ -n "$resolved" ]] && echo "$resolved" >> "$ASSET_LIST"
    done < <(expand_srcset "$ss")
  done < <(extract_attr "srcset" "$file")

  # <link ... href="..."> stylesheets
  while IFS= read -r linktag; do
    href=$(echo "$linktag" | grep -oE 'href="[^"]*"' | head -1 | sed -E 's/href="([^"]*)"/\1/')
    [[ -z "$href" ]] && continue
    resolved=$(resolve_url "$href")
    [[ -n "$resolved" ]] && echo "$resolved" >> "$CSS_LIST" && echo "$resolved" >> "$ASSET_LIST"
  done < <(grep -oE '<link [^>]*rel="stylesheet"[^>]*>' "$file")

  # <a href="/..."> internal navigation (skip anchors and external)
  while IFS= read -r h; do
    [[ -z "$h" ]] && continue
    # only truly internal paths starting with "/" and not "//"
    [[ "$h" == //* ]] && continue
    [[ "$h" != /* ]] && continue
    [[ "$h" == *"#"* ]] && h="${h%%#*}"
    [[ -z "$h" ]] && continue
    echo "$BASE_URL$h" >> "$INT_LINKS"
  done < <(extract_attr "href" "$file" | grep -E '^/[^/]?')
done

# Dedupe
sort -u "$ASSET_LIST" -o "$ASSET_LIST"
sort -u "$CSS_LIST"   -o "$CSS_LIST"
sort -u "$INT_LINKS"  -o "$INT_LINKS"

asset_total=$(wc -l < "$ASSET_LIST" | tr -d ' ')
css_total=$(wc -l < "$CSS_LIST" | tr -d ' ')
link_total=$(wc -l < "$INT_LINKS" | tr -d ' ')
echo "  Assets extracted:         $asset_total"
echo "  CSS stylesheets:          $css_total"
echo "  Internal <a href> links:  $link_total"
echo

# ---------- phase 3: probe every asset ----------
info "▸ Phase 3: HEAD every asset (src / srcset / stylesheets)"
BROKEN_ASSETS=()
while IFS= read -r u; do
  [[ -z "$u" ]] && continue
  code=$(probe_url "$u")
  if [[ "$code" == "200" ]]; then
    :  # silent on pass; too noisy otherwise
  else
    fail "asset $code  $u"
    BROKEN_ASSETS+=("$u")
  fi
done < "$ASSET_LIST"
[[ ${#BROKEN_ASSETS[@]} -eq 0 ]] && pass "All $asset_total assets returned 200"
echo

# ---------- phase 4: probe internal links ----------
info "▸ Phase 4: HEAD every internal <a href>"
BROKEN_LINKS=()
while IFS= read -r u; do
  [[ -z "$u" ]] && continue
  code=$(probe_url "$u")
  if [[ "$code" == "200" ]]; then
    :
  else
    fail "link  $code  $u"
    BROKEN_LINKS+=("$u")
  fi
done < "$INT_LINKS"
[[ ${#BROKEN_LINKS[@]} -eq 0 ]] && pass "All $link_total internal links returned 200"
echo

# ---------- phase 5: css files (redundant but explicit per spec) ----------
info "▸ Phase 5: Verify CSS stylesheets load"
if [[ "$css_total" -eq 0 ]]; then
  warn "No <link rel=\"stylesheet\"> tags found — site may be styled inline only"
else
  bad_css=0
  while IFS= read -r u; do
    [[ -z "$u" ]] && continue
    code=$(probe_url "$u")
    if [[ "$code" != "200" ]]; then
      fail "css   $code  $u"
      bad_css=$((bad_css+1))
    fi
  done < "$CSS_LIST"
  [[ "$bad_css" -eq 0 ]] && pass "All $css_total CSS files returned 200"
fi
echo

# ---------- phase 6: shows section sanity ----------
info "▸ Phase 6: Shows section (Bandsintown-populated)"

# Helper: evaluate the shows HTML on a page.
#  - If we see an <li class="show"> / venue entry → shows rendered (PASS)
#  - Else if we see the documented empty-state phrase → empty state (PASS w/ note)
#  - Else if there's an "Upcoming" section but no children → FAIL
#  - Else (no shows UI at all) → WARN
check_shows() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    fail "$label: page missing from fetch set"
    return
  fi

  # 1) Real show entries
  if grep -qE 'class="show[ "]' "$file" \
     || grep -qE 'class="[^"]*\bvenue\b' "$file" \
     || grep -qE 'class="[^"]*\bday-num\b' "$file"; then
    pass "$label: rendered at least one show entry"
    return
  fi

  # 2) Known empty-state copy (from src/pages/shows.astro)
  if grep -qiE '(no upcoming shows|pulled live from.*bandsintown|follow there to get notified)' "$file"; then
    pass "$label: shows section present, showing documented empty-state"
    return
  fi

  # 3) Section exists but has no children → suspect
  if grep -qiE '>Upcoming<' "$file" || grep -qiE 'class="[^"]*\bshows\b' "$file"; then
    fail "$label: shows section exists but neither entries nor empty-state copy found — broken render"
    return
  fi

  # 4) No shows UI on this page at all
  warn "$label: no shows section detected (may be by design)"
}

# Home page
home_file="$(page_file_of /)"
if [[ -n "$home_file" ]]; then
  check_shows "/ (home)" "$home_file"
fi
# Shows page
shows_file="$(page_file_of /shows)"
if [[ -n "$shows_file" ]]; then
  check_shows "/shows"   "$shows_file"
fi
echo

# ---------- summary ----------
info "═══ Summary ═══"
echo "  ${C_GREEN}Pass:${C_RESET}     $pass_count"
echo "  ${C_RED}Fail:${C_RESET}     $fail_count"
echo "  ${C_YEL}Warn:${C_RESET}     $warn_count"
echo "  Assets:   $asset_total checked, ${#BROKEN_ASSETS[@]} broken"
echo "  Links:    $link_total checked, ${#BROKEN_LINKS[@]} broken"
echo

if [[ $fail_count -gt 0 ]]; then
  echo "${C_RED}${C_BOLD}FAIL${C_RESET} — $fail_count failure(s):"
  for f in "${FAILURES[@]}"; do
    echo "  • $f"
  done
  exit 1
else
  echo "${C_GREEN}${C_BOLD}PASS${C_RESET} — all checks green against $BASE_URL"
  [[ $warn_count -gt 0 ]] && { echo; echo "  (with $warn_count warning(s) — non-fatal)"; }
  exit 0
fi
