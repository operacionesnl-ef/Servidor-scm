const mongoose = require('mongoose');

/* ── Resultado individual por agencia ── */
const recipientResultSchema = new mongoose.Schema(
  {
    agencyId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Agency', required: true },
    agencyName: { type: String, required: true, trim: true },
    correo:     { type: String, required: true, trim: true },
    cc:         { type: [String], default: [] },
    cco:        { type: [String], default: [] },
    status:     { type: String, enum: ['sent', 'failed'], required: true },
    gmailMessageId: { type: String, trim: true }, // ID devuelto por Gmail API
    error:      { type: String, trim: true },      // mensaje de error si status === 'failed'
    /* Archivos individuales que se adjuntaron a esta agencia */
    attachedFiles: {
      type: [
        {
          code:    { type: String, trim: true },  // ANX, FOR, REP, REV
          driveId: { type: String, trim: true },
          nombre:  { type: String, trim: true },
        },
      ],
      default: [],
    },
  },
  { _id: false }
);

/* ── Archivo global adjuntado a todos ── */
const globalAttachmentSchema = new mongoose.Schema(
  {
    driveId: { type: String, trim: true },
    nombre:  { type: String, trim: true },
  },
  { _id: false }
);

const mailLogSchema = new mongoose.Schema(
  {
    mailJobId: { type: mongoose.Schema.Types.ObjectId, sparse: true, index: true },
    /* ── Quién envió ── */
    sentBy: {
      type: String,
      trim: true,
      default: 'sistema',
      // Puede ser el email del usuario logueado en el futuro
    },

    /* ── Plantilla usada ── */
    templateKey:  { type: String, required: true, trim: true },
    templateName: { type: String, required: true, trim: true },

    /* ── Periodo al que aplica (opcional, útil para filtrar) ── */
    year:  { type: Number, min: 1900, max: 2100 },
    month: { type: Number, min: 1,    max: 12   },

    /* ── Asunto y cuerpo resueltos (ya con variables sustituidas) ── */
    asuntoResuelto: { type: String, trim: true },
    cuerpoResuelto: { type: String },

    /* ── Archivos globales adjuntados ── */
    archivosGlobales: { type: [globalAttachmentSchema], default: [] },

    /* ── Resultados por agencia ── */
    recipients: { type: [recipientResultSchema], default: [] },

    /* ── Resumen calculado al guardar ── */
    totalEnviados: { type: Number, default: 0 },
    totalFallidos: { type: Number, default: 0 },

    /* ── Estado general del lote ── */
    batchStatus: {
      type: String,
      enum: ['completed', 'completed-with-errors', 'failed'],
      default: 'completed',
    },
  },
  { timestamps: true }
);

/* ── Pre-save: calcula resumen y estado ── */
mailLogSchema.pre('save', function (next) {
  this.totalEnviados = this.recipients.filter((r) => r.status === 'sent').length;
  this.totalFallidos = this.recipients.filter((r) => r.status === 'failed').length;

  if (this.totalEnviados === 0) {
    this.batchStatus = 'failed';
  } else if (this.totalFallidos > 0) {
    this.batchStatus = 'completed-with-errors';
  } else {
    this.batchStatus = 'completed';
  }

  next();
});

/* ── Índices para consultas frecuentes ── */
mailLogSchema.index({ templateKey: 1, createdAt: -1 });
mailLogSchema.index({ 'recipients.agencyId': 1, createdAt: -1 });
mailLogSchema.index({ year: 1, month: 1, createdAt: -1 });
mailLogSchema.index({ batchStatus: 1 });
mailLogSchema.index({ sentBy: 1, createdAt: -1 });

module.exports = mongoose.model('MailLog', mailLogSchema);