const mongoose = require('mongoose');

const trabajadorSchema = new mongoose.Schema(
  {
    nombreCompleto: { type: String, required: true, trim: true, maxlength: 160 },
    curp: { type: String, required: true, trim: true, minlength: 18, maxlength: 18 },
    puesto: { type: String, required: true, trim: true, maxlength: 120 },
    agenteCapacitador: { type: String, required: true, trim: true, maxlength: 160 },
  },
  { _id: false }
);

const datosAgenciaSchema = new mongoose.Schema(
  {
    nombreAgencia: { type: String, required: true },
    razonSocial: { type: String, default: '' },
    rfc: { type: String, default: '' },
  },
  { _id: false }
);

const datosConstanciaSchema = new mongoose.Schema(
  {
    tituloCurso: { type: String, required: true },
    nombreCurso: { type: String, required: true },
    areaTematica: { type: String, required: true },
    norma: { type: String, default: '' },
    fechaInicioVigencia: { type: Date, required: true },
    fechaFinVigencia: { type: Date, required: true },
    duracionHoras: { type: Number, required: true },
  },
  { _id: false }
);

const revisionSchema = new mongoose.Schema(
  {
    revisadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fechaRevision: { type: Date, default: null },
    motivo: { type: String, trim: true, maxlength: 500, default: null },
  },
  { _id: false }
);

const registroFormularioSchema = new mongoose.Schema(
  {
    formularioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Formulario', required: true },
    trabajador: { type: trabajadorSchema, required: true },
    marcaId: { type: String, required: true },
    agenciaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
    datosAgencia: { type: datosAgenciaSchema, required: true },
    datosConstancia: { type: datosConstanciaSchema, required: true },
    avisoPrivacidad: {
      aceptado: { type: Boolean, required: true, enum: [true] },
      fechaAceptacion: { type: Date, required: true },
      version: { type: String, required: true },
    },
    estado: { type: String, enum: ['valido', 'invalidado'], default: 'valido' },
    fechaRegistro: { type: Date, default: Date.now, immutable: true },
    revision: { type: revisionSchema, default: () => ({}) },
  },
  { collection: 'registros_formularios' }
);

registroFormularioSchema.index(
  { formularioId: 1, 'trabajador.curp': 1, agenciaId: 1 },
  { unique: true }
);
registroFormularioSchema.index({ formularioId: 1, fechaRegistro: -1 });
registroFormularioSchema.index({ formularioId: 1, marcaId: 1, agenciaId: 1, fechaRegistro: -1 });
registroFormularioSchema.index({ formularioId: 1, 'trabajador.nombreCompleto': 1 });

module.exports = mongoose.model('RegistroFormulario', registroFormularioSchema);
