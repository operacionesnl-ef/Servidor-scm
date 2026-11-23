'use strict';

function getId(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    if (value._id) return String(value._id);
    if (value.id && typeof value.id !== 'object') return String(value.id);
  }
  return String(value);
}

function getAgencyConsultants(agency) {
  const assignments = [
    { id: getId(agency?.consultantId), role: 'principal' },
    { id: getId(agency?.auxiliaryConsultantId), role: 'auxiliary' },
  ].filter(({ id }) => id);
  const seen = new Set();
  return assignments.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function getAgencyConsultantFilter(consultantId) {
  return {
    $or: [
      { consultantId },
      { auxiliaryConsultantId: consultantId },
    ],
  };
}

module.exports = { getAgencyConsultants, getAgencyConsultantFilter };
