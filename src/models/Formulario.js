const mongoose = require('mongoose');

const CAMPOS_PARTICIPANTE = ['nombreCompleto', 'curp', 'puesto', 'marca', 'agencia'];
const DEFAULT_AGENT = 'Ing. Erick Fernando Zapata, Lic. Arturo Moreno Chapa';

const configuracionFechasSchema = new mongoose.Schema(
  {
    fechaApertura: { type: Date, required: true },
    fechaCierre: { type: Date, required: true },
    fechaCurso: { type: Date, required: true },
    fechaFinVigencia: { type: Date, required: true },
    duracionCursoHoras: { type: Number, required: true, min: 0.1, default: 8 },
  },
  { _id: false }
);

const cancelacionSchema = new mongoose.Schema(
  {
    cancelado: { type: Boolean, default: false },
    canceladoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fechaCancelacion: { type: Date, default: null },
    motivo: { type: String, trim: true, maxlength: 500, default: null },
  },
  { _id: false }
);

const formularioSchema = new mongoose.Schema(
  {
    tituloCurso: { type: String, required: true, trim: true, maxlength: 120 },
    nombreCurso: { type: String, required: true, trim: true, maxlength: 120 },
    areaTematica: { type: String, required: true, trim: true, maxlength: 120 },
    descripcion: { type: String, trim: true, maxlength: 1000, default: '' },
    agenteCapacitador: { type: String, trim: true, maxlength: 160, default: DEFAULT_AGENT },
    configuracionFechas: { type: configuracionFechasSchema, required: true },
    camposParticipante: {
      type: [{ type: String, enum: CAMPOS_PARTICIPANTE }],
      required: true,
      default: CAMPOS_PARTICIPANTE,
      immutable: true,
    },
    tokenPublico: { type: String, required: true, unique: true, index: true, immutable: true },
    codigoCorto: { type: String, maxlength: 16 },
    estado: { type: String, enum: ['programado', 'activo', 'cerrado', 'cancelado'], default: 'programado' },
    cantidadParticipantes: { type: Number, min: 0, default: 0 },
    revisionConfig: { type: Number, min: 1, default: 1 },
    cancelacion: { type: cancelacionSchema, default: () => ({}) },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    actualizadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'formularios',
    timestamps: { createdAt: 'fechaCreacion', updatedAt: 'fechaActualizacion' },
  }
);

formularioSchema.index({ fechaCreacion: -1 });
formularioSchema.index({ 'configuracionFechas.fechaApertura': 1, 'configuracionFechas.fechaCierre': 1, 'cancelacion.cancelado': 1 });
formularioSchema.index({ codigoCorto: 1 }, { unique: true, sparse: true });

const Formulario = mongoose.model('Formulario', formularioSchema);
Formulario.CAMPOS_PARTICIPANTE = CAMPOS_PARTICIPANTE;
Formulario.DEFAULT_AGENT = DEFAULT_AGENT;

module.exports = Formulario;
