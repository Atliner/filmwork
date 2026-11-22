'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parsePlacements} = require('../services/adPlacements');
test('placements must be unique, supported and of one creative type', () => {
  assert.deepEqual(parsePlacements({placement:'pre_roll'}), ['pre_roll']);
  assert.deepEqual(parsePlacements({placements:'["text_home","text_search"]'}), ['text_home','text_search']);
  for (const placements of [[],['text_home','text_home'],['pre_roll','text_home'],['unknown']]) assert.throws(()=>parsePlacements({placements}));
});
