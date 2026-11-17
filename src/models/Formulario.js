const mongoose = require('mongoose');

const CAMPOS_PARTICIPANTE = ['nombreCompleto', 'curp', 'puesto', 'marca', 'agencia'];

const duracionFormularioSchema = new mongoose.Schema(
  {
    valor: { type: Number, required: true, min: 0 },
    unidad: { type: String, enum: ['horas', 'dias', 'semanas'], required: true },
  },
  { _id: false }
);

const configuracionFechasSchema = new mongoose.Schema(
  {
    fechaApertura: { type: Date, required: true },
    duracionFormulario: { type: duracionFormularioSchema, required: true },
    fechaCierre: { type: Date, required: true },
    fechaInicioVigencia: { type: Date, required: true },
    fechaFinVigencia: { type: Date, required: true },
    duracionCursoHoras: { type: Number, required: true, min: 0 },
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
    nombreCurso: { type: String, required: true, trim: true, maxlength: 120 },
    areaTematica: { type: String, required: true, trim: true, maxlength: 120 },
    descripcion: { type: String, trim: true, maxlength: 1000, default: '' },
    agenteCapacitador: { type: String, trim: true, maxlength: 160, default: '' },
    configuracionFechas: { type: configuracionFechasSchema, required: true },
    camposParticipante: {
      type: [{ type: String, enum: CAMPOS_PARTICIPANTE }],
      required: true,
      default: CAMPOS_PARTICIPANTE,
      immutable: true,
    },
    tokenPublico: { type: String, required: true, unique: true, index: true, immutable: true },
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

const Formulario = mongoose.model('Formulario', formularioSchema);
Formulario.CAMPOS_PARTICIPANTE = CAMPOS_PARTICIPANTE;

module.exports = Formulario;
