'use strict';
// Every populated URL field counts once, including replicas; a linked legacy
// projection is not a second record. This is the panel's inventory, not a count
// of publicly playable or downloadable versions.
const BOT_URLS = ['tg_link_primary','tg_link_fallback_1','tg_link_fallback_2','tg_link_fallback_3',
  'subtitle_link_primary','subtitle_link_fallback_1','subtitle_link_fallback_2','subtitle_link_fallback_3',
  'audio_link_primary','audio_link_fallback_1','audio_link_fallback_2','audio_link_fallback_3',
  'stream_url','playback_subtitle_url','playback_audio_url'];
const MANUAL_URLS = ['stream_url','subtitle_url','dub_url','telegram_url'];
const MANUAL_DTO_URLS = ['streamUrl','subtitleUrl','dubUrl','telegramUrl'];
const present = value => String(value ?? '').trim() !== '';
function countInventory(media = [], manualVersions = []) {
  const manual = manualVersions.flatMap(version => version.links || []);
  return { versions:media.length + manual.length,
    links:media.reduce((n,row)=>n + BOT_URLS.filter(key => present(row[key])).length,0)
      + manual.reduce((n,row)=>n + MANUAL_DTO_URLS.filter(key => present(row[key])).length,0) };
}
function countUrlsSQL(alias, fields) {
  return fields.map(field=>`(CASE WHEN ${alias}.${field} IS NOT NULL AND TRIM(${alias}.${field}) <> '' THEN 1 ELSE 0 END)`).join(' + ');
}
module.exports = { BOT_URLS, MANUAL_URLS, countInventory, countUrlsSQL };
