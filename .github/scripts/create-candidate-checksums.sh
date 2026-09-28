#!/usr/bin/env bash
set -euo pipefail

# Run from the candidate artifact root. Preserve spaces with NUL-delimited names
# and emit paths relative to that root, as required by the native verifier.
find . -type f ! -path './SHA256SUMS' -printf '%P\0' \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum > SHA256SUMS
