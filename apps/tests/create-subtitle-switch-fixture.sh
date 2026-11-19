#!/usr/bin/env bash
# Synthetic, solid-black video with six independent subtitle streams. The first
# is long and the second is short so rendered pixels can be distinguished.
# Usage: ./create-subtitle-switch-fixture.sh path/to/output.mkv
set -euo pipefail
output=${1:?output path required}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for n in 1 2 3 4 5 6; do
  case "$n" in
    1) text='WWWWWWWWWWWWWWWWWWWW';;
    2) text='I';;
    *) text="SUBTITLE TRACK $n";;
  esac
  for sec in $(seq 0 27); do
    printf '%s\n00:00:%02d,000 --> 00:00:%02d,900\n%s\n\n' "$((sec + 1))" "$sec" "$sec" "$text"
  done > "$tmp/$n.srt"
done
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i 'color=c=black:s=320x180:r=8:d=28' \
  -i "$tmp/1.srt" -i "$tmp/2.srt" -i "$tmp/3.srt" -i "$tmp/4.srt" -i "$tmp/5.srt" -i "$tmp/6.srt" \
  -map 0:v -map 1:s -map 2:s -map 3:s -map 4:s -map 5:s -map 6:s \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:s srt \
  -metadata:s:s:0 title='Long subtitle' -metadata:s:s:1 title='Short subtitle' \
  -disposition:s:0 default -disposition:s:1 0 -disposition:s:2 0 -disposition:s:3 0 -disposition:s:4 0 -disposition:s:5 0 \
  "$output"
