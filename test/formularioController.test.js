const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const Formulario = require('../src/models/Formulario');
const RegistroFormulario = require('../src/models/RegistroFormulario');
const { createFormulario } = require('../src/controllers/formularioController');
const {
  createPublicRegistro,
  getPublicAgencias,
  getPublicMarcas,
  validateParticipant,
} = require('../src/controllers/registroPublicoController');
const {
  calculateCloseDate,
  calculateFormStatus,
  dateFromZonedInput,
  isValidCurp,
  normalizeText,
} = require('../src/services/formularioDomain');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('parses administrator wall-time in America/Monterrey and calculates the close instant', () => {
  const apertura = dateFromZonedInput('2026-11-17T08:00');
  const cierre = calculateCloseDate(apertura, { valor: 7, unidad: 'dias' });

  assert.equal(apertura.toISOString(), '2026-11-17T14:00:00.000Z');
  assert.equal(cierre.toISOString(), '2026-11-24T14:00:00.000Z');
});

test('requires a valid duration, vigency dates and CURP structure', () => {
  assert.throws(() => calculateCloseDate(new Date(), { valor: 0, unidad: 'dias' }));
  assert.throws(() => dateFromZonedInput('2026-02-30T12:00'));
  assert.equal(isValidCurp('GODE561231HDFRRN00'), true);
  assert.equal(isValidCurp('GODE561231HDFRRN09'), false);
  assert.equal(isValidCurp('GODE991332HDFRRN00'), false);
  assert.equal(normalizeText('  juan   pérez  '), 'JUAN PÉREZ');
});

test('creates a fully configured form with fixed participant fields and a generated token', async (context) => {
  const originalFormCreate = Formulario.create;
  context.after(() => {
    Formulario.create = originalFormCreate;
  });
  let saved;
  Formulario.create = async (data) => {
    saved = {
      ...data,
      _id: new mongoose.Types.ObjectId(),
      fechaCreacion: new Date(),
      fechaActualizacion: new Date(),
    };
    return saved;
  };
  const response = createResponse();
  let nextError;

  await createFormulario({
    body: {
      nombreCurso: '  Seguridad industrial ',
      areaTematica: 'Higiene y Seguridad',
      descripcion: '',
      configuracionFechas: {
        fechaApertura: '2099-01-01T08:00',
        duracionFormulario: { valor: 7, unidad: 'dias' },
        fechaInicioVigencia: '2099-01-10',
        fechaFinVigencia: '2099-01-11',
        duracionCursoHoras: 4,
      },
    },
    user: { _id: new mongoose.Types.ObjectId() },
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 201);
  assert.match(saved.tokenPublico, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.nombreCurso, 'Seguridad industrial');
  assert.equal(saved.configuracionFechas.fechaCierre.toISOString(), '2099-01-08T14:00:00.000Z');
  assert.deepEqual(saved.camposParticipante, ['nombreCompleto', 'curp', 'puesto', 'marca', 'agencia']);
  assert.equal(response.body.data.estado, 'programado');
});

test('validates participant input and never adds its submitted CURP to the audit summary', async (context) => {
  const originalFindOne = Formulario.findOne;
  context.after(() => { Formulario.findOne = originalFindOne; });
  const tokenPublico = 'A'.repeat(43);
  Formulario.findOne = () => ({
    lean: async () => ({
      _id: new mongoose.Types.ObjectId(),
      tokenPublico,
      estado: 'activo',
      configuracionFechas: {
        fechaApertura: new Date('2020-01-01T00:00:00Z'),
        fechaCierre: new Date('2099-01-01T00:00:00Z'),
      },
    }),
  });
  const req = {
    params: { token: tokenPublico },
    body: {
      nombreCompleto: 'Juan Pérez',
      curp: 'GODE561231HDFRRN09',
      puesto: 'Supervisor',
      marcaId: 'Marca Uno',
      agenciaId: String(new mongoose.Types.ObjectId()),
      avisoPrivacidadAceptado: true,
    },
  };
  const response = createResponse();
  let nextError;

  await createPublicRegistro(req, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'DATOS_INVALIDOS');
  assert.equal(req.auditRequestSummary.participantSubmission, true);
  assert.equal(JSON.stringify(req.auditRequestSummary).includes(req.body.curp), false);
  assert.equal(validateParticipant({ ...req.body, curp: 'GODE561231HDFRRN00' }).errors.curp, undefined);
});

test('exposes every active catalog brand and its agencies to each active public form', async (context) => {
  const originalFormFindOne = Formulario.findOne;
  const originalAgencyFind = Agency.find;
  context.after(() => {
    Formulario.findOne = originalFormFindOne;
    Agency.find = originalAgencyFind;
  });
  const form = {
    tokenPublico: 'C'.repeat(43),
    configuracionFechas: {
      fechaApertura: new Date('2020-01-01T00:00:00Z'),
      fechaCierre: new Date('2099-01-01T00:00:00Z'),
    },
    cancelacion: { cancelado: false },
  };
  Formulario.findOne = () => ({ lean: async () => form });
  const agencies = [
    { _id: new mongoose.Types.ObjectId(), nombre: 'Agencia Uno', brand: 'Marca Uno', marca: '' },
    { _id: new mongoose.Types.ObjectId(), nombre: 'Agencia Dos', brand: '', marca: 'Marca Dos' },
  ];
  let agenciesQuery;
  Agency.find = (query) => {
    agenciesQuery = query;
    return {
      select() { return this; },
      sort() { return this; },
      lean: async () => query.$or ? agencies : agencies.map(({ brand, marca }) => ({ brand, marca })),
    };
  };

  const brandsResponse = createResponse();
  await getPublicMarcas({ params: { token: form.tokenPublico } }, brandsResponse, (error) => { throw error; });
  assert.deepEqual(brandsResponse.body.data, [
    { id: 'Marca Dos', nombre: 'Marca Dos' },
    { id: 'Marca Uno', nombre: 'Marca Uno' },
  ]);

  const agenciesResponse = createResponse();
  await getPublicAgencias({
    params: { token: form.tokenPublico, marcaId: 'Marca Dos' },
  }, agenciesResponse, (error) => { throw error; });
  assert.equal(agenciesQuery.status, 'activa');
  assert.deepEqual(agenciesResponse.body.data, [{ id: String(agencies[1]._id), nombre: 'Agencia Dos' }]);
});

test('creates a participant snapshot and returns a controlled duplicate-registration error', async (context) => {
  const originals = [
    [Formulario, {
      findOne: Formulario.findOne,
      findOneAndUpdate: Formulario.findOneAndUpdate,
      updateOne: Formulario.updateOne,
    }],
    [Agency, { findOne: Agency.findOne }],
    [RegistroFormulario, { create: RegistroFormulario.create }],
  ];
  context.after(() => originals.forEach(([target, methods]) => {
    Object.entries(methods).forEach(([name, method]) => { target[name] = method; });
  }));

  const formId = new mongoose.Types.ObjectId();
  const agencyId = new mongoose.Types.ObjectId();
  const tokenPublico = 'B'.repeat(43);
  const form = {
    _id: formId,
    tokenPublico,
    nombreCurso: 'Seguridad industrial',
    areaTematica: 'Higiene y Seguridad',
    agenteCapacitador: 'ANA GARCÍA',
    configuracionFechas: {
      fechaApertura: new Date('2020-01-01T00:00:00Z'),
      fechaCierre: new Date('2099-01-01T00:00:00Z'),
      fechaInicioVigencia: new Date('2026-12-01T06:00:00Z'),
      fechaFinVigencia: new Date('2027-12-01T06:00:00Z'),
      duracionCursoHoras: 4,
    },
    revisionConfig: 1,
    cancelacion: { cancelado: false },
  };
  Formulario.findOne = () => ({ lean: async () => form });
  Formulario.findOneAndUpdate = () => ({ lean: async () => form });
  let reservationReleased = false;
  Formulario.updateOne = async () => {
    reservationReleased = true;
    return { matchedCount: 1 };
  };
  Agency.findOne = () => ({
    select() { return this; },
    lean: async () => ({
      _id: agencyId,
      nombre: 'Agencia Centro',
      razonSocial: 'Empresa de ejemplo',
      brand: 'Marca Uno',
    }),
  });
  let capturedRegistration;
  RegistroFormulario.create = async (data) => {
    capturedRegistration = data;
    throw Object.assign(new Error('duplicate key'), { code: 11000 });
  };

  const request = {
    params: { token: tokenPublico },
    body: {
      nombreCompleto: '  Juan   Pérez López ',
      curp: 'GODE561231HDFRRN00',
      puesto: ' Supervisor ',
      marcaId: 'Marca Uno',
      agenciaId: String(agencyId),
      avisoPrivacidadAceptado: true,
    },
  };
  const response = createResponse();
  let nextError;

  await createPublicRegistro(request, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'REGISTRO_DUPLICADO');
  assert.equal(capturedRegistration.trabajador.nombreCompleto, 'JUAN PÉREZ LÓPEZ');
  assert.equal(capturedRegistration.trabajador.puesto, 'SUPERVISOR');
  assert.equal(capturedRegistration.trabajador.agenteCapacitador, 'ANA GARCÍA');
  assert.equal(capturedRegistration.datosAgencia.nombreAgencia, 'Agencia Centro');
  assert.equal(capturedRegistration.datosConstancia.nombreCurso, 'Seguridad industrial');
  assert.equal(capturedRegistration.avisoPrivacidad.aceptado, true);
  assert.equal(reservationReleased, true);
  assert.equal(request.auditRequestSummary.curp, undefined);
});

test('declares unique duplicates by form, normalized CURP, and agency', () => {
  const indexes = RegistroFormulario.schema.indexes();
  const duplicateIndex = indexes.find(([keys]) => (
    keys.formularioId === 1 && keys['trabajador.curp'] === 1 && keys.agenciaId === 1
  ));
  assert.equal(duplicateIndex?.[1]?.unique, true);
});

test('computes programado, activo, cerrado and cancelado without a scheduled job', () => {
  const form = {
    configuracionFechas: {
      fechaApertura: new Date('2026-01-02T00:00:00Z'),
      fechaCierre: new Date('2026-01-03T00:00:00Z'),
    },
    cancelacion: { cancelado: false },
  };
  assert.equal(calculateFormStatus(form, new Date('2026-01-01T00:00:00Z')), 'programado');
  assert.equal(calculateFormStatus(form, new Date('2026-01-02T12:00:00Z')), 'activo');
  assert.equal(calculateFormStatus(form, new Date('2026-01-03T00:00:00Z')), 'cerrado');
  assert.equal(calculateFormStatus({ ...form, cancelacion: { cancelado: true } }), 'cancelado');
});
