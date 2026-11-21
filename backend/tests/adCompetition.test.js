'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAd, normalizeBid } = require('../services/adCompetition');
test('all non-bot placements accept a bounded bid and bot uses a fixed factor', () => {
  assert.equal(normalizeBid(2.25, 'text_home', 5), 2.25);
  assert.equal(normalizeBid(undefined, 'pre_roll', 5), 1);
  assert.equal(normalizeBid(4, 'link_file_button', 5), 1);
  for (const bid of [0, 5.01, 'no', 1.001]) assert.throws(() => normalizeBid(bid, 'banner_home', 5), (e) => e.code === 'INVALID_BID');
});
test('weighted lottery includes every campaign with probability proportional to bid', () => {
  const a = {bid_multiplier:'1.00'}, b = {bid_multiplier:'2.00'}, c = {bid_multiplier:'1.00'};
  assert.equal(chooseAd([a,b,c], () => 0.24), a);
  assert.equal(chooseAd([a,b,c], () => 0.25), b);
  assert.equal(chooseAd([a,b,c], () => 0.749), b);
  assert.equal(chooseAd([a,b,c], () => 0.75), c);
  assert.equal(chooseAd([], () => 0), null);
});
