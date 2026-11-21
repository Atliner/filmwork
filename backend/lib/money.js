'use strict';
const { AppError } = require('./errors');
// Campaign deposits are expressed in rials to hundredths; arithmetic uses
// integer cents at validation boundaries and DECIMAL in SQL.
function moneyCents(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,13})(?:\.(\d{1,2}))?$/);
  if (!match) throw new AppError(422, 'INVALID_MONEY', 'بودجه باید عددی معتبر با حداکثر دو رقم اعشار باشد.');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
module.exports = { moneyCents };
