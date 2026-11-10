'use strict';

const { DOCUMENT_MARKERS } = require('../formats/repFormat');

const MAX_FINDINGS = 40;
const MAX_IMAGES_PER_FINDING = 4;
const MAX_TEXT_LENGTH = 2000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const AREA_OPTIONS = [
  'Lobby', 'Ventas', 'Oficinas', 'Site', 'Taller de Autos',
  'Cuarto de Residuos Peligrosos (RP)', 'Aceites Limpios', 'Patio',
  'Cuarto de Bombas', 'Almacén Refacciones', 'Lavado de carros',
  'Comedor', 'Bodega de lavado', 'Cuarto de herramientas',
  'Almacen de garantias', 'Recepcion de autos',
];
const PRIORITY_OPTIONS = ['1', '2', '3', 'baja', 'media', 'alta', 'crítica'];
const STATUS_OPTIONS = ['TERMINADO', 'EN PROCESO', 'SIN AVANCE'];

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateRepPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { errors: ['El contenido del REP debe ser un objeto.'] };
  }
  const { generalData, findings, documents } = payload;
  if (!generalData || typeof generalData !== 'object' || Array.isArray(generalData)) {
    errors.push('Los datos generales del recorrido son obligatorios.');
  } else {
    if (!isValidDate(generalData.inspectionDate)) errors.push('La fecha del recorrido no es válida.');
    for (const field of ['startDate', 'endDate']) {
      if (generalData[field] && !isValidDate(generalData[field])) {
        errors.push(`La fecha ${field} no es válida.`);
      }
      if (generalData.startDate && generalData.endDate && generalData.startDate > generalData.endDate) {
        errors.push('La fecha de término no puede ser anterior a la fecha de inicio.');
      }
    }
    if (!['ordinario', 'extraordinario'].includes(generalData.visitType)) {
      errors.push('El tipo de recorrido debe ser ordinario o extraordinario.');
    }
    if (generalData.startTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(generalData.startTime)) {
      errors.push('La hora de inicio debe tener formato HH:MM.');
    }
    if (generalData.endTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(generalData.endTime)) {
      errors.push('La hora de término debe tener formato HH:MM.');
    }
    for (const field of ['areas', 'city']) {
      if (generalData[field] !== undefined
        && (typeof generalData[field] !== 'string' || generalData[field].length > MAX_TEXT_LENGTH)) {
        errors.push(`${field} debe ser texto de hasta ${MAX_TEXT_LENGTH} caracteres.`);
      }
    }
  }
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) {
    errors.push(`La lista de hallazgos debe ser un arreglo de hasta ${MAX_FINDINGS} registros.`);
  } else {
    findings.forEach((finding, index) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        errors.push(`El hallazgo ${index + 1} no es válido.`);
        return;
      }
      if (finding.images !== undefined
        && (!Array.isArray(finding.images) || finding.images.length > MAX_IMAGES_PER_FINDING)) {
        errors.push(`El hallazgo ${index + 1} puede incluir hasta ${MAX_IMAGES_PER_FINDING} fotos.`);
      }
      if (Array.isArray(finding.images)) {
        finding.images.forEach((image) => {
          if (!image || typeof image !== 'object' || Array.isArray(image)
            || typeof image.imageId !== 'string'
            || !IDENTIFIER_PATTERN.test(image.imageId)
            || typeof image.fileName !== 'string'
            || image.fileName.length > 255
            || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)
            || !['pending', 'active'].includes(image.status)) {
            errors.push(`La foto del hallazgo ${index + 1} no es válida.`);
          }
        });
      }
      for (const field of [
        'area', 'element', 'description', 'imageNumber', 'correctiveAction',
        'preventiveAction', 'priority', 'responsible', 'legalBasis', 'status',
        'findingDate', 'dueDate',
      ]) {
        if (finding[field] !== undefined
          && (typeof finding[field] !== 'string' || finding[field].length > MAX_TEXT_LENGTH)) {
          errors.push(`El campo ${field} del hallazgo ${index + 1} debe ser texto de hasta ${MAX_TEXT_LENGTH} caracteres.`);
        }
        if (finding.findingId !== undefined
          && (typeof finding.findingId !== 'string' || (finding.findingId && !IDENTIFIER_PATTERN.test(finding.findingId)))) {
          errors.push(`El identificador del hallazgo ${index + 1} no es válido.`);
        }
      }
      if (finding.onTime !== undefined && typeof finding.onTime !== 'boolean'
        && typeof finding.onTime !== 'string') {
        errors.push(`El campo onTime del hallazgo ${index + 1} debe ser booleano o texto.`);
      }
      if (finding.sanction !== undefined && finding.sanction !== ''
        && (!Number.isFinite(Number(finding.sanction)) || Number(finding.sanction) < 0)) {
        errors.push(`La sanción del hallazgo ${index + 1} debe ser un monto no negativo.`);
      }
      for (const field of ['findingDate', 'dueDate']) {
        if (finding[field] && !isValidDate(finding[field])) {
          errors.push(`La fecha ${field} del hallazgo ${index + 1} no es válida.`);
        }
      }
      if (!cleanText(finding.area, 200)) {
        errors.push(`El área del hallazgo ${index + 1} es obligatoria.`);
      }
      if (!cleanText(finding.element)) {
        errors.push(`El elemento revisado del hallazgo ${index + 1} es obligatorio.`);
      }
      if (!cleanText(finding.legalBasis)) {
        errors.push(`El fundamento legal del hallazgo ${index + 1} es obligatorio.`);
      }
      if (finding.priority && typeof finding.priority === 'string'
        && !PRIORITY_OPTIONS.includes(finding.priority.toLowerCase())) {
        errors.push(`La prioridad del hallazgo ${index + 1} no es válida.`);
      }
      if (finding.status && typeof finding.status === 'string'
        && !STATUS_OPTIONS.includes(finding.status.toUpperCase())) {
        errors.push(`El status del hallazgo ${index + 1} no es válido.`);
      }
      if (finding.onTime !== undefined && finding.onTime !== '' && typeof finding.onTime !== 'boolean'
        && (typeof finding.onTime !== 'string' || !['sí', 'si', 'no'].includes(finding.onTime.trim().toLowerCase()))) {
        errors.push(`El indicador en tiempo del hallazgo ${index + 1} debe ser Sí o No.`);
      }
    });
  }
  if (documents !== undefined && (!documents || typeof documents !== 'object' || Array.isArray(documents))) {
    errors.push('La revisión documental debe ser un objeto.');
  } else {
    for (const marker of DOCUMENT_MARKERS) {
      if (documents?.[marker] !== undefined
        && (typeof documents[marker] !== 'string' || documents[marker].length > MAX_TEXT_LENGTH)) {
        errors.push(`El campo documental ${marker} debe ser texto de hasta ${MAX_TEXT_LENGTH} caracteres.`);
      }
    }
    if (documents && Object.keys(documents).some((key) => !DOCUMENT_MARKERS.includes(key))) {
      errors.push('La revisión documental contiene campos desconocidos.');
    }
  }
  if (payload.idempotencyKey !== undefined
    && (typeof payload.idempotencyKey !== 'string' || !IDENTIFIER_PATTERN.test(payload.idempotencyKey))) {
    errors.push('La clave de idempotencia no es válida.');
  }
  if (errors.length) return { errors };

  const value = {
    generalData: {
      inspectionDate: generalData.inspectionDate,
      startDate: generalData.startDate || generalData.inspectionDate,
      endDate: generalData.endDate || generalData.inspectionDate,
      visitType: generalData.visitType,
      startTime: cleanText(generalData.startTime, 5),
      endTime: cleanText(generalData.endTime, 5),
      areas: cleanText(generalData.areas),
      city: cleanText(generalData.city, 200),
    },
    findings: findings.map((finding) => ({
      findingId: cleanText(finding.findingId, 100),
      area: cleanText(finding.area, 200),
      element: cleanText(finding.element),
      description: cleanText(finding.description),
      imageNumber: cleanText(finding.imageNumber, 200),
      images: (finding.images || []).map((image) => ({
        imageId: cleanText(image.imageId, 100),
        fileName: cleanText(image.fileName, 255),
        mimeType: image.mimeType,
        status: image.status,
      })),
      correctiveAction: cleanText(finding.correctiveAction),
      preventiveAction: cleanText(finding.preventiveAction),
      priority: cleanText(finding.priority, 30),
      responsible: cleanText(finding.responsible, 200),
      legalBasis: cleanText(finding.legalBasis),
      findingDate: finding.findingDate || '',
      dueDate: finding.dueDate || '',
      status: cleanText(finding.status, 50) || 'EN PROCESO',
      onTime: typeof finding.onTime === 'boolean'
        ? (finding.onTime ? 'Sí' : 'No')
        : cleanText(finding.onTime, 30),
      sanction: finding.sanction === undefined || finding.sanction === '' ? null : Number(finding.sanction),
    })),
    documents: Object.fromEntries(DOCUMENT_MARKERS.map((key) => [key, cleanText(documents?.[key])])),
  };
  if (payload.idempotencyKey) value.idempotencyKey = payload.idempotencyKey;
  return { errors, value };
}

function serializeRepReport(report) {
  const value = report.toObject ? report.toObject() : report;
  if (value.idempotencyKey) delete value.idempotencyKey;
  for (const finding of value.findings || []) {
    (finding.images || []).forEach((image) => {
      delete image.driveFileId;
      delete image.checksum;
    });
  }
  return value;
}

module.exports = {
  AREA_OPTIONS,
  MAX_IMAGES_PER_FINDING,
  MAX_FINDINGS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  isValidDate,
  serializeRepReport,
  validateRepPayload,
};
