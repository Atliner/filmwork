#!/usr/bin/env bash
set -uo pipefail
# Surface errors as check annotations so failures remain readable even if an
# external artifact/log CDN is unavailable to a developer.
log_file="${RUNNER_TEMP:-/tmp}/vizosten-release-test.log"
gradle --console=plain connectedReleaseAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.filmwork.app.NativeEntryTest >"$log_file" 2>&1
status=$?
cat "$log_file"
if [ "$status" -ne 0 ]; then
  python3 - "$log_file" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines()
interesting = [line.strip() for line in lines if re.search(r'FAILURE|What went wrong|^\*|error:|Exception|Caused by|FAILED|FAILURES|Tests run:|no matching tests|Could not|^> Task.*FAILED', line, re.I)]
for line in interesting[-25:]:
    line = re.sub(r'https?://\S+', '<url>', line)[:500].replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print('::error::' + line)
PY
  adb logcat -d -s AndroidRuntime:E TestRunner:I | grep -E 'FATAL EXCEPTION|Caused by:|Exception|JNI_ERR|UnsatisfiedLinkError|NoSuchMethodError|FAILURE|Process: com.filmwork' | tail -20 | while IFS= read -r line; do
    safe=$(printf '%s' "$line" | sed -E 's@https?://[^ ]+@<url>@g; s/%/%25/g')
    printf '::error::%s\n' "$safe"
  done
fi
exit "$status"
