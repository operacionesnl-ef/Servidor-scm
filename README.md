# Node.js + Express + MongoDB Base

## Instalación
```bash
npm install
```

## Variables de entorno
Copia `.env.example` a `.env` y configura tus variables.

## Scripts
```bash
npm run dev   # Desarrollo con nodemon
npm start     # Producción
```

## Envíos masivos en segundo plano
Habilita Gmail API en el mismo proyecto de Google Cloud que usa el front. La cuenta debe autorizar el permiso `https://www.googleapis.com/auth/gmail.send` la primera vez que envía un correo. Si la pantalla de consentimiento está en modo de pruebas, agrega esa cuenta como usuario de prueba.

El front solicita los permisos `gmail.send` y `drive.readonly`, valida los destinatarios y crea un trabajo en `POST /api/mail-jobs` con el JWT de sesión y el access token temporal de Google. El servidor comprueba que la cuenta Google verificada coincide con la cuenta de sesión y que los permisos necesarios estén concedidos.

Los trabajos y su avance se guardan en MongoDB. `GET /api/mail-jobs/active` recupera el trabajo activo y `GET /api/mail-jobs/:jobId` consulta uno específico; ambas rutas están limitadas al usuario dueño del trabajo. El navegador conserva solo el ID del trabajo para volver a consultar el estado después de recargar. El access token se cifra con AES-256-GCM usando una clave derivada de `JWT_SECRET`, no se devuelve por las rutas ni se escribe en logs, y el registro terminal se elimina después de 30 días.

El worker envía destinatarios en serie y guarda cada resultado. Si falla la autorización, la descarga de un adjunto o el envío, detiene el lote y deja los siguientes destinatarios como cancelados. Si el proceso Node se reinicia durante un correo, ese resultado se marca como no confirmado y los siguientes se cancelan para evitar duplicados; no se reintenta automáticamente un envío cuyo resultado sea ambiguo.

Mantén `JWT_SECRET` como secreto aleatorio, privado y estable entre reinicios. En producción, usa HTTPS y agrega el origen exacto del frontend a `CORS_ORIGINS`. Ejecuta `npm start` bajo un administrador de procesos (por ejemplo, systemd, PM2 o el servicio de contenedores) y conserva MongoDB disponible para persistir los trabajos.

## Actividad y recuperación
La consola imprime cada solicitud con usuario, ruta, estado, duración y datos de entrada sanitizados; tokens y contraseñas siempre se redactan. MongoDB guarda acciones de todos los usuarios en `ActivityLog`, asociadas al actor. Las lecturas repetidas iguales se agrupan durante un minuto; su contador evita llenar la colección con consultas de sondeo. Los registros caducan en 365 días por defecto; configura `ACTIVITY_LOG_RETENTION_DAYS` para cambiar el plazo.

`GET /api/activity?limit=50` lista tus acciones y usa `nextCursor` como `cursor`. `GET /api/activity/:id` consulta el detalle. Los borrados de agencias, plantillas y registros de correo incluyen un snapshot; el mismo usuario puede restaurarlo con `POST /api/activity/:id/restore`. Los envíos conservan además su historial detallado en `GET /api/maillogs/job/:jobId`.

Los snapshots facilitan recuperar registros borrados por la aplicación, pero no sustituyen los backups de MongoDB para corrupción, borrados directos en la base o incidentes que afecten también a la auditoría.

## Herramientas developer en desarrollo
Con `NODE_ENV=development`, las cuentas con rol `developer` pueden usar `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id` y `DELETE /api/users/:id` para consultar y administrar accesos. La eliminación es lógica y cambia `status` a `inactivo`; no se permite desactivar la propia cuenta ni dejar el sistema sin un developer activo.

El visor consulta `GET /api/activity/server?source=activity&limit=50` para paginar auditorías de solicitudes de todos los usuarios; `source=events` selecciona eventos operativos `ServerEvent`. Ambos feeds aceptan `cursor`. Las APIs responden `404` fuera de desarrollo y requieren un JWT válido cuyo usuario tenga rol `developer`. La autorización del servidor es obligatoria aunque el frontend también oculte las rutas.

## Estructura
```
src/
├── config/         # DB y variables de entorno
├── controllers/    # Lógica de cada recurso
├── middlewares/    # Error handler, notFound
├── models/         # Schemas de Mongoose
├── routes/         # Definición de rutas
└── utils/          # Helpers reutilizables
logs/               # Logs del servidor
```
