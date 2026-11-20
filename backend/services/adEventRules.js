'use strict';

/** Pure transition rule, called while the ad row is locked in a transaction.
 * A signed session can have at most one impression, click and terminal outcome.
 * This is deduplication, not proof that a human saw the ad. */
function eventDecision(eventType, existingTypes) {
  const events = new Set(existingTypes);
  if (events.has(eventType)) return 'duplicate';
  if ((eventType === 'skip' || eventType === 'complete') && (events.has('skip') || events.has('complete'))) return 'conflict';
  return 'accept';
}
function shouldChargeImpression(eventType, accepted, campaign) {
  return eventType === 'impression' && accepted && campaign.status === 'active' && Number(campaign.owner_campaign || 0) === 0;
}
module.exports = { eventDecision, shouldChargeImpression };
