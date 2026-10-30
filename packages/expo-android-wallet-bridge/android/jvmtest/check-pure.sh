#!/bin/sh
# Fails if any file on the pure-JVM include list (build.gradle `pureFiles`) imports android.* or androidx.*.
# Run before every Kotlin JVM test run.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
LIST=$(sed -n "/ext.pureFiles = \[/,/\]/p" "$DIR/build.gradle" | grep -o "'[^']*\.kt'" | tr -d "'")
[ -n "$LIST" ] || { echo "check-pure: empty include list" >&2; exit 1; }
bad=0
for f in $LIST; do
  p="$DIR/../src/main/kotlin/$f"
  [ -f "$p" ] || { echo "check-pure: missing $f" >&2; bad=1; continue; }
  if grep -nE '^\s*import\s+(android|androidx)\.' "$p"; then
    echo "check-pure: $f imports android.*/androidx.*" >&2
    bad=1
  fi
done
[ $bad -eq 0 ] && echo "check-pure: ok ($(echo "$LIST" | wc -l | tr -d ' ') files)"
exit $bad
