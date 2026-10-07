'use strict';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAILS = 20;

function normalizeEmailList(value, field, errors, { partial = false, maxEmails = MAX_EMAILS } = {}) {
  if (value === undefined && partial) return undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxEmails) {
    errors[field] = `Must be an array of at most ${maxEmails} email addresses`;
    return [];
  }

  const normalized = [];
  for (const [index, email] of value.entries()) {
    if (typeof email !== 'string' || email.length > 254 || !EMAIL_PATTERN.test(email.trim())) {
      errors[`${field}.${index}`] = 'Must be a valid email address';
      continue;
    }
    const address = email.trim().toLowerCase();
    if (!normalized.includes(address)) normalized.push(address);
  }
  return normalized;
}

function mergeEmailLists(lists, field, errors) {
  const combined = [];
  for (const list of lists) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      errors[field] = 'Must be an array of email addresses';
      continue;
    }
    combined.push(...list);
  }
  return normalizeEmailList(combined, field, errors, { maxEmails: MAX_EMAILS * 2 });
}

module.exports = { normalizeEmailList, mergeEmailLists, EMAIL_PATTERN, MAX_EMAILS };
