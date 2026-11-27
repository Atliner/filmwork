'use strict';

// Replace tokens in a single pass so a title or site name containing braces is
// never interpreted as another template expression.
function formatDownloadCaption(template, { siteName, title, version }) {
  const values = { site_name: String(siteName || 'سایت'), title: String(title || ''), version: String(version || '') };
  return String(template || '').replace(/\{(site_name|title|version)\}/g, (_match, key) => values[key]).slice(0, 900);
}
module.exports = { formatDownloadCaption };
