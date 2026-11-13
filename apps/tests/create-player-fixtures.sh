#!/usr/bin/env bash
# Create short, synthetic videos for testing embedded audio and subtitle tracks.
# Usage: FFmpeg/FFprobe on PATH; ./create-player-fixtures.sh [output-directory]
set -euo pipefail

output=${1:-"$(mktemp -d "${TMPDIR:-/tmp}/vizosten-player-fixtures.XXXXXX")"}
mkdir -p "$output"
output=$(cd "$output" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/vizosten-player-inputs.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

command -v ffmpeg >/dev/null || { echo 'ffmpeg is required' >&2; exit 1; }
command -v ffprobe >/dev/null || { echo 'ffprobe is required' >&2; exit 1; }

cat > "$tmp/fa.srt" <<'SRT'
1
00:00:00,000 --> 00:00:03,500
زیرنویس فارسی آزمایشی
SRT
cat > "$tmp/en.srt" <<'SRT'
1
00:00:00,000 --> 00:00:03,500
English test subtitle
SRT

for ext in mkv mp4; do
  subtitles=srt
  [ "$ext" = mp4 ] && subtitles=mov_text
  ffmpeg -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i 'testsrc=size=320x180:rate=24:duration=4' \
    -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=4' \
    -f lavfi -i 'sine=frequency=880:sample_rate=48000:duration=4' \
    -f srt -i "$tmp/fa.srt" -f srt -i "$tmp/en.srt" \
    -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s \
    -c:v libx264 -pix_fmt yuv420p -c:a:0 libmp3lame -c:a:1 aac -c:s "$subtitles" \
    -metadata:s:a:0 language=fas -metadata:s:a:0 'title=Persian 440 Hz (MP3)' \
    -metadata:s:a:1 language=eng -metadata:s:a:1 'title=English 880 Hz (AAC)' \
    -metadata:s:s:0 language=fas -metadata:s:s:0 'title=Persian subtitles' \
    -metadata:s:s:1 language=eng -metadata:s:s:1 'title=English subtitles' \
    -disposition:a:0 default -disposition:a:1 0 \
    -disposition:s:0 0 -disposition:s:1 0 \
    "$output/multitrack.$ext"
  ffprobe -v error -show_entries stream=index,codec_type,codec_name:stream_tags=language,title \
    -of json "$output/multitrack.$ext" > "$output/multitrack.$ext.json"
done
printf 'Synthetic fixtures and track metadata written to: %s\n' "$output"
