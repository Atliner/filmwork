'use strict';

const { query } = require('../config/db');
const { AppError } = require('../lib/errors');
const { verifyToken } = require('../lib/security');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function hydrateUser(payload) {
  if (payload.kind !== 'user' || !/^\d+$/.test(String(payload.sub))) {
    throw new AppError(401, 'INVALID_SESSION', 'نشست کاربری نامعتبر است.');
  }
  const rows = await query(
    `SELECT id, tg_user_id, tg_chat_id, account_name, tg_username, role, status, created_at
       FROM users WHERE id = :id LIMIT 1`,
    { id: payload.sub },
  );
  const user = rows[0];
  if (!user || user.status !== 'active') {
    throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'حساب کاربری در دسترس نیست.');
  }
  return user;
}

async function requireUser(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'برای ادامه وارد حساب شوید.');
    req.user = await hydrateUser(verifyToken(token));
    next();
  } catch (error) {
    next(error);
  }
}

async function optionalUser(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (token) req.user = await hydrateUser(verifyToken(token));
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(role) {
  return function roleMiddleware(req, _res, next) {
    if (!req.user) return next(new AppError(401, 'AUTH_REQUIRED', 'برای ادامه وارد حساب شوید.'));
    // Every signed-in Filmwork account has both the regular-user and advertiser
    // capabilities. `role` is retained for legacy display/filtering only.
    if (role !== 'advertiser' && req.user.role !== role) {
      return next(new AppError(403, 'ROLE_REQUIRED', 'دسترسی لازم برای این بخش را ندارید.'));
    }
    next();
  };
}

function demoEnabled() {
  return process.env.DEMO_DATA === '1' && process.env.NODE_ENV !== 'production';
}

function ownerIds() {
  return new Set(
    String(process.env.ADMIN_OWNER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function requireAdmin(req, _res, next) {
  try {
    const token = req.cookies?.filmwork_admin;
    if (!token) throw new AppError(404, 'NOT_FOUND', 'صفحه پیدا نشد.');
    const payload = verifyToken(token, 'filmwork-admin');
    // In demo mode the console is opened through /owner-console/demo-login, which
    // signs a token even when ADMIN_OWNER_IDS is unset; accept exactly that token.
    const demoOwner = demoEnabled() && String(payload.sub) === 'demo';
    const knownOwner = ownerIds().has(String(payload.sub)) || demoOwner;
    if (payload.kind !== 'admin' || payload.role !== 'admin' || !knownOwner) {
      throw new AppError(404, 'NOT_FOUND', 'صفحه پیدا نشد.');
    }
    req.admin = payload;
    next();
  } catch (error) {
    // Deliberately conceal the owner console from non-owners.
    if (error instanceof AppError) return next(new AppError(404, 'NOT_FOUND', 'صفحه پیدا نشد.'));
    next(error);
  }
}

function requireAdminCsrf(req, _res, next) {
  const supplied = req.get('x-csrf-token');
  if (!req.admin?.csrf || !supplied || supplied !== req.admin.csrf) {
    return next(new AppError(403, 'CSRF_REJECTED', 'درخواست امنیتی نامعتبر است.'));
  }
  next();
}

module.exports = {
  bearerToken,
  requireUser,
  optionalUser,
  requireRole,
  requireAdmin,
  requireAdminCsrf,
  ownerIds,
};
