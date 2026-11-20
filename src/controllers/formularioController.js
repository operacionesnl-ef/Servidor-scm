const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const Formulario = require('../models/Formulario');
const RegistroFormulario = require('../models/RegistroFormulario');
const {
  calculateCloseDate,
  calculateFormStatus,
  dateFromZonedInput,
} = require('../services/formularioDomain');

const PROTECTED_FIELDS = new Set([
  'tokenPublico',
  'estado',
  'camposParticipante',
  'creadoPor',
  'actualizadoPor',
  'fechaCreacion',
  'fechaActualizacion',
  'fechaCierre',
  'codigoCorto',
  'id',
  '_id',
]);
const SORT_FIELDS = new Set([
  'nombreCurso',
  'areaTematica',
  'fechaCreacion',
  'fechaActualizacion',
  'configuracionFechas.fechaApertura',
  'configuracionFechas.fechaCierre',
]);

function sendValidationError(res, errors) {
  return res.status(400).json({
    success: false,
    message: 'Revisa la configuración del formulario.',
    errors,
  });
}

function rejectProtectedField(body) {
  return Object.keys(body || {}).find((field) => PROTECTED_FIELDS.has(field));
}

function normalizeFormularioBody(body = {}) {
  const data = {
    nombreCurso: typeof body.nombreCurso === 'string' ? body.nombreCurso.trim().replace(/\s+/g, ' ') : '',
    tituloCurso: typeof body.tituloCurso === 'string'
      ? body.tituloCurso.trim().replace(/\s+/g, ' ')
      : (typeof body.nombreCurso === 'string' ? body.nombreCurso.trim().replace(/\s+/g, ' ') : ''),
    areaTematica: typeof body.areaTematica === 'string' ? body.areaTematica.trim().replace(/\s+/g, ' ') : '',
    descripcion: typeof body.descripcion === 'string' ? body.descripcion.trim() : '',
    agenteCapacitador: typeof body.agenteCapacitador === 'string'
      ? body.agenteCapacitador.trim().replace(/\s+/g, ' ')
      : Formulario.DEFAULT_AGENT,
  };
  const errors = {};

  if (!data.tituloCurso) errors.tituloCurso = 'El título del curso es obligatorio.';
  else if (data.tituloCurso.length > 120) errors.tituloCurso = 'El título no puede superar 120 caracteres.';
  if (!data.nombreCurso) errors.nombreCurso = 'El nombre del curso es obligatorio.';
  else if (data.nombreCurso.length > 120) errors.nombreCurso = 'El nombre no puede superar 120 caracteres.';
  if (!data.areaTematica) errors.areaTematica = 'El área temática es obligatoria.';
  else if (data.areaTematica.length > 120) errors.areaTematica = 'El área temática no puede superar 120 caracteres.';
  if (data.descripcion.length > 1000) errors.descripcion = 'La descripción no puede superar 1,000 caracteres.';
  if (data.agenteCapacitador.length > 160) errors.agenteCapacitador = 'El agente capacitador no puede superar 160 caracteres.';

  const input = body.configuracionFechas || {};
  try {
    data.fechaApertura = dateFromZonedInput(input.fechaApertura);
  } catch (error) {
    errors.fechaApertura = error.message;
  }
  const courseDate = input.fechaCurso ?? input.fechaInicioVigencia;
  try {
    data.fechaCurso = dateFromZonedInput(courseDate, !input.fechaCurso);
  } catch (error) {
    errors.fechaCurso = error.message;
  }
  try {
    data.fechaFinVigencia = dateFromZonedInput(input.fechaFinVigencia, true);
  } catch (error) {
    errors.fechaFinVigencia = error.message;
  }

  if (data.fechaCurso) {
    try {
      data.fechaCierre = calculateCloseDate(data.fechaCurso);
    } catch (error) {
      errors.fechaCurso = error.message;
    }
  }

  const durationCourse = Number(input.duracionCursoHoras ?? 8);
  if (!Number.isFinite(durationCourse) || durationCourse <= 0) {
    errors.duracionCursoHoras = 'La duración de capacitación debe ser mayor que cero.';
  } else {
    data.duracionCursoHoras = durationCourse;
  }
  if (data.fechaApertura && data.fechaCurso && data.fechaApertura > data.fechaCurso) {
    errors.fechaApertura = 'La apertura debe ser anterior o igual a la fecha del curso.';
  }
  if (data.fechaCurso && data.fechaFinVigencia
    && data.fechaFinVigencia <= data.fechaCurso) {
    errors.fechaFinVigencia = 'El fin de vigencia debe ser posterior a la fecha del curso.';
  }

  return { data, errors };
}

function serializeFormulario(form, cantidadParticipantes = 0) {
  return {
    _id: String(form._id),
    tituloCurso: form.tituloCurso || form.nombreCurso,
    nombreCurso: form.nombreCurso,
    areaTematica: form.areaTematica,
    descripcion: form.descripcion || '',
    agenteCapacitador: form.agenteCapacitador || '',
    configuracionFechas: {
      ...form.configuracionFechas,
      fechaCurso: form.configuracionFechas?.fechaCurso || form.configuracionFechas?.fechaInicioVigencia,
    },
    camposParticipante: Formulario.CAMPOS_PARTICIPANTE,
    tokenPublico: form.tokenPublico,
    urlPublica: form.codigoCorto ? `/r/${form.codigoCorto}` : `/registro/${form.tokenPublico}`,
    estado: calculateFormStatus(form),
    cancelacion: form.cancelacion,
    creadoPor: form.creadoPor,
    fechaCreacion: form.fechaCreacion,
    fechaActualizacion: form.fechaActualizacion,
    cantidadParticipantes,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getStatusFilter(status, now) {
  const open = 'configuracionFechas.fechaApertura';
  const close = 'configuracionFechas.fechaCierre';
  if (status === 'programado') return { 'cancelacion.cancelado': { $ne: true }, [open]: { $gt: now } };
  if (status === 'activo') return {
    'cancelacion.cancelado': { $ne: true },
    [open]: { $lte: now },
    [close]: { $gt: now },
  };
  if (status === 'cerrado') return { 'cancelacion.cancelado': { $ne: true }, [close]: { $lte: now } };
  if (status === 'cancelado') return { 'cancelacion.cancelado': true };
  return null;
}

function getListFilter(query, now) {
  const filter = {};
  const search = String(query.search || '').trim();
  const area = String(query.areaTematica || '').trim();
  if (search) {
    const pattern = { $regex: escapeRegExp(search), $options: 'i' };
    filter.$or = [{ nombreCurso: pattern }, { tituloCurso: pattern }];
  }
  if (area) filter.areaTematica = { $regex: escapeRegExp(area), $options: 'i' };
  if (query.estado) {
    const statusFilter = getStatusFilter(String(query.estado), now);
    if (!statusFilter) {
      const error = new Error('El filtro de estado no es válido.');
      error.status = 400;
      throw error;
    }
    Object.assign(filter, statusFilter);
  }
  return filter;
}

async function getIndicators(now) {
  const uncancelled = { 'cancelacion.cancelado': { $ne: true } };
  const [total, programados, activos, cerrados, cancelados, participantes] = await Promise.all([
    Formulario.countDocuments(),
    Formulario.countDocuments({ ...uncancelled, 'configuracionFechas.fechaApertura': { $gt: now } }),
    Formulario.countDocuments({
      ...uncancelled,
      'configuracionFechas.fechaApertura': { $lte: now },
      'configuracionFechas.fechaCierre': { $gt: now },
    }),
    Formulario.countDocuments({ ...uncancelled, 'configuracionFechas.fechaCierre': { $lte: now } }),
    Formulario.countDocuments({ 'cancelacion.cancelado': true }),
    RegistroFormulario.countDocuments(),
  ]);
  return {
    totalFormularios: total,
    formulariosProgramados: programados,
    formulariosActivos: activos,
    formulariosCerrados: cerrados,
    formulariosCancelados: cancelados,
    totalParticipantes: participantes,
  };
}

async function getFormularios(req, res, next) {
  try {
    const now = new Date();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const filter = getListFilter(req.query, now);
    const sortField = SORT_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'fechaActualizacion';
    const sortDirection = req.query.sortOrder === 'asc' ? 1 : -1;
    const [forms, total, indicadores] = await Promise.all([
      Formulario.find(filter)
        .sort({ [sortField]: sortDirection, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Formulario.countDocuments(filter),
      getIndicators(now),
    ]);
    const registrationCounts = forms.length
      ? await RegistroFormulario.aggregate([
        { $match: { formularioId: { $in: forms.map((form) => form._id) } } },
        { $group: { _id: '$formularioId', cantidad: { $sum: 1 } } },
      ])
      : [];
    const countByForm = new Map(registrationCounts.map((entry) => [String(entry._id), entry.cantidad]));
    return res.json({
      success: true,
      data: forms.map((form) => serializeFormulario(form, countByForm.get(String(form._id)) || 0)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      indicadores,
    });
  } catch (error) {
    return next(error);
  }
}

async function normalizeFormularioInput(body) {
  const { data, errors } = normalizeFormularioBody(body);
  return {
    data: {
      tituloCurso: data.tituloCurso,
      nombreCurso: data.nombreCurso,
      areaTematica: data.areaTematica,
      descripcion: data.descripcion,
      agenteCapacitador: data.agenteCapacitador,
      configuracionFechas: {
        fechaApertura: data.fechaApertura,
        fechaCierre: data.fechaCierre,
        fechaCurso: data.fechaCurso,
        fechaFinVigencia: data.fechaFinVigencia,
        duracionCursoHoras: data.duracionCursoHoras,
      },
      camposParticipante: Formulario.CAMPOS_PARTICIPANTE,
    },
    errors,
  };
}

function newPublicToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newShortCode() {
  return crypto.randomBytes(12).toString('base64url');
}

async function createFormulario(req, res, next) {
  const protectedField = rejectProtectedField(req.body || {});
  if (protectedField) {
    return sendValidationError(res, { [protectedField]: 'Este campo es administrado por el servidor.' });
  }
  try {
    const { data, errors } = await normalizeFormularioInput(req.body);
    if (Object.keys(errors).length) return sendValidationError(res, errors);
    let formulario;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const tokenPublico = newPublicToken();
        const codigoCorto = newShortCode();
        const initialForm = {
          ...data,
          tokenPublico,
          codigoCorto,
          creadoPor: req.user._id,
          actualizadoPor: req.user._id,
        };
        initialForm.estado = calculateFormStatus(initialForm);
        formulario = await Formulario.create(initialForm);
        break;
      } catch (error) {
        if (error?.code !== 11000 || attempt === 2) throw error;
      }
    }
    return res.status(201).json({ success: true, data: serializeFormulario(formulario) });
  } catch (error) {
    return next(error);
  }
}

async function getFormulario(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  try {
    const formulario = await Formulario.findById(req.params.id).lean();
    if (!formulario) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    const cantidadParticipantes = await RegistroFormulario.countDocuments({ formularioId: formulario._id });
    return res.json({ success: true, data: serializeFormulario(formulario, cantidadParticipantes) });
  } catch (error) {
    return next(error);
  }
}

async function updateFormulario(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  const protectedField = rejectProtectedField(req.body || {});
  if (protectedField) {
    return sendValidationError(res, { [protectedField]: 'Este campo es administrado por el servidor.' });
  }
  try {
    const current = await Formulario.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    if (current.cancelacion?.cancelado) {
      return res.status(409).json({ success: false, message: 'No se puede editar un formulario cancelado.' });
    }
    const registrationCount = await RegistroFormulario.countDocuments({ formularioId: current._id });
    if (registrationCount > 0 || Number(current.cantidadParticipantes || 0) > 0) {
      return res.status(409).json({
        success: false,
        message: 'No se puede modificar un formulario que ya recibió participantes.',
      });
    }
    const { data, errors } = await normalizeFormularioInput(req.body);
    if (Object.keys(errors).length) return sendValidationError(res, errors);
    const currentRevision = Number(current.revisionConfig) || 1;
    const updated = await Formulario.findOneAndUpdate(
      {
        $and: [
          { _id: current._id, 'cancelacion.cancelado': { $ne: true } },
          { $or: [{ revisionConfig: currentRevision }, { revisionConfig: { $exists: false } }] },
          { $or: [{ cantidadParticipantes: 0 }, { cantidadParticipantes: { $exists: false } }] },
        ],
      },
      { $set: { ...data, actualizadoPor: req.user._id }, $inc: { revisionConfig: 1 } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) return res.status(409).json({ success: false, message: 'El formulario cambió durante la edición. Vuelve a cargarlo.' });
    return res.json({ success: true, data: serializeFormulario(updated, 0) });
  } catch (error) {
    return next(error);
  }
}

async function cancelFormulario(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
  if (!motivo || motivo.length > 500) {
    return sendValidationError(res, { motivo: 'Indica un motivo de cancelación de hasta 500 caracteres.' });
  }
  try {
    const formulario = await Formulario.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          estado: 'cancelado',
          cancelacion: {
            cancelado: true,
            canceladoPor: req.user._id,
            fechaCancelacion: new Date(),
            motivo,
          },
          actualizadoPor: req.user._id,
        },
      },
      { new: true, runValidators: true },
    ).lean();
    if (!formulario) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    return res.json({ success: true, data: serializeFormulario(formulario) });
  } catch (error) {
    return next(error);
  }
}

async function getFormularioQR(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  try {
    const formulario = await Formulario.findById(req.params.id).select('_id tokenPublico codigoCorto').lean();
    if (!formulario) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    const codigoCorto = await ensureShortCode(formulario);
    return res.json({ success: true, data: { urlPublica: `/r/${codigoCorto}` } });
  } catch (error) {
    return next(error);
  }
}

async function ensureShortCode(formulario) {
  if (formulario.codigoCorto) return formulario.codigoCorto;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const updated = await Formulario.findOneAndUpdate(
        {
          _id: formulario._id,
          $or: [
            { codigoCorto: { $exists: false } },
            { codigoCorto: null },
            { codigoCorto: '' },
          ],
        },
        { $set: { codigoCorto: newShortCode() } },
        { new: true },
      ).select('_id codigoCorto').lean();
      if (updated?.codigoCorto) return updated.codigoCorto;

      const current = await Formulario.findById(formulario._id).select('_id codigoCorto').lean();
      if (current?.codigoCorto) return current.codigoCorto;
    } catch (error) {
      if (error?.code !== 11000 || attempt === 4) throw error;
    }
  }
  throw new Error('No se pudo asignar un enlace corto al formulario.');
}

function buildRegistrationFilter(formularioId, query) {
  const filter = { formularioId };
  const search = String(query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegExp(search), 'i');
    filter.$or = [
      { 'trabajador.nombreCompleto': pattern },
      { 'trabajador.curp': pattern },
      { 'trabajador.puesto': pattern },
      { agenteCapacitador: pattern },
    ];
  }
  if (query.marcaId) filter.marcaId = String(query.marcaId);
  if (query.agenciaId) {
    if (!mongoose.isValidObjectId(query.agenciaId)) {
      const error = new Error('El filtro de agencia no es válido.');
      error.status = 400;
      throw error;
    }
    filter.agenciaId = new mongoose.Types.ObjectId(query.agenciaId);
  }
  if (query.estado && ['valido', 'invalidado'].includes(query.estado)) filter.estado = query.estado;
  return filter;
}

async function getFormularioRegistros(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  try {
    const formulario = await Formulario.exists({ _id: req.params.id });
    if (!formulario) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const filter = buildRegistrationFilter(new mongoose.Types.ObjectId(req.params.id), req.query);
    const [registros, total] = await Promise.all([
      RegistroFormulario.find(filter)
        .sort({ fechaRegistro: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      RegistroFormulario.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: registros,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
}

function excelCell(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function excelDateCell(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Monterrey',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.month}/${values.day}/${values.year}`;
}

async function exportFormularioRegistros(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
  }
  try {
    const formulario = await Formulario.findById(req.params.id)
      .select('tituloCurso nombreCurso areaTematica agenteCapacitador configuracionFechas')
      .lean();
    if (!formulario) return res.status(404).json({ success: false, message: 'Formulario no encontrado.' });
    const filter = buildRegistrationFilter(new mongoose.Types.ObjectId(req.params.id), req.query);
    const agencyIds = await RegistroFormulario.distinct('agenciaId', filter);
    const agencies = agencyIds.length
      ? await Agency.find({ _id: { $in: agencyIds } }).select('_id rfc RFC').lean()
      : [];
    const rfcByAgencyId = new Map(agencies.map((agency) => [
      String(agency._id),
      agency.rfc || agency.RFC || '',
    ]));
    const safeName = (formulario.tituloCurso || formulario.nombreCurso).replace(/[^\p{L}\p{N}-]+/gu, '_').slice(0, 80) || 'formularios';
    res.status(200);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}_participantes.xlsx"`,
      'Cache-Control': 'no-store',
    });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const sheet = workbook.addWorksheet('Participantes');
    sheet.columns = [
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'CURP', key: 'curp', width: 22 },
      { header: 'Puesto', key: 'puesto', width: 24 },
      { header: 'Marca', key: 'marca', width: 24 },
      { header: 'Agencia', key: 'agencia', width: 30 },
      { header: 'Razón social', key: 'razonSocial', width: 36 },
      { header: 'RFC', key: 'rfc', width: 18 },
      { header: 'Nombre del curso', key: 'nombreCurso', width: 40 },
      { header: 'Área temática', key: 'areaTematica', width: 24 },
      { header: 'Agente capacitador', key: 'agenteCapacitador', width: 30 },
      { header: 'Fecha inicio', key: 'fechaInicio', width: 16 },
      { header: 'Fecha fin', key: 'fechaFin', width: 16 },
      { header: 'Duración', key: 'duracion', width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };
    const cursor = RegistroFormulario.find(filter).sort({ fechaRegistro: -1 }).lean().cursor();
    for await (const registro of cursor) {
      sheet.addRow({
        nombre: excelCell(registro.trabajador.nombreCompleto),
        curp: excelCell(registro.trabajador.curp),
        puesto: excelCell(registro.trabajador.puesto),
        marca: excelCell(registro.marcaId),
        agencia: excelCell(registro.datosAgencia.nombreAgencia),
        razonSocial: excelCell(registro.datosAgencia.razonSocial),
        rfc: excelCell(registro.datosAgencia.rfc || rfcByAgencyId.get(String(registro.agenciaId))),
        nombreCurso: excelCell(registro.datosConstancia.nombreCurso || formulario.nombreCurso),
        areaTematica: excelCell(registro.datosConstancia.areaTematica || formulario.areaTematica),
        agenteCapacitador: excelCell(registro.trabajador.agenteCapacitador || formulario.agenteCapacitador),
        fechaInicio: excelDateCell(
          registro.datosConstancia.fechaInicioVigencia
            || formulario.configuracionFechas?.fechaCurso
            || formulario.configuracionFechas?.fechaInicioVigencia,
        ),
        fechaFin: excelDateCell(registro.datosConstancia.fechaFinVigencia || formulario.configuracionFechas?.fechaFinVigencia),
        duracion: '8 horas',
      }).commit();
    }
    sheet.commit();
    await workbook.commit();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getFormularios,
  createFormulario,
  getFormulario,
  updateFormulario,
  cancelFormulario,
  getFormularioQR,
  getFormularioRegistros,
  exportFormularioRegistros,
  normalizeFormularioBody,
  serializeFormulario,
  buildRegistrationFilter,
  getStatusFilter,
  getListFilter,
};
