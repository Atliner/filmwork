'use strict';

const { AppError } = require('./errors');
const { asString, asPositiveNumber } = require('./validation');

function listParam(value, label, maxLength = 120) {
  if (value === undefined || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 30) throw new AppError(422, 'VALIDATION_ERROR', `${label} بیش از حد است.`);
  return [...new Set(values.map((item) => asString(item, label, { min: 1, max: maxLength })))];
}
function parseCatalogFilters(q) {
  const number = (key, label, min, max) => q[key] === undefined || q[key] === '' ? null : asPositiveNumber(q[key], label, { min, max });
  const result = {
    yearFrom: number('yearFrom', 'سال شروع', 1888, 2200), yearTo: number('yearTo', 'سال پایان', 1888, 2200),
    minRating: number('minRating', 'حداقل امتیاز', 0, 10), maxRating: number('maxRating', 'حداکثر امتیاز', 0, 10),
    countries: listParam(q.country, 'کشور'), ages: listParam(q.age, 'رده سنی', 20), networks: listParam(q.network, 'شبکه'),
    aliases: listParam(q.person, 'نام عوامل'), role: q.role || '', audio: q.audio || '', running: q.running === '1',
  };
  if ((result.yearFrom !== null && result.yearTo !== null && result.yearFrom > result.yearTo) ||
      (result.minRating !== null && result.maxRating !== null && result.minRating > result.maxRating) ||
      (result.role && !['director', 'cast'].includes(result.role)) ||
      (result.audio && !['dub', 'sub', 'both'].includes(result.audio)) || result.aliases.length > 4 ||
      (q.running && !['0', '1'].includes(q.running))) {
    throw new AppError(422, 'VALIDATION_ERROR', 'فیلتر جستجو نامعتبر است.');
  }
  return result;
}
function catalogFacets(rows) {
  const genres = new Map(), countries = new Set(), ages = new Set(), networks = new Set();
  const years = [], ratings = [];
  for (const row of rows) {
    let gs = row.genres || [];
    if (!Array.isArray(gs)) { try { gs = JSON.parse(gs); } catch { gs = []; } }
    if (!Array.isArray(gs)) gs = [];
    for (const g of new Set(gs.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean))) genres.set(g, (genres.get(g) || 0) + 1);
    const cs = Array.isArray(row.countries) ? row.countries : String(row.country || '').split(/[,،]/u);
    cs.map((c) => String(c).trim()).filter(Boolean).forEach((c) => countries.add(c));
    const age = String(row.ageRating ?? row.age_rating ?? '').trim(); if (age) ages.add(age);
    const network = String(row.network || '').trim(); if (network) networks.add(network);
    const year = row.releaseYear ?? row.release_year, rating = row.imdbScore ?? row.imdb_score;
    if (year !== null && year !== undefined && Number.isFinite(Number(year))) years.push(Number(year));
    if (rating !== null && rating !== undefined && Number.isFinite(Number(rating))) ratings.push(Number(rating));
  }
  const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b, 'fa'));
  const range = (values) => values.length ? values.reduce((r, v) => ({ min: Math.min(r.min, v), max: Math.max(r.max, v) }), { min: Infinity, max: -Infinity }) : null;
  return { genres: [...genres].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fa')),
    countries: sorted(countries), ages: sorted(ages), networks: sorted(networks), years: range(years), ratings: range(ratings) };
}
module.exports = { parseCatalogFilters, catalogFacets };
