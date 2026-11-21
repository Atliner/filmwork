'use strict';
const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
function normalizeBid(raw, placement, max) {
  if (placement === 'link_file_button') return 1;
  const bid = raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
  if (!Number.isFinite(bid) || bid < 1 || bid > max || Math.abs(bid * 100 - Math.round(bid * 100)) > 1e-8) throw new AppError(422, 'INVALID_BID', `ضریب پیشنهاد باید بین ۱ و ${max} باشد.`);
  return bid;
}
// Weighted lottery: a 2x bid has twice the selection weight of a 1x bid.
function chooseAd(rows, draw = () => crypto.randomInt(0, 1_000_000_000) / 1_000_000_000) {
  if (!rows.length) return null;
  const weights = rows.map((row) => Math.max(1, Math.min(20, Number(row.bid_multiplier) || 1)));
  const total = weights.reduce((sum, n) => sum + n, 0);
  let cursor = draw() * total;
  for (let i = 0; i < rows.length; i++) { cursor -= weights[i]; if (cursor < 0) return rows[i]; }
  return rows[rows.length - 1];
}
module.exports = { normalizeBid, chooseAd };
