'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parsePlacements} = require('../services/adPlacements');
test('placements must be unique, supported and of one creative type', () => {
  assert.deepEqual(parsePlacements({placement:'pre_roll'}), ['pre_roll']);
  assert.deepEqual(parsePlacements({placements:'["text_home","text_search"]'}), ['text_home','text_search']);
  for (const placements of [[],['text_home','text_home'],['pre_roll','text_home'],['unknown']]) assert.throws(()=>parsePlacements({placements}));
});

test('pause only accepts image and download offers separate video and image slots', () => {
  const {placementMeta, adPolicy, mergeSettings} = require('../services/adSettings');
  assert.equal(placementMeta('pause_overlay'), null);
  assert.equal(placementMeta('banner_pause').asset, 'image');
  assert.equal(placementMeta('video_download').asset, 'video');
  assert.equal(placementMeta('banner_download').asset, 'image');
  assert.throws(()=>parsePlacements({placement:'pause_overlay'}));
  assert.throws(()=>parsePlacements({placements:['banner_pause','video_download']}));
  assert.equal(adPolicy(mergeSettings()).maxPriorityMultiplier, 10);
  assert.equal(adPolicy(mergeSettings([{key:'ads.max_priority_multiplier',value:'4'}])).maxPriorityMultiplier, 4);
});
