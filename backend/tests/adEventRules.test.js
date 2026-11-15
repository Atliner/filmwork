'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventDecision, shouldChargeImpression } = require('../services/adEventRules');

test('session events are idempotent and mutually exclusive at the terminal state', () => {
  assert.equal(eventDecision('impression', []), 'accept');
  assert.equal(eventDecision('impression', ['impression']), 'duplicate');
  assert.equal(eventDecision('click', ['impression']), 'accept');
  assert.equal(eventDecision('complete', ['impression', 'click']), 'accept');
  assert.equal(eventDecision('skip', ['impression', 'complete']), 'conflict');
  assert.equal(eventDecision('complete', ['impression', 'skip']), 'conflict');
  assert.equal(eventDecision('skip', ['impression', 'skip']), 'duplicate');
  assert.equal(eventDecision('click', ['impression', 'complete']), 'accept');
});


test('owner campaigns and duplicate impressions are never charged', () => {
  const paid = { status: 'active', owner_campaign: 0 };
  assert.equal(shouldChargeImpression('impression', true, paid), true);
  assert.equal(shouldChargeImpression('impression', false, paid), false);
  assert.equal(shouldChargeImpression('click', true, paid), false);
  assert.equal(shouldChargeImpression('impression', true, { status: 'active', owner_campaign: 1 }), false);
  assert.equal(shouldChargeImpression('impression', true, { status: 'paused', owner_campaign: 0 }), false);
});
