'use strict';

const { AppError } = require('./errors');

function asString(value, field, options = {}) {
  const { min = 0, max = 1000, trim = true, optional = false } = options;
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new AppError(422, 'VALIDATION_ERROR', `${field} الزامی است.`);
  }
  if (typeof value !== 'string') {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} باید متن باشد.`);
  }
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} باید بین ${min} و ${max} نویسه باشد.`);
  }
  return result;
}

function asEnum(value, field, values) {
  if (!values.includes(value)) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} نامعتبر است.`);
  }
  return value;
}

function asPositiveNumber(value, field, options = {}) {
  const number = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} باید عددی بین ${min} و ${max} باشد.`);
  }
  return number;
}

function asDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} تاریخ معتبر نیست.`);
  }
  return date;
}

function asHttpUrl(value, field, options = {}) {
  const raw = asString(value, field, { min: 8, max: 2048, optional: options.optional });
  if (raw === null) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} باید نشانی معتبر باشد.`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} فقط می‌تواند HTTP یا HTTPS باشد.`);
  }
  if (options.httpsOnly && parsed.protocol !== 'https:') {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} باید با HTTPS آغاز شود.`);
  }
  return parsed.toString();
}

function cleanPlainText(value, maxLength = 1200) {
  const text = asString(value, 'متن', { min: 1, max: maxLength });
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
}

function parsePage(query) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const limit = Math.max(1, Math.min(50, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = {
  asString,
  asEnum,
  asPositiveNumber,
  asDate,
  asHttpUrl,
  cleanPlainText,
  parsePage,
};
