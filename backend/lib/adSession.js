'use strict';
const { generateOpaqueToken, hmacHex, timingSafeHexEqual } = require('./security');
const { AppError, assert } = require('./errors');
function createAdSession(adPublicId, { purpose = 'web', ttlMs = 2 * 60 * 60_000, placement }  = {}) {
  const payload = Buffer.from(JSON.stringify({ ad: adPublicId, exp: Date.now() + ttlMs, nonce: generateOpaqueToken(12), purpose, ...(placement ? { placement } : {}) })).toString('base64url');
  return `${payload}.${hmacHex(payload)}`;
}
function verifyAdSession(session, expectedAdId, { allowExpired = false } = {}) {
  const [payload, signature, ...extra] = String(session || '').split('.');
  assert(payload && signature && extra.length === 0, 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  assert(timingSafeHexEqual(signature, hmacHex(payload)), 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new AppError(422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.'); }
  assert(claims.ad === expectedAdId && Number.isFinite(Number(claims.exp)) && (allowExpired || Number(claims.exp) > Date.now()), 422, 'EXPIRED_AD_SESSION', 'شناسه نمایش منقضی شده است.');
  return claims;
}
module.exports = { createAdSession, verifyAdSession };
