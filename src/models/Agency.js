const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

const archivoSchema = new mongoose.Schema(
  {
    nombre: { type: String, trim: true },
    ruta:   { type: String, trim: true },
    driveId: { type: String, trim: true },
    pseudoPath: { type: [String], default: undefined },
    path: { type: String, trim: true, maxlength: 4096 },
    periodYear: { type: Number, min: 1900, max: 2100 },
    periodMonth: { type: Number, min: 1, max: 12 },
  },
  { _id: false }
);

// Patrón aprendido por archivo: guarda la ruta relativa tokenizada
const drivePatternEntrySchema = new mongoose.Schema(
  {
    // Ruta relativa desde carpetaPrincipal, con tokens {year}, {month}, {monthName}, {code}
    // Ejemplo: "2025/mayo/REP_mayo_2025.pdf"  →  "{year}/{monthName}/{code}_{monthName}_{year}.pdf"
    relativePath: { type: [String] }, // array de segmentos de carpeta hasta el archivo
    basePath: { type: [String] }, // ruta estable absoluta desde Mi unidad hasta carpetaPrincipal
    lastSeenPath: { type: [String] }, // ruta real completa desde Mi unidad, incluido el nombre del archivo
    fileNamePattern: { type: String, trim: true }, // patrón del nombre del archivo
    lastSeenName: { type: String, trim: true },     // último nombre real visto (para fallback)
    lastSeenRuta: { type: String, trim: true },     // último ID de Drive conocido
    confidence: { type: Number, default: 0 },       // 0-1, sube cada vez que se confirma
  },
  { _id: false }
);

const agencySchema = new mongoose.Schema(
  {
    nombre:             { type: String, required: true, trim: true },
    correo:             { type: String, required: true, lowercase: true, trim: true },
    cc: { type: [String], default: [] },
    cco: { type: [String], default: [] },
    entidadFederativa:  { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['activa', 'inactiva', 'suspendida'],
      default: 'activa',
    },
    archivos: {
      carpetaPrincipal: { type: String, trim: true },
      carpetaBase: { type: String, trim: true },
      archivo1: archivoSchema, //ANX
      archivo2: archivoSchema, //FOR
      archivo3: archivoSchema, //REP
      archivo4: archivoSchema, //REV
    },
    // Mapa aprendido: una entrada por cada archivoN
    drivePattern: {
      archivo1: drivePatternEntrySchema,
      archivo2: drivePatternEntrySchema,
      archivo3: drivePatternEntrySchema,
      archivo4: drivePatternEntrySchema,
    },
  },
  { timestamps: true }
);

agencySchema.post('save', publishNotificationChange);
agencySchema.post('findOneAndUpdate', publishNotificationChange);
agencySchema.post('findOneAndDelete', publishNotificationChange);
agencySchema.post('updateOne', publishNotificationChange);
agencySchema.post('deleteOne', publishNotificationChange);

module.exports = mongoose.model('Agency', agencySchema);
