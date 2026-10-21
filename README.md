# Node.js + Express + MongoDB Base

## Instalación
```bash
npm install
```

## Monitor de disponibilidad

Configura UptimeRobot con un monitor **HTTP(s)** para `https://<tu-dominio>/health`, método `GET` y un intervalo de revisión adecuado para tu plan. La ruta es pública y devuelve `200` con `status: "ok"` cuando el proceso está activo y conectado a MongoDB; si la conexión a la base de datos se pierde, devuelve `503` con `status: "degraded"` para que el monitor marque el servicio como no disponible. La respuesta incluye `timestamp`, `uptimeSeconds` y el estado de MongoDB.

## Variables de entorno
Copia `.env.example` a `.env` y configura tus variables.

La conexión de MongoDB acepta `MONGO_URI` o `MONGODB_URI` y usa la base definida por `MONGODB_DATABASE` (por defecto `EFCore`). Configura `MONGODB_DATABASE=EFCore` en Render y conserva el URI de Atlas en su variable actual. La base de datos se crea automáticamente cuando MongoDB guarda el primer documento. El servidor seguirá usando colecciones separadas por modelo (por ejemplo, `agencies`, `users` y `maillogs`); `EFCore` es el nombre de la base de datos, no de una colección única.

## Scripts
```bash
npm run dev   # Desarrollo con nodemon
npm start     # Producción
```

## Envíos masivos en segundo plano
Habilita Gmail API en el mismo proyecto de Google Cloud que usa el front. La cuenta debe autorizar el permiso `https://www.googleapis.com/auth/gmail.send` la primera vez que envía un correo. Si la pantalla de consentimiento está en modo de pruebas, agrega esa cuenta como usuario de prueba.

Las plantillas y cada agencia admiten hasta 20 direcciones CC y 20 CCO; al enviar se combinan ambas configuraciones por agencia, se normalizan y deduplican, y las CCO se transmiten como encabezado Bcc.

Las plantillas también indican cuáles archivos individuales de agencia son opcionales. El servidor omite esos archivos cuando la agencia no los tiene y sigue rechazando el envío si falta un archivo marcado como obligatorio.

El front solicita los permisos `gmail.send` y `drive.readonly`, valida los destinatarios y crea un trabajo en `POST /api/mail-jobs` con la sesión autenticada y el access token temporal de Google. La sesión se envía mediante cookie segura. El servidor comprueba que la cuenta Google verificada coincide con la cuenta de sesión y que los permisos necesarios estén concedidos.

Los trabajos y su avance se guardan en MongoDB. `GET /api/mail-jobs/active` recupera el trabajo activo y `GET /api/mail-jobs/:jobId` consulta uno específico; ambas rutas están limitadas al usuario dueño del trabajo. El navegador conserva solo el ID del trabajo para volver a consultar el estado después de recargar. El access token se cifra con AES-256-GCM usando una clave derivada de `JWT_SECRET`, no se devuelve por las rutas ni se escribe en logs, y el registro terminal se elimina después de 30 días.

El worker envía destinatarios en serie y guarda cada resultado. Si falla la autorización, la descarga de un adjunto o el envío, detiene el lote y deja los siguientes destinatarios como cancelados. Si el proceso Node se reinicia durante un correo, ese resultado se marca como no confirmado y los siguientes se cancelan para evitar duplicados; no se reintenta automáticamente un envío cuyo resultado sea ambiguo.

Mantén `JWT_SECRET` como secreto aleatorio, privado y estable entre reinicios. En producción, usa HTTPS y agrega el origen exacto del frontend a `CORS_ORIGINS`. La aplicación web inicia sesión en `POST /api/auth/google/session` y usa cookies `HttpOnly`, `Secure` y `SameSite=Lax`; enruta `/api/*` por un proxy del mismo origen para que el navegador no dependa de cookies de terceros. El servidor conserva únicamente el hash de cada secreto de sesión en MongoDB, aplica vencimiento absoluto de 12 horas e inactividad de 30 minutos, y permite revocar la sesión al cerrar sesión. El endpoint anterior `POST /api/auth/google` continúa emitiendo JWT `client=legacy` durante la migración de clientes; los JWT anteriores a este cambio se invalidan y requieren iniciar sesión otra vez. Ejecuta `npm start` bajo un administrador de procesos (por ejemplo, systemd, PM2 o el servicio de contenedores) y conserva MongoDB disponible para persistir sesiones y trabajos.

## Actualización de archivos de agencias
El front solicita el permiso `https://www.googleapis.com/auth/drive.readonly` y crea una tarea con `POST /api/agencies/refresh-jobs`, enviando los IDs de agencia, el período y el access token temporal de Google. El servidor valida el permiso, cifra el token y recorre las carpetas de Drive desde Node; los descendientes ya no se envían desde el navegador.

Los archivos se guardan únicamente en `AgencyMonthlyFiles`, una colección separada con un registro único por agencia y período (`YYYY-MM`). Se almacena metadata y referencia de Drive, nunca copias binarias. `Agency.archivos` contiene solamente `carpetaPrincipal` y `carpetaBase`; los documentos mensuales no duplican esos campos. El expediente usa `GET/PUT /api/agencies/:id/monthly-files/:period`; la lectura respeta el período global y la escritura está reservada a administradores/desarrolladores. `GET /api/agencies?period=YYYY-MM` incluye los archivos del período en un campo de respuesta separado `periodFiles`.

Antes del despliegue, haz respaldo de MongoDB y revisa el diagnóstico con `node src/scripts/migrateAgencyMonthlyFiles.js` (solo lectura). La migración idempotente infiere el período en este orden: año/mes almacenados, ruta o nombre, y fecha `modifiedTime`; archivos ambiguos o en conflicto se reportan y se dejan intactos en el documento legado para revisión manual. Aplica cambios solo después de revisar el reporte con `node src/scripts/migrateAgencyMonthlyFiles.js --apply`. El modo de aplicación traslada los archivos inferibles, elimina sus duplicados legados y retira las carpetas redundantes de los documentos mensuales. El proceso no conecta ni modifica MongoDB sin ejecutarlo explícitamente con `--apply`.

Los lectores de correo, recordatorios, verificaciones y paneles consultan `AgencyMonthlyFiles` por agencia y período. No se copian slots de archivos de regreso a `Agency`.

Los trabajos y su progreso se guardan en MongoDB. `GET /api/agencies/refresh-jobs/active` recupera la tarea activa del usuario y `GET /api/agencies/refresh-jobs/:jobId` consulta el estado; al reiniciar Node, las tareas en proceso se reanudan. El token no se devuelve en respuestas ni se escribe en logs. Los trabajos sin incidencias caducan después de 30 días; los que registran fallos se conservan como historial. La actualización individual también usa `POST /api/agencies/:id/refresh-files` con `year`, `month`, `folderId` opcional y `googleAccessToken`.

El Administrador de Agencias crea verificaciones completas con `POST /api/agencies/integrity-jobs`; `GET /api/agencies/integrity-jobs/active` consulta el proceso activo. El worker comprueba cada archivo vinculado contra Drive (acceso, nombre/marca, período, fecha de modificación y peso) y conserva los detalles por agencia en el mismo historial. `GET /api/agencies/maintenance/history?limit=30` devuelve procesos terminados con incidencias del usuario autenticado. Los permisos de Drive siguen siendo validados antes de encolar el trabajo.

## Actividad y recuperación
La consola imprime cada solicitud con usuario, ruta, estado, duración y datos de entrada sanitizados; tokens y contraseñas siempre se redactan. MongoDB guarda acciones de todos los usuarios en `ActivityLog`, asociadas al actor. Las lecturas repetidas iguales se agrupan durante un minuto; su contador evita llenar la colección con consultas de sondeo. La auditoría caduca a los 14 días.

`GET /api/activity?limit=50` lista tus acciones y usa `nextCursor` como `cursor`. `GET /api/activity/:id` consulta el detalle. Los borrados de agencias, plantillas y registros de correo incluyen un snapshot; el mismo usuario puede restaurarlo con `POST /api/activity/:id/restore`. Los envíos conservan además su historial detallado en `GET /api/maillogs/job/:jobId`.

Solo los registros normales de actividad (`ActivityLog`) se eliminan al cumplir 14 días. La limpieza se ejecuta al iniciar el servidor y cada 24 horas; el índice TTL de MongoDB también elimina registros vencidos. Los eventos del servidor (`ServerEvent`) y el historial de envíos (`MailLog`) no se borran con esta limpieza, por lo que el dashboard puede calcular el mes completo. Los snapshots facilitan recuperar registros borrados por la aplicación, pero no sustituyen los backups de MongoDB para corrupción, borrados directos en la base o incidentes que afecten también a la auditoría.

## Herramientas developer
Las cuentas autenticadas con rol `developer` pueden usar `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id` y `DELETE /api/users/:id` para consultar y administrar accesos, también en producción. La eliminación es lógica y cambia `status` a `inactivo`; no se permite desactivar la propia cuenta ni dejar el sistema sin un developer activo.

El visor consulta `GET /api/activity/server?source=activity&limit=50` para paginar auditorías de solicitudes de todos los usuarios; `source=events` selecciona eventos operativos `ServerEvent`. Ambos feeds aceptan `cursor`. Estas APIs requieren una sesión válida cuyo usuario tenga rol `developer`. La autorización del servidor es obligatoria aunque el frontend también oculte las rutas.

En producción, el frontend consulta cambios de notificaciones cada 10 segundos en lugar de mantener una conexión SSE larga a través del proxy de Netlify, que puede cerrarla con `504`. En desarrollo local se conserva SSE.

La salida de consola presenta solicitudes HTTP con método, estado, duración y usuario; los eventos de workers muestran estado y progreso en barra cuando hay un total conocido. Los colores se activan en terminales interactivas y pueden controlarse con `NO_COLOR` o `FORCE_COLOR`.

## Dashboard, recursos y exportaciones administrativas

Las rutas `/api/admin/*` requieren `Authorization: Bearer <token>` y una cuenta activa con rol `admin` o `developer`:

- `GET /api/admin/dashboard?year=2026&month=10`: envíos y agencias del mes UTC. Sin parámetros usa el mes UTC actual. Incluye agencias con envíos, agencias sin un correo válido, campañas, totales enviados/fallidos y dos métricas de archivos: completitud de los campos `nombre`/`ruta` de los cuatro archivos de agencias activas, y porcentaje de archivos en estado `ok` según la última verificación de integridad completada por agencia.
- `GET /api/admin/system`: memoria y uptime del proceso Node, recursos del host y tamaño/uso de MongoDB. `storageUsagePercentage` es `null` si no se configura el límite; establece `STORAGE_LIMIT_BYTES` en `.env` con un entero positivo para calcularlo. El límite debe corresponder al límite contratado/configurado en tu proveedor.
- `GET /api/admin/exports`: lista las colecciones Mongoose disponibles para descarga y su número estimado de documentos.
- `GET /api/admin/exports/:collection?format=json|csv`: descarga una colección en JSON (predeterminado) o CSV. Cada petición descarga una colección; consulta primero la lista anterior. Para evitar exportar credenciales, se excluyen hashes/identificadores de acceso de usuarios y tokens de Google cifrados de trabajos.

Ejemplo de React para consultar el dashboard:

```js
const response = await fetch(
  `${API_URL}/api/admin/dashboard?year=2026&month=10`,
  { headers: { Authorization: `Bearer ${token}` } }
);
if (!response.ok) throw new Error('No se pudo cargar el dashboard');
const dashboard = await response.json();
```

Para descargar datos desde el cliente web, la cookie de sesión autenticada sirve para listar colecciones y solicitar el archivo. Los clientes heredados pueden continuar enviando su JWT:

```js
const response = await fetch(`${API_URL}/api/admin/exports/maillogs?format=csv`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error('No se pudo exportar la colección');
const downloadUrl = URL.createObjectURL(await response.blob());
const link = document.createElement('a');
link.href = downloadUrl;
link.download = 'maillogs.csv';
link.click();
URL.revokeObjectURL(downloadUrl);
```

`GET /api/admin/system` devuelve estadísticas de base de datos; el porcentaje no representa el espacio libre del disco del servidor. Para que coincida con un plan de hosting, configura `STORAGE_LIMIT_BYTES` con el límite aplicable a MongoDB.

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
