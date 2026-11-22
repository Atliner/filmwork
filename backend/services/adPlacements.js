'use strict';
const { AppError, assert } = require('../lib/errors');
const { placementMeta } = require('./adSettings');

function parsePlacements(payload) {
  let values = payload.placements ?? payload.placement;
  if (typeof values === 'string' && values.trim().startsWith('[')) {
    try { values = JSON.parse(values); } catch { throw new AppError(422, 'INVALID_PLACEMENTS', 'فهرست جایگاه‌ها معتبر نیست.'); }
  }
  if (!Array.isArray(values)) values = values ? [values] : [];
  assert(values.length > 0 && values.length <= 14, 422, 'INVALID_PLACEMENTS', 'حداقل یک جایگاه انتخاب کنید.');
  const unique = [...new Set(values)];
  assert(unique.length === values.length && unique.every((v) => typeof v === 'string' && placementMeta(v)), 422, 'INVALID_PLACEMENTS', 'جایگاه انتخاب‌شده معتبر نیست.');
  const type = placementMeta(unique[0]).asset;
  assert(unique.every((v) => placementMeta(v).asset === type), 422, 'PLACEMENT_TYPE_MISMATCH', 'همهٔ جایگاه‌ها باید با نوع محتوای تبلیغ سازگار باشند.');
  return unique;
}
module.exports = { parsePlacements };
