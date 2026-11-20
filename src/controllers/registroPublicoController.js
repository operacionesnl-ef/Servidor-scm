const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const Formulario = require('../models/Formulario');
const RegistroFormulario = require('../models/RegistroFormulario');
const {
  PRIVACY_NOTICE_VERSION,
  calculateFormStatus,
  getAgencyBrand,
  brandKey,
  isValidCurp,
  normalizeText,
} = require('../services/formularioDomain');

function publicError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function validPublicToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,50}$/.test(token);
}

async function findPublicForm(token) {
  if (!validPublicToken(token)) return null;
  return Formulario.findOne({ tokenPublico: token }).lean();
}

function publicFormulario(form) {
  const config = form.configuracionFechas;
  return {
    tituloCurso: form.tituloCurso || form.nombreCurso,
    nombreCurso: form.nombreCurso,
    areaTematica: form.areaTematica,
    descripcion: form.descripcion || '',
    agenteCapacitador: form.agenteCapacitador || '',
    estado: calculateFormStatus(form),
    fechaApertura: config?.fechaApertura || null,
    fechaCierre: config?.fechaCierre || null,
    duracionFormulario: config?.duracionFormulario || null,
    fechaCurso: config?.fechaCurso || config?.fechaInicioVigencia || null,
    fechaInicioVigencia: config?.fechaCurso || config?.fechaInicioVigencia || null,
    fechaFinVigencia: config?.fechaFinVigencia || null,
    duracionCursoHoras: config?.duracionCursoHoras || null,
    camposParticipante: Formulario.CAMPOS_PARTICIPANTE,
  };
}

async function getPublicFormulario(req, res, next) {
  try {
    const form = await findPublicForm(req.params.token);
    if (!form) return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
    return res.json({ success: true, data: publicFormulario(form) });
  } catch (error) {
    return next(error);
  }
}

async function getPublicFormularioShortUrl(req, res, next) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(req.params.codigo || '')) {
    return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
  }
  try {
    const form = await Formulario.findOne({ codigoCorto: req.params.codigo })
      .select('tokenPublico')
      .lean();
    if (!form) return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
    return res.json({ success: true, data: { tokenPublico: form.tokenPublico } });
  } catch (error) {
    return next(error);
  }
}

async function getPublicMarcas(req, res, next) {
  try {
    const form = await findPublicForm(req.params.token);
    if (!form) return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
    if (calculateFormStatus(form) !== 'activo') return res.json({ success: true, data: [] });
    const activeAgencies = await Agency.find({ status: 'activa' }).select('brand marca').lean();
    const brands = new Map();
    activeAgencies.forEach((agency) => {
      const brand = getAgencyBrand(agency);
      if (brand && !brands.has(brandKey(brand))) brands.set(brandKey(brand), brand);
    });
    const data = [...brands.values()]
      .sort((a, b) => a.localeCompare(b, 'es-MX'))
      .map((brand) => ({ id: brand, nombre: brand }));
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getPublicAgencias(req, res, next) {
  try {
    const form = await findPublicForm(req.params.token);
    if (!form) return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
    if (calculateFormStatus(form) !== 'activo') return res.json({ success: true, data: [] });
    const requestedBrand = String(req.params.marcaId || '').trim().replace(/\s+/g, ' ');
    if (!requestedBrand) return publicError(res, 400, 'MARCA_INVALIDA', 'Selecciona una marca válida.');
    const brandPattern = new RegExp(`^${escapeRegExp(requestedBrand)}$`, 'i');
    const agencies = await Agency.find({
      status: 'activa',
      $or: [{ brand: brandPattern }, { marca: brandPattern }],
    }).select('_id nombre brand marca').sort({ nombre: 1 }).lean();
    const data = agencies
      .filter((agency) => brandKey(getAgencyBrand(agency)) === brandKey(requestedBrand))
      .map((agency) => ({ id: String(agency._id), nombre: agency.nombre }));
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

function validateParticipant(body = {}) {
  const nombreCompleto = normalizeText(body.nombreCompleto);
  const curp = normalizeText(body.curp);
  const puesto = normalizeText(body.puesto);
  const errors = {};
  if (!nombreCompleto) errors.nombreCompleto = 'El nombre completo es obligatorio.';
  else if (nombreCompleto.length > 160) errors.nombreCompleto = 'El nombre no puede superar 160 caracteres.';
  if (!curp) errors.curp = 'La CURP es obligatoria.';
  else if (!isValidCurp(curp)) errors.curp = 'La CURP no tiene un formato válido.';
  if (!puesto) errors.puesto = 'El puesto es obligatorio.';
  else if (puesto.length > 120) errors.puesto = 'El puesto no puede superar 120 caracteres.';
  const marcaId = typeof body.marcaId === 'string' ? body.marcaId.trim() : '';
  const agenciaId = typeof body.agenciaId === 'string' ? body.agenciaId : '';
  if (!marcaId) errors.marcaId = 'Selecciona una marca.';
  if (!mongoose.isValidObjectId(agenciaId)) errors.agenciaId = 'Selecciona una agencia válida.';
  if (body.avisoPrivacidadAceptado !== true) errors.avisoPrivacidadAceptado = 'Debes confirmar el aviso de privacidad.';
  return {
    data: { nombreCompleto, curp, puesto, marcaId, agenciaId },
    errors,
  };
}

async function releaseParticipantReservation(formId, revision) {
  const filter = {
    _id: formId,
    cantidadParticipantes: { $gt: 0 },
    $or: [{ revisionConfig: revision }, { revisionConfig: { $exists: false } }],
  };
  const result = await Formulario.updateOne(filter, { $inc: { cantidadParticipantes: -1 } });
  if (!result.matchedCount) throw new Error('No se pudo liberar la reserva de registro.');
}

async function createPublicRegistro(req, res, next) {
  req.auditRequestSummary = {
    participantSubmission: true,
    privacyAccepted: req.body?.avisoPrivacidadAceptado === true,
    hasName: Boolean(req.body?.nombreCompleto),
    hasCurp: Boolean(req.body?.curp),
    hasPosition: Boolean(req.body?.puesto),
    hasAgency: Boolean(req.body?.agenciaId),
  };
  try {
    const form = await findPublicForm(req.params.token);
    if (!form) return publicError(res, 404, 'FORMULARIO_NO_ENCONTRADO', 'No se encontró el formulario solicitado.');
    const now = new Date();
    const estado = calculateFormStatus(form, now);
    if (estado !== 'activo') {
      return res.status(409).json({
        success: false,
        code: 'FORMULARIO_NO_ACTIVO',
        message: 'El formulario no está recibiendo registros en este momento.',
        estado,
      });
    }

    const { data: participant, errors } = validateParticipant(req.body);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, code: 'DATOS_INVALIDOS', message: 'Revisa los datos capturados.', errors });
    }

    const agency = await Agency.findOne({
      _id: participant.agenciaId,
      status: 'activa',
    }).select('_id nombre razonSocial RFC rfc brand marca').lean();
    if (!agency || brandKey(getAgencyBrand(agency)) !== brandKey(participant.marcaId)) {
      return publicError(res, 400, 'AGENCIA_NO_VALIDA', 'La agencia seleccionada no pertenece a la marca indicada o ya no está activa.');
    }

    const revision = Number(form.revisionConfig) || 1;
    const reservedForm = await Formulario.findOneAndUpdate(
      {
        _id: form._id,
        tokenPublico: req.params.token,
        'cancelacion.cancelado': { $ne: true },
        'configuracionFechas.fechaApertura': { $lte: now },
        'configuracionFechas.fechaCierre': { $gt: now },
        $or: [{ revisionConfig: revision }, { revisionConfig: { $exists: false } }],
      },
      { $inc: { cantidadParticipantes: 1 } },
      { new: true },
    ).lean();
    if (!reservedForm) {
      return publicError(res, 409, 'FORMULARIO_ACTUALIZADO', 'El formulario cambió. Actualiza la página e inténtalo nuevamente.');
    }

    try {
      await RegistroFormulario.create({
        formularioId: form._id,
        trabajador: {
          nombreCompleto: participant.nombreCompleto,
          curp: participant.curp,
          puesto: participant.puesto,
          agenteCapacitador: form.agenteCapacitador || '',
        },
        marcaId: getAgencyBrand(agency),
        agenciaId: agency._id,
        datosAgencia: {
          nombreAgencia: agency.nombre,
          razonSocial: agency.razonSocial || '',
          rfc: agency.rfc || agency.RFC || '',
        },
        datosConstancia: {
          tituloCurso: form.tituloCurso || form.nombreCurso,
          nombreCurso: form.nombreCurso,
          areaTematica: form.areaTematica,
          fechaInicioVigencia: form.configuracionFechas.fechaCurso || form.configuracionFechas.fechaInicioVigencia,
          fechaFinVigencia: form.configuracionFechas.fechaFinVigencia,
          duracionHoras: form.configuracionFechas.duracionCursoHoras,
        },
        avisoPrivacidad: {
          aceptado: true,
          fechaAceptacion: now,
          version: PRIVACY_NOTICE_VERSION,
        },
      });
    } catch (error) {
      await releaseParticipantReservation(form._id, revision);
      if (error?.code === 11000) {
        return publicError(res, 409, 'REGISTRO_DUPLICADO', 'Ya existe un registro para esta CURP en la agencia seleccionada.');
      }
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: 'Tu registro se recibió correctamente.',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPublicFormulario,
  getPublicFormularioShortUrl,
  getPublicMarcas,
  getPublicAgencias,
  createPublicRegistro,
  validateParticipant,
};
