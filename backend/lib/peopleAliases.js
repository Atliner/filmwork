'use strict';

// Explicit pairs act as an archive-wide alias dictionary. Flat legacy lists never
// imply a relationship: a curator can pair the names on any published work.
const key = (value) => String(value || '').trim().toLocaleLowerCase();
const split = (value) => String(value || '').split(/\s*\|\s*/u).map((v) => v.trim()).filter(Boolean);
function entries(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function createAliasIndex(rows) {
  const candidates = new Map();
  for (const row of rows) {
    for (const entry of [...entries(row.directors), ...entries(row.cast ?? row.cast_members)]) {
      const names = split(entry);
      if (names.length !== 2 || key(names[0]) === key(names[1])) continue;
      const a = key(names[0]), b = key(names[1]);
      for (const [from, to, display] of [[a, b, names], [b, a, names]]) {
        if (!candidates.has(from)) candidates.set(from, new Map());
        candidates.get(from).set(to, display);
      }
    }
  }
  const index = new Map();
  for (const [name, options] of candidates) {
    if (options.size !== 1) continue;
    const [other, pair] = options.entries().next().value;
    const reverse = candidates.get(other);
    if (reverse?.size === 1 && reverse.has(name)) {
      // Stable RTL label, regardless of how an administrator typed the pair.
      const ordered = [...pair].sort((a, b) => Number(/[A-Za-z]/.test(a)) - Number(/[A-Za-z]/.test(b)));
      index.set(name, ordered);
    }
  }
  return index;
}
function expandAliases(names, index) {
  const expanded = new Map();
  for (const name of names) for (const alias of index.get(key(name)) || [name]) expanded.set(key(alias), alias);
  return [...expanded.values()];
}
function displayCredits(values, index) {
  const seen = new Set(), result = [];
  for (const entry of entries(values)) {
    const parts = split(entry);
    if (!parts.length) continue;
    const pair = parts.length === 1 ? index.get(key(parts[0])) : null;
    const names = pair || parts;
    const fingerprint = names.map(key).sort().join('|');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(names.join(' | '));
  }
  return result;
}
module.exports = { createAliasIndex, expandAliases, displayCredits };
