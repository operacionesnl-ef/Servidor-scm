const mongoose = require('mongoose');
const { publishNotificationChange } = require('../services/notificationEvents');

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
    nombre: { type: String, required: true, trim: true },
    razonSocial: { type: String, trim: true },
    RFC: { type: String, trim: true, uppercase: true, maxlength: 13, default: '' },
    direccion: { type: String, trim: true },
    ciudad: { type: String, trim: true, maxlength: 200, default: '' },
    longitud: { type: Number, min: -180, max: 180 },
    latitud: { type: Number, min: -90, max: 90 },
    correo: { type: String, required: false, lowercase: true, trim: true },
    gerente: { type: String, trim: true, maxlength: 120 },
    telefonoGerente: { type: String, trim: true, maxlength: 40 },
    seguimiento: { type: String, trim: true, maxlength: 4000 },
    cc: { type: [String], default: [] },
    cco: { type: [String], default: [] },
    entidadFederativa: { type: String, required: true, trim: true },
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    marca: { type: String, trim: true, maxlength: 80, default: '' },
    fileNameCode: { type: String, trim: true, maxlength: 60, default: '' },
    reviewPeriods: {
      type: Map,
      of: new mongoose.Schema({
        intervalMonths: { type: Number, min: 1, max: 120, default: 1 },
        startPeriod: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/, default: '' },
      }, { _id: false }),
      default: () => new Map(),
    },
    status: {
      type: String,
      enum: ['activa', 'inactiva', 'suspendida'],
      default: 'activa',
    },
    favorite: { type: Boolean, default: false },
    consultantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AgencyTag' }],
    personalizationMigrated: { type: Boolean, default: false, select: false },
    archivos: {
      carpetaPrincipal: { type: String, trim: true },
      carpetaBase: { type: String, trim: true },
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
