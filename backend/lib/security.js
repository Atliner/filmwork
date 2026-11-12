'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { AppError } = require('./errors');

function requireSecret(name, minimumLength = 32) {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must be configured and contain at least ${minimumLength} characters`);
  }
  return value;
}

function hmacHex(value, secretName = 'AUTH_CODE_PEPPER') {
  return crypto.createHmac('sha256', requireSecret(secretName)).update(String(value)).digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length || !/^[a-f\d]+$/i.test(left) || !/^[a-f\d]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function generateLoginCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encryptionKey() {
  const configured = requireSecret('PHONE_ENCRYPTION_KEY');
  // Accept a 64-character hex key; otherwise derive a stable 32-byte key.
  if (/^[a-f\d]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  return crypto.createHash('sha256').update(configured).digest();
}

function encryptPhone(phone) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(phone), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptPhone(payload) {
  const [version, ivPart, tagPart, encryptedPart] = String(payload).split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !encryptedPart) {
    throw new Error('Unsupported encrypted phone payload');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
      kind: 'user',
    },
    requireSecret('JWT_SECRET'),
    {
      algorithm: 'HS256',
      expiresIn: process.env.JWT_TTL || '7d',
      issuer: 'filmwork-api',
      audience: 'filmwork-web',
      jwtid: crypto.randomUUID(),
    },
  );
}

function signAdminToken(ownerTelegramId, csrfToken) {
  return jwt.sign(
    {
      sub: String(ownerTelegramId),
      role: 'admin',
      kind: 'admin',
      csrf: csrfToken,
    },
    requireSecret('JWT_SECRET'),
    {
      algorithm: 'HS256',
      expiresIn: process.env.ADMIN_SESSION_TTL || '2h',
      issuer: 'filmwork-api',
      audience: 'filmwork-admin',
      jwtid: crypto.randomUUID(),
    },
  );
}

function verifyToken(token, audience = 'filmwork-web') {
  try {
    return jwt.verify(token, requireSecret('JWT_SECRET'), {
      algorithms: ['HS256'],
      issuer: 'filmwork-api',
      audience,
    });
  } catch (error) {
    throw new AppError(401, 'INVALID_SESSION', 'نشست شما نامعتبر یا منقضی شده است.');
  }
}

function hashIp(ip) {
  if (!ip) return null;
  return hmacHex(ip, 'AUTH_CODE_PEPPER');
}

module.exports = {
  requireSecret,
  hmacHex,
  timingSafeHexEqual,
  generateLoginCode,
  generateOpaqueToken,
  encryptPhone,
  decryptPhone,
  signUserToken,
  signAdminToken,
  verifyToken,
  hashIp,
};
