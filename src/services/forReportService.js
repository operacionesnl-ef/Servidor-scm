'use strict';

const {
  ASPECTS,
  validateEnvironmentalAspects,
  validateReportCompletion: validateFormatCompletion,
} = require('../formats/forAudAmb');
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_EVIDENCE_COUNT = 20;
const MAX_IMAGES_PER_EVIDENCE = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isValidInspectionDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sanitizeOriginalName(value) {
  const name = String(value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 255) || 'evidencia';
}

function validateReportPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { errors: ['El contenido del reporte debe ser un objeto.'] };
  }
  const generalData = payload.generalData;
  if (!generalData || !isValidInspectionDate(generalData.inspectionDate)) {
    errors.push('La fecha del recorrido debe tener formato AAAA-MM-DD y ser válida.');
  }
  if (typeof generalData?.observations !== 'string' || generalData.observations.length > 2000) {
    errors.push('Las observaciones generales deben ser texto de hasta 2000 caracteres.');
  }

  const aspects = payload.environmentalAspects;
  if (!Array.isArray(aspects) || aspects.length > ASPECTS.length) {
    errors.push('La lista de aspectos ambientales no es válida.');
  } else {
    errors.push(...validateEnvironmentalAspects(aspects));
  }

  const evidence = payload.evidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_COUNT) {
    errors.push(`El reporte admite hasta ${MAX_EVIDENCE_COUNT} evidencias.`);
  } else {
    const evidenceIds = new Set();
    const imageIds = new Set();
    evidence.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !IDENTIFIER_PATTERN.test(entry.evidenceId || '')) {
        errors.push(`La evidencia ${index + 1} no tiene un ID válido.`);
        return;
      }
      if (evidenceIds.has(entry.evidenceId)) errors.push(`La evidencia ${entry.evidenceId} está duplicada.`);
      evidenceIds.add(entry.evidenceId);
      if (typeof entry.description !== 'string' || entry.description.length > 500) {
        errors.push(`La descripción de ${entry.evidenceId} debe tener hasta 500 caracteres.`);
      }
      if (!Array.isArray(entry.images) || entry.images.length > MAX_IMAGES_PER_EVIDENCE) {
        errors.push(`${entry.evidenceId} admite hasta ${MAX_IMAGES_PER_EVIDENCE} imágenes.`);
        return;
      }
      entry.images.forEach((image) => {
        if (!image || typeof image !== 'object' || Array.isArray(image)
          || !IDENTIFIER_PATTERN.test(image.imageId || '')
          || typeof image.fileName !== 'string'
          || image.fileName.length > 255
          || (image.mimeType && !ALLOWED_IMAGE_MIME_TYPES.has(image.mimeType))) {
          errors.push(`Una imagen de ${entry.evidenceId} tiene metadatos inválidos.`);
          return;
        }
        if (imageIds.has(image.imageId)) errors.push(`La imagen ${image.imageId} está duplicada.`);
        imageIds.add(image.imageId);
      });
    });
  }

  if (errors.length) return { errors };
  return {
    errors,
    value: {
      generalData: {
        inspectionDate: generalData.inspectionDate,
        observations: generalData.observations.trim(),
      },
      environmentalAspects: aspects.map((aspect) => ({
        categoryId: aspect.categoryId,
        aspectId: aspect.aspectId,
        answer: aspect.answer || null,
        observation: aspect.observation.trim(),
      })),
      evidence: evidence.map((entry) => ({
        evidenceId: entry.evidenceId,
        description: entry.description.trim(),
        images: entry.images.map((image) => ({
          imageId: image.imageId,
          fileName: sanitizeOriginalName(image.fileName),
          mimeType: image.mimeType || '',
        })),
      })),
    },
  };
}

function getReportContentSnapshot(report) {
  return JSON.stringify({
    generalData: report.generalData,
    environmentalAspects: report.environmentalAspects,
    evidence: report.evidence,
    status: report.status,
  });
}

function reconcileReportContent(report, value, userId) {
  const before = getReportContentSnapshot(report);
  const existingEvidence = new Map(report.evidence.map((entry) => [
    entry.evidenceId,
    entry.toObject ? entry.toObject() : entry,
  ]));
  const nextEvidenceIds = new Set();

  report.generalData = {
    companyName: report.agencyNameSnapshot,
    inspectionDate: value.generalData.inspectionDate,
    observations: value.generalData.observations,
  };
  report.environmentalAspects = value.environmentalAspects;
  report.evidence = value.evidence.map((entry) => {
    nextEvidenceIds.add(entry.evidenceId);
    const previous = existingEvidence.get(entry.evidenceId);
    const previousImages = new Map((previous?.images || []).map((image) => [image.imageId, image]));
    const images = entry.images.map((image) => {
      const existingImage = previousImages.get(image.imageId);
      if (existingImage) {
        if (existingImage.status === 'removed') {
          throw new Error(`La imagen ${image.imageId} ya fue retirada y no se puede reactivar.`);
        }
        if (image.mimeType && existingImage.mimeType !== image.mimeType) {
          throw new Error(`El tipo de archivo de ${image.imageId} no coincide con el registro guardado.`);
        }
        return existingImage;
      }
      return {
        ...image,
        driveFileId: '',
        sizeBytes: 0,
        status: 'pending',
        uploadedAt: null,
      };
    });
    for (const [imageId, image] of previousImages) {
      if (!entry.images.some((candidate) => candidate.imageId === imageId)) {
        images.push({ ...image, status: 'removed' });
      }
    }
    return {
      evidenceId: entry.evidenceId,
      description: entry.description,
      status: 'active',
      images,
    };
  });
  for (const [evidenceId, entry] of existingEvidence) {
    if (!nextEvidenceIds.has(evidenceId)) {
      report.evidence.push({
        ...entry,
        status: 'removed',
        images: (entry.images || []).map((image) => ({ ...image, status: 'removed' })),
      });
    }
  }
  report.updatedBy = userId;
  const changed = before !== getReportContentSnapshot(report);
  if (changed) report.revision += 1;
  return changed;
}

function serializeReport(report) {
  const value = report.toObject ? report.toObject() : { ...report };
  delete value.__v;
  delete value.idempotencyKey;
  delete value.drive;
  value.evidence = (value.evidence || []).map((entry) => ({
    ...entry,
    images: (entry.images || []).map((image) => {
      const { driveFileId, ...publicImage } = image;
      return publicImage;
    }),
  }));
  return value;
}

function getDetectedImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function validateReportCompletion(report) {
  const result = validateReportCompletionData(report);
  return result;
}

function validateReportCompletionData(report) {
  const completion = validateFormatCompletion(report);
  const pendingImages = (report.evidence || []).reduce((total, entry) => (
    total + (entry.images || []).filter((image) => image.status === 'pending').length
  ), 0);
  return {
    ...completion,
    complete: completion.complete && pendingImages === 0,
    pendingImages,
  };
}

module.exports = {
  ALLOWED_IMAGE_MIME_TYPES,
  IDENTIFIER_PATTERN,
  MAX_EVIDENCE_COUNT,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_EVIDENCE,
  getDetectedImageMimeType,
  isValidInspectionDate,
  reconcileReportContent,
  sanitizeOriginalName,
  serializeReport,
  validateReportCompletion,
  validateReportPayload,
};
