const mongoose = require('mongoose');

/* ── Archivo global: mismo adjunto para todas las agencias ── */
const archivoGlobalSchema = new mongoose.Schema(
  {
    label:   { type: String, required: true, trim: true }, // ej. 'Circular general'
    driveId: { type: String, required: true, trim: true }, // Drive file ID
    nombre:  { type: String, required: true, trim: true }, // nombre visible del archivo
  },
  { _id: false }
);

/* ── Variables disponibles para usar en asunto y cuerpo ── */
const VARIABLES_DISPONIBLES = ['{{MES}}', '{{AÑO}}', '{{SUCURSAL}}'];

/* ── Códigos de archivos individuales (por agencia) ── */
const CODIGOS_ARCHIVOS = ['ANX', 'FOR', 'REP', 'REV'];

const templateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      // ej. 'correo1', 'correo2', 'correo3'…
    },

    nombre: {
      type: String,
      required: true,
      trim: true,
      // ej. 'Ambiental', 'Seguridad y Salud'
    },

    asunto: {
      type: String,
      trim: true,
      default: '',
      // Puede contener {{MES}}, {{AÑO}}, {{SUCURSAL}}
    },

    cc: { type: [String], default: [] },
    cco: { type: [String], default: [] },

    cuerpo: {
      type: String,
      default: '',
      // Texto plano con variables {{MES}}, {{AÑO}}, {{SUCURSAL}}
      // El front renderiza con saltos de línea
    },

    /*
     * Archivos del registro de cada agencia que esta plantilla adjunta.
     * archivo1 → ANX, archivo2 → FOR, archivo3 → REP, archivo4 → REV
     * El array indica cuáles de los 4 se adjuntan al enviar.
     */
    archivosIndividuales: {
      type: [{ type: String, enum: CODIGOS_ARCHIVOS }],
      default: [],
    },

    /*
     * Archivos fijos que se adjuntan igual a todas las agencias.
     * Se elige desde Drive en el editor de plantillas.
     */
    archivosGlobales: {
      type: [archivoGlobalSchema],
      default: [],
    },

    activa: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

/* ── Statics de utilidad ── */
templateSchema.statics.VARIABLES_DISPONIBLES = VARIABLES_DISPONIBLES;
templateSchema.statics.CODIGOS_ARCHIVOS = CODIGOS_ARCHIVOS;

/*
 * Resuelve las variables de texto dado un contexto.
 * context: { mes, año, sucursal }
 */
templateSchema.methods.resolverTexto = function (texto = '', context = {}) {
  return texto
    .replace(/{{MES}}/g,      context.mes      || '')
    .replace(/{{AÑO}}/g,      context.año       || '')
    .replace(/{{SUCURSAL}}/g, context.sucursal  || '');
};

module.exports = mongoose.model('Template', templateSchema);