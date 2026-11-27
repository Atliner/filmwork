'use strict';
// Explicit maintenance command only. Stop the app and take a verified backup.
// Dry run by default; --execute archives financial facts before deleting ads.
const { query, closePool } = require('../config/db');
const { deleteCampaign } = require('../services/adAccounting');
async function main() {
  const execute = process.argv.slice(2).includes('--execute');
  const [counts] = await query("SELECT (SELECT COUNT(*) FROM ads WHERE deleted_at IS NOT NULL) AS ads, (SELECT COUNT(*) FROM admin_events WHERE kind IN ('content','media') AND content_asset_id IS NULL) AS activity, (SELECT COUNT(*) FROM admin_events WHERE kind='ad' AND ad_public_id IS NULL AND title LIKE 'کمپین %') AS ad_activity, (SELECT COUNT(*) FROM ads a WHERE a.deleted_at IS NOT NULL AND a.owner_campaign=FALSE AND a.budget>a.spent AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.reference=CONCAT('campaign-refund:',a.public_id))) AS unverified");
  console.log(`Legacy hidden campaigns: ${counts.ads}; unlinked content/media activity entries: ${counts.activity}; unlinked campaign activity: ${counts.ad_activity}; refunds requiring reconciliation: ${counts.unverified}.`);
  if (!execute) { console.log('Dry run: no data changed. Use --execute only after backup and while the app is stopped.'); return; }
  if (Number(counts.unverified)) throw new Error('Some deleted campaigns have unverified refunds. Reconcile the ledger before running; no data was changed.');
  let deleted = 0;
  while (true) {
    const rows = await query('SELECT public_id FROM ads WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 100');
    if (!rows.length) break;
    for (const row of rows) { await deleteCampaign(row.public_id, null, {includeDeleted:true}); deleted++; }
  }
  const result = await query("DELETE FROM admin_events WHERE kind IN ('content','media') AND content_asset_id IS NULL");
  const adsActivity = await query("DELETE FROM admin_events WHERE kind='ad' AND ad_public_id IS NULL AND title LIKE 'کمپین %'");
  console.log(`Permanently deleted ${deleted} legacy campaigns, ${result.affectedRows} unlinked content/media entries and ${adsActivity.affectedRows} unlinked campaign activity entries. Financial records retained.`);
}
main().catch((error) => { console.error('Maintenance failed; stop and investigate before retrying:', error.message); process.exitCode = 1; }).finally(closePool);
