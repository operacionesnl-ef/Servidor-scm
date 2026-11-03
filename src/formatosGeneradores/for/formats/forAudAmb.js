'use strict';

const CATEGORIES = [
  {
    id: 'carpeta-ambiental',
    required: true,
    aspectIds: [
      'ca-generator-registration',
      'ca-hazwaste-ledgers',
      'ca-hazwaste-manifests',
      'ca-hazwaste-plan',
      'ca-hazwaste-vendor',
      'ca-hazwaste-vendor-permit',
      'ca-coa-federal',
      'ca-environmental-insurance',
      'ca-special-waste-registration',
      'ca-special-waste-ledgers',
      'ca-special-waste-manifests',
      'ca-special-waste-plan',
      'ca-special-waste-vendor-permit',
      'ca-coa-state',
      'ca-wastewater-discharge-registration',
      'ca-water-discharge-analysis',
      'ca-fixed-sources',
      'ca-emissions-analysis',
      'ca-operating-license-applicability',
      'ca-municipal-operating-guidelines',
      'ca-grate-maintenance-logs',
      'ca-land-use-license',
      'ca-environmental-impact-resolution',
      'ca-terms-compliance',
      'ca-environmental-license',
      'ca-input-list',
      'ca-water-consumption-receipts',
      'ca-electricity-receipts',
      'ca-training-records',
    ],
  },
  {
    id: 'taller',
    required: false,
    aspectIds: [
      'taller-hazwaste-containers',
      'taller-chemical-containers',
      'taller-special-waste-containers',
      'taller-oil-spills',
      'taller-waste-mixing',
      'taller-grate-maintenance',
    ],
  },
  {
    id: 'area-lavado',
    required: false,
    aspectIds: [
      'lavado-chemical-containers',
      'lavado-grate-maintenance',
      'lavado-special-waste-containers',
      'lavado-hazwaste-containers',
    ],
  },
  {
    id: 'almacen-temporal-residuos-peligrosos',
    required: true,
    aspectIds: [
      'arp-separated-location',
      'arp-risk-reduced-location',
      'arp-spill-containment',
      'arp-sloped-floors',
      'arp-equipment-aisles',
      'arp-fire-extinguishers',
      'arp-hazard-signage',
      'arp-spills',
      'arp-identified-containers',
      'arp-containment-dike',
      'arp-spill-kit',
      'arp-no-floor-drains',
      'arp-nonflammable-walls',
      'arp-ventilation',
      'arp-airflow-capacity',
      'arp-air-purification',
      'arp-explosion-proof-lighting',
      'arp-no-municipal-waste-mixing',
      'arp-lead-batteries-storage',
      'arp-container-condition',
      'arp-floor-material',
      'arp-capacity-limit',
      'arp-roof-and-rain-protection',
    ],
  },
  {
    id: 'almacen-temporal-manejo-especial',
    required: true,
    aspectIds: [
      'ame-separated-service-areas',
      'ame-adequate-capacity',
    ],
  },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));
const ASPECTS = CATEGORIES.flatMap((category) => category.aspectIds.map((id) => ({
  id,
  categoryId: category.id,
  required: category.required,
})));
const ASPECT_BY_ID = new Map(ASPECTS.map((aspect) => [aspect.id, aspect]));

function validateEnvironmentalAspects(aspects) {
  const errors = [];
  const seen = new Set();
  for (const [index, aspect] of aspects.entries()) {
    if (!aspect || typeof aspect !== 'object' || Array.isArray(aspect)) {
      errors.push(`environmentalAspects[${index}] debe ser un objeto.`);
      continue;
    }
    const definition = ASPECT_BY_ID.get(aspect.aspectId);
    if (!definition || definition.categoryId !== aspect.categoryId) {
      errors.push(`environmentalAspects[${index}] contiene una pregunta desconocida.`);
      continue;
    }
    if (seen.has(aspect.aspectId)) errors.push(`La pregunta ${aspect.aspectId} está duplicada.`);
    seen.add(aspect.aspectId);
    if (aspect.answer != null && !['1', '0', 'NA'].includes(aspect.answer)) {
      errors.push(`La respuesta de ${aspect.aspectId} debe ser 1, 0 o NA.`);
    }
    if (typeof aspect.observation !== 'string' || aspect.observation.length > 1000) {
      errors.push(`La observación de ${aspect.aspectId} no es válida.`);
    }
  }
  return errors;
}

function validateReportCompletion(report) {
  const aspectsById = new Map((report.environmentalAspects || []).map((aspect) => [aspect.aspectId, aspect]));
  const notApplicableCategories = new Set(report.notApplicableCategories || []);
  const missingAspects = ASPECTS
    .filter((aspect) => aspect.required && !notApplicableCategories.has(aspect.categoryId))
    .filter(({ id }) => {
      const answer = aspectsById.get(id);
      return !answer?.answer;
    })
    .map(({ id }) => id);
  const hasCompleteEvidence = (report.evidence || []).some((entry) => (
    entry.status === 'active'
    && String(entry.description || '').trim()
    && entry.images.some((image) => image.status === 'active' && image.driveFileId)
  ));
  return {
    complete: missingAspects.length === 0 && hasCompleteEvidence,
    missingAspects,
    missingEvidence: !hasCompleteEvidence,
  };
}

module.exports = {
  ASPECTS,
  CATEGORIES,
  CATEGORY_BY_ID,
  validateEnvironmentalAspects,
  validateReportCompletion,
};
