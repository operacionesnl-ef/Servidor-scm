'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const Agency = require('../src/models/Agency');
const Formulario = require('../src/models/Formulario');
const RegistroFormulario = require('../src/models/RegistroFormulario');
const { exportFormularioRegistros } = require('../src/controllers/formularioController');

test('exports the saved agency RFC or falls back to the current agency RFC for older registrations', async (context) => {
  const originals = [
    [Formulario, { findById: Formulario.findById }],
    [RegistroFormulario, {
      distinct: RegistroFormulario.distinct,
      find: RegistroFormulario.find,
    }],
    [Agency, { find: Agency.find }],
    [ExcelJS.stream.xlsx, { WorkbookWriter: ExcelJS.stream.xlsx.WorkbookWriter }],
  ];
  context.after(() => originals.forEach(([target, methods]) => {
    Object.entries(methods).forEach(([name, method]) => { target[name] = method; });
  }));

  const formularioId = new mongoose.Types.ObjectId();
  const agencyId = new mongoose.Types.ObjectId();
  const exportedRows = [];
  let worksheet;
  Formulario.findById = () => ({
    select() { return this; },
    lean: async () => ({
      tituloCurso: 'Seguridad industrial',
      nombreCurso: 'Curso completo DC3',
      areaTematica: 'Seguridad',
      agenteCapacitador: 'Agente capacitador',
      configuracionFechas: {
        fechaCurso: new Date('2026-07-08T12:00:00.000Z'),
        fechaFinVigencia: new Date('2027-07-08T12:00:00.000Z'),
      },
    }),
  });
  RegistroFormulario.distinct = async (field) => {
    assert.equal(field, 'agenciaId');
    return [agencyId];
  };
  const registros = [
    {
      formularioId,
      agenciaId: agencyId,
      marcaId: 'Marca Uno',
      trabajador: {
        nombreCompleto: 'Participante uno',
        curp: 'GODE561231HDFRRN00',
        puesto: 'Supervisor',
        agenteCapacitador: 'Agente capacitador',
      },
      datosAgencia: { nombreAgencia: 'Agencia Centro', razonSocial: '', rfc: '' },
      datosConstancia: {
        nombreCurso: 'Curso completo DC3',
        areaTematica: 'Seguridad',
        fechaInicioVigencia: new Date('2026-07-08T12:00:00.000Z'),
        fechaFinVigencia: new Date('2027-07-08T12:00:00.000Z'),
      },
      fechaRegistro: new Date('2026-11-20T12:00:00.000Z'),
      estado: 'valido',
    },
    {
      formularioId,
      agenciaId: agencyId,
      marcaId: 'Marca Uno',
      trabajador: {
        nombreCompleto: 'Participante dos',
        curp: 'GODE561231HDFRRN00',
        puesto: 'Supervisor',
        agenteCapacitador: 'Agente capacitador',
      },
      datosAgencia: { nombreAgencia: 'Agencia Centro', razonSocial: '', rfc: 'RFC-HISTORICO' },
      datosConstancia: {
        nombreCurso: 'Curso completo DC3',
        areaTematica: 'Seguridad',
        fechaInicioVigencia: new Date('2026-07-08T12:00:00.000Z'),
        fechaFinVigencia: new Date('2027-07-08T12:00:00.000Z'),
      },
      fechaRegistro: new Date('2026-11-19T12:00:00.000Z'),
      estado: 'valido',
    },
  ];
  RegistroFormulario.find = () => ({
    sort() { return this; },
    lean() { return this; },
    cursor() {
      return {
        async *[Symbol.asyncIterator]() {
          yield* registros;
        },
      };
    },
  });
  Agency.find = () => ({
    select(fields) {
      assert.equal(fields, '_id rfc RFC');
      return this;
    },
    lean: async () => [{ _id: agencyId, rfc: 'ABC010203XYZ' }],
  });
  ExcelJS.stream.xlsx.WorkbookWriter = class {
    addWorksheet() {
      worksheet = {
        getRow: () => ({}),
        addRow(row) {
          exportedRows.push(row);
          return { commit() {} };
        },
        commit() {},
      };
      return worksheet;
    }

    async commit() {}
  };

  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      this.headers = headers;
      return this;
    },
  };
  let nextError;
  await exportFormularioRegistros({
    params: { id: String(formularioId) },
    query: {},
  }, response, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(response.statusCode, 200);
  assert.equal(exportedRows[0].rfc, 'ABC010203XYZ');
  assert.equal(exportedRows[1].rfc, 'RFC-HISTORICO');
  const expectedKeys = [
    'nombre',
    'curp',
    'puesto',
    'marca',
    'agencia',
    'razonSocial',
    'rfc',
    'nombreCurso',
    'areaTematica',
    'agenteCapacitador',
    'fechaInicio',
    'fechaFin',
    'duracion',
  ];
  assert.deepEqual(worksheet.columns.map((column) => column.key), expectedKeys);
  assert.deepEqual(worksheet.columns.map((column) => column.header), [
    'Nombre',
    'CURP',
    'Puesto',
    'Marca',
    'Agencia',
    'Razón social',
    'RFC',
    'Nombre DC3 completo',
    'Área temática',
    'Agente capacitador',
    'Fecha inicio',
    'Fecha fin',
    'Duración',
  ]);
  assert.deepEqual(Object.keys(exportedRows[0]), expectedKeys);
  assert.deepEqual(
    [exportedRows[0].nombreCurso, exportedRows[0].areaTematica, exportedRows[0].agenteCapacitador],
    ['Curso completo DC3', 'Seguridad', 'Agente capacitador'],
  );
  assert.deepEqual(
    [exportedRows[0].fechaInicio, exportedRows[0].fechaFin, exportedRows[0].duracion],
    ['07/08/2026', '07/08/2027', '8 horas'],
  );
});
