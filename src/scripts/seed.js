/**
 * seed.js — Script de datos de prueba
 * Uso: node src/scripts/seed.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const User = require('../models/User');
const Agency = require('../models/Agency');
const SentEmail = require('../models/SentEmail');
const Template = require('../models/Template');
const ActivityLog = require('../models/ActivityLog');

// ─── Helpers ────────────────────────────────────────────
const randomToken = () => crypto.randomBytes(32).toString('hex');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const ENTIDADES = [
  'Aguascalientes', 'Baja California', 'Chihuahua', 'Ciudad de México',
  'Jalisco', 'Nuevo León', 'Oaxaca', 'Puebla', 'Sonora', 'Veracruz',
];

const ACCIONES = [
  'login', 'logout', 'crear_agencia', 'editar_agencia',
  'enviar_correo', 'subir_archivo', 'actualizar_plantilla', 'ver_historial',
];

const EMAIL_STATUS = ['enviado', 'fallido', 'pendiente', 'rebotado'];

// ─── Seed ───────────────────────────────────────────────
async function seed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The seed script cannot run in production');
  }
  if (process.env.RESET_DATABASE !== 'true') {
    throw new Error('This script deletes existing data. Set RESET_DATABASE=true to confirm the reset');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('🔌 Conectado a MongoDB');

  // Eliminar índices viejos y limpiar colecciones
  const dropIndex = async (model, index) => {
    try {
      await model.collection.dropIndex(index);
    } catch (_) { /* no existe, ignorar */ }
  };

  await dropIndex(User, 'email_1');   // índice viejo si el campo se llamaba email

  await Promise.all([
    User.deleteMany({}),
    Agency.deleteMany({}),
    SentEmail.deleteMany({}),
    Template.deleteMany({}),
    ActivityLog.deleteMany({}),
  ]);

  // Sincronizar índices actuales de los modelos
  await Promise.all([
    User.syncIndexes(),
    Agency.syncIndexes(),
    SentEmail.syncIndexes(),
    Template.syncIndexes(),
    ActivityLog.syncIndexes(),
  ]);

  console.log('🗑️  Colecciones limpiadas e índices sincronizados');

  // ── Usuarios ──────────────────────────────────────────
  const usersData = [
    { nombre: 'Ana García',      correo: 'ana.garcia@ejemplo.com',      rol: 'developer', status: 'activo' },
    { nombre: 'Carlos López',    correo: 'carlos.lopez@ejemplo.com',    rol: 'admin',     status: 'activo' },
    { nombre: 'María Rodríguez', correo: 'maria.rodriguez@ejemplo.com', rol: 'user',      status: 'inactivo' },
    { nombre: 'Jorge Martínez',  correo: 'jorge.martinez@ejemplo.com',  rol: 'user',      status: 'activo' },
    { nombre: 'Laura Sánchez',   correo: 'laura.sanchez@ejemplo.com',   rol: 'user',      status: 'suspendido' },
  ];

  const users = await User.insertMany(
    usersData.map((u) => ({
      ...u,
      autenticacion: {
        proveedor: pick(['local', 'google', 'microsoft']),
        passwordHash: crypto.createHash('sha256').update('password123').digest('hex'),
        ultimoAcceso: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
      },
      tokenUnico: randomToken(),
    }))
  );
  console.log(`👤 ${users.length} usuarios creados`);

  // ── Agencias ──────────────────────────────────────────
  const agenciasData = [
    { nombre: 'Agencia Norte',    correo: 'norte@agencias.mx' },
    { nombre: 'Agencia Sur',      correo: 'sur@agencias.mx' },
    { nombre: 'Agencia Centro',   correo: 'centro@agencias.mx' },
    { nombre: 'Agencia Bajío',    correo: 'bajio@agencias.mx' },
    { nombre: 'Agencia Pacífico', correo: 'pacifico@agencias.mx' },
    { nombre: 'Agencia Golfo',    correo: 'golfo@agencias.mx' },
  ];

  const agencies = await Agency.insertMany(
    agenciasData.map((a, i) => ({
      ...a,
      entidadFederativa: pick(ENTIDADES),
      status: pick(['activa', 'activa', 'activa', 'inactiva', 'suspendida']),
      archivos: {
        carpetaPrincipal: `/documentos/agencias/${a.nombre.toLowerCase().replace(/ /g, '_')}`,
        archivo1: { nombre: 'Convenio.pdf',       ruta: `/docs/agencia_${i + 1}/convenio.pdf` },
        archivo2: { nombre: 'Contrato.pdf',       ruta: `/docs/agencia_${i + 1}/contrato.pdf` },
        archivo3: { nombre: 'Identificacion.jpg', ruta: `/docs/agencia_${i + 1}/id.jpg` },
        archivo4: { nombre: 'Comprobante.pdf',    ruta: `/docs/agencia_${i + 1}/comprobante.pdf` },
      },
    }))
  );
  console.log(`🏢 ${agencies.length} agencias creadas`);

  // ── Plantilla ─────────────────────────────────────────
  await Template.insertMany([
    {
      plantillaCorreo1: {
        asunto: 'Bienvenido a nuestra plataforma',
        cuerpoHtml: '<h1>Hola {{nombre}}</h1><p>Tu cuenta ha sido creada exitosamente.</p>',
        cuerpoTexto: 'Hola {{nombre}}, tu cuenta ha sido creada exitosamente.',
      },
      plantillaCorreo2: {
        asunto: 'Documentos recibidos - {{agencia}}',
        cuerpoHtml: '<h1>Documentación recibida</h1><p>Hemos recibido los archivos de {{agencia}} para {{mes}}/{{anio}}.</p>',
        cuerpoTexto: 'Hemos recibido los archivos de {{agencia}} para {{mes}}/{{anio}}.',
      },
      version: '1.0',
      activa: true,
    },
  ]);
  console.log('📄 Plantilla creada');

  // ── Correos Enviados ──────────────────────────────────
  const meses = [1, 2, 3, 4, 5, 6];
  const sentEmailsData = [];

  for (const agency of agencies) {
    for (const mes of meses) {
      sentEmailsData.push({
        agencia: agency._id,
        correo1Status: pick(EMAIL_STATUS),
        correo2Status: pick(EMAIL_STATUS),
        mes,
        anio: 2025,
        fechaEnvio: new Date(2025, mes - 1, pick([5, 10, 15, 20])),
        correoOrigen: 'sistema@plataforma.mx',
        error: Math.random() > 0.8
          ? 'SMTP timeout: conexión rechazada por servidor remoto'
          : null,
      });
    }
  }

  const emails = await SentEmail.insertMany(sentEmailsData);
  console.log(`📧 ${emails.length} correos enviados creados`);

  // ── Historial de actividad ────────────────────────────
  const logsData = Array.from({ length: 30 }, (_, i) => {
    const accion = pick(ACCIONES);
    return {
      usuario: pick(users)._id,
      accion,
      detalle: {
        descripcion: `El usuario ejecutó: ${accion}`,
        referencia: `REF-${1000 + i}`,
      },
      fecha: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
      ip: `192.168.${Math.floor(Math.random() * 5)}.${Math.floor(Math.random() * 255)}`,
    };
  });

  const activity = await ActivityLog.insertMany(logsData);
  console.log(`📋 ${activity.length} registros de actividad creados`);

  // ─── Resumen ──────────────────────────────────────────
  console.log('\n✅ Seed completado:');
  console.log(`   Usuarios:    ${users.length}`);
  console.log(`   Agencias:    ${agencies.length}`);
  console.log(`   Plantillas:  1`);
  console.log(`   Correos:     ${emails.length}`);
  console.log(`   Actividad:   ${activity.length}`);

  await mongoose.disconnect();
  console.log('🔌 Desconectado\n');
}

seed().catch((err) => {
  console.error('❌ Error en seed:', err);
  process.exit(1);
});