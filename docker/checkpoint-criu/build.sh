#!/bin/sh
set -eu
# CRIU v4.1 plus three exact upstream fixes. Keep the original source and patch
# identifiers with the binary so a runtime image can be audited and reproduced.
base=b6059ff193a9b0dff98e997134d662c3ccfd1600
fixes='189ad2c6fea42ae480b10ffe06a28adada10ebc6
4b73985955ecc01604d8ed1247605a5875042e4c
1c6c68d1fecd8378fdcf433de995de783b49e4fb'
git init /source
cd /source
git remote add origin https://github.com/checkpoint-restore/criu.git
git fetch --depth=1 origin "$base"
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$base"
for fix in $fixes; do
  # Include the parent: a depth-one commit otherwise appears to add the whole tree.
  git fetch --depth=2 origin "$fix"
  test "$(git rev-parse FETCH_HEAD)" = "$fix"
  git diff --binary FETCH_HEAD^ FETCH_HEAD | git apply
done
# A separate capability-cache directory never invalidates the vendor CRIU cache.
make -j4 NO_GNUTLS=1 RUNDIR=/run/ozc-criu SOURCE_DATE_EPOCH=1744819200 criu
kit=/runtime/opt/ozc-criu
mkdir -p "$kit/bin" "$kit/lib" /runtime/usr/local/sbin
cp criu/criu "$kit/bin/criu"
ldd criu/criu > "$kit/ldd.txt"
awk '{ for (i=1; i<=NF; i++) if ($i ~ /^\//) print $i }' "$kit/ldd.txt" \
  | sort -u | while IFS= read -r library; do cp -L "$library" "$kit/lib/"; done
case "$(uname -m)" in
  aarch64) loader=ld-linux-aarch64.so.1 ;;
  x86_64) loader=ld-linux-x86-64.so.2 ;;
  *) echo 'Unsupported native CRIU architecture' >&2; exit 1 ;;
esac
test -f "$kit/lib/$loader"
ln -s "lib/$loader" "$kit/loader"
cp /kit-criu /runtime/usr/local/sbin/criu
cp /kit-ozwell.conf "$kit/ozwell.conf"
chmod 0755 /runtime/usr/local/sbin/criu "$kit/bin/criu"
printf '%s\n' "$base" > "$kit/source-commit"
printf '%s\n' "$fixes" > "$kit/upstream-commits"
git diff --binary > "$kit/source.patch"
cp COPYING "$kit/COPYING"
printf '%s\n' "$(uname -m)" > "$kit/architecture"
cd /runtime
find opt usr -type f ! -name SHA256SUMS -exec sha256sum {} \; \
  | sort -k2 > "$kit/SHA256SUMS"
