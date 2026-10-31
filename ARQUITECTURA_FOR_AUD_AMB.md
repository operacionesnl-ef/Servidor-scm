# Arquitectura técnica: FOR-AUD-AMB

## Alcance

Esta nota describe el flujo del módulo de reportes de auditoría ambiental (FOR-AUD-AMB) entre el frontend `scm` y el backend `Servidor-scm`. El backend transforma la plantilla en memoria, la valida y guarda el Excel generado en Google Drive; no persiste el libro en el disco del servidor.

## Componentes

### Frontend (`scm`)

- `src/features/agencies/pages/ForAuditAmbientalPage.jsx`: formulario de datos generales, evidencias, respuestas ambientales y aplicabilidad explícita de secciones.
- `src/features/agencies/services/forReportService.js`: cliente HTTP para crear/actualizar reportes, cargar imágenes, iniciar generación, consultar estado y descargar.
- `src/components/processes/BackgroundProcessContext.jsx`: patrón general de procesos en segundo plano de la aplicación.
- El navegador solo guarda los datos del formulario y envía solicitudes. No compone ni modifica el libro Excel.

### Backend (`Servidor-scm`)

- `src/routes/forReportRoutes.js`: rutas autenticadas para reportes, imágenes, generación, estado y descarga.
- `src/controllers/forReportController.js`: autorización, validación de revisiones, persistencia del reporte y respuestas HTTP.
- `src/models/ForReport.js`: esquema MongoDB para datos, evidencias, aplicabilidad explícita, estado de generación y referencias de almacenamiento.
- `src/services/forReportExcelWorker.js`: worker que reclama trabajos encolados, recupera imágenes, genera el libro, registra el resultado y reintenta trabajos interrumpidos.
- `src/services/forReportDriveStorage.js`: crea `Servicios EF/Recorridos Medio Ambiente/{AAAA}/{MM}/{marca}` y sube o actualiza el Excel en Drive.
- `src/services/forReportExcelGenerator.js`: valida la plantilla, resuelve marcadores, inserta fotografías, oculta bloques y verifica el archivo resultante.
- `src/services/forReportDriveStorage.js`: crea las carpetas de destino y sube o actualiza el Excel en Drive.
- `src/templates/FOR-AUD-AMB-v1.xlsx`: copia de la plantilla oficial usada por el servidor. No se modifica durante la generación.
- `test/forReportExcelGenerator.test.js`, `test/forReportService.test.js` y `test/forReportController.test.js`: cobertura del formato, reglas de datos y endpoints.

## Flujo de trabajo

1. El usuario captura o edita el único reporte permitido para la agencia y período mensual en el frontend y lo guarda.
2. El frontend envía los datos a `POST /api/for-aud-amb` o `PUT /api/for-aud-amb/:reportId`. Las imágenes se cargan al backend, que las valida y las conserva en Drive como evidencia.
3. Después de guardar correctamente el contenido, el consultor solicita la generación automáticamente; el administrador/developer la inicia con la acción **Generar**. En ambos casos se envía `POST /api/for-aud-amb/:reportId/excel/generate` con la revisión esperada. Si ya hay un trabajo activo, no se duplica.
4. El controller registra el estado `queued` en MongoDB y despierta el worker. La respuesta vuelve sin esperar a que termine el libro.
5. El worker procesa la versión reclamada, obtiene de Drive las imágenes activas, transforma una copia de la plantilla en memoria y sube el resultado a Drive.
6. La validación posterior comprueba hojas, valores reemplazados, marcadores residuales, objetos gráficos originales y cantidad/contenido de imágenes.
7. El worker registra `ready` o `failed`. El frontend consulta `GET /api/for-aud-amb/:reportId/excel` y habilita la descarga únicamente para la revisión actual validada.
8. La descarga autorizada usa `GET /api/for-aud-amb/:reportId/excel/download`. Cambios al reporte invalidan el Excel anterior.

Estados de generación: `not_requested`, `queued`, `processing`, `ready` y `failed`. Los trabajos en procesamiento que quedan obsoletos se reencolan al reiniciar o mediante el sondeo del worker.

## Lógica de transformación

- La plantilla conserva el diseño visual; el backend reemplaza marcadores encontrados por su texto exacto en `DATOS`, `EVIDENCIA` y `APLICA`.
- Los valores generales usan la razón social y nombre de agencia (`razón social · empresa`), fecha `DD/MM/AAAA`, número de visita y observaciones.
- Las respuestas y comentarios se asocian a las preguntas por sus identificadores funcionales y prefijos definidos en `src/formats/forAudAmb.js`.
- `notApplicableCategories` es independiente de las respuestas. Una lista vacía significa que todas las secciones aplican. Solo los IDs permitidos pueden ocultar sus filas; respuestas vacías no ocultan secciones.
- `0` y `1` se reemplazan por valores numéricos de Excel; `NA` se reemplaza por texto para evitar la advertencia de número almacenado como texto.
- Una evidencia activa se considera usada si tiene descripción o imágenes activas. Se admite un máximo de 20 evidencias y cuatro imágenes por evidencia; los archivos aún pendientes o sin referencia de almacenamiento hacen fallar la generación de forma explícita.
- Las imágenes se normalizan mediante Sharp (incluida la orientación EXIF), conservan proporción y se anclan en el área combinada que corresponde al marcador `{imagenN}`.
- Los bloques de evidencia vacíos se ocultan por sus cinco columnas y la columna separadora indicada por la combinación del marcador. En `APLICA`, solo se ocultan las filas de las secciones explícitamente no aplicables.
- Las respuestas `0` y `1` se escriben como valores numéricos de Excel; `NA` permanece como texto.
- El nombre descargable sigue el patrón `FOR-AUD-AMB-{codigo-agencia}-({fecha-recorrido})-({misma-fecha-mes-siguiente}).xlsx`. El developer configura el código de agencia, por ejemplo `HYN-SAN-NL`, desde el modo de depuración de la ficha. El nombre interno en disco continúa siendo `FOR-{reportId}-rev-{revision}.xlsx` para evitar colisiones y permitir la limpieza de revisiones.

## Almacenamiento en Drive

- La plantilla por defecto está en `src/templates/FOR-AUD-AMB-v1.xlsx`; se puede cambiar con `FOR_REPORT_EXCEL_TEMPLATE_PATH`.
- `TEMPLATE_VERSION=1.1` valida que ExcelJS pueda reabrir el libro y reconocer cada imagen; los PNG internos usan nombres de paquete estándar (`imageN.png`).
- El archivo se guarda en `GOOGLE_DRIVE_ROOT_FOLDER_ID/Servicios EF/Recorridos Medio Ambiente/{AAAA}/{MM}/{marca}`. La marca se configura por agencia desde el modo Debug y queda registrada en el reporte.
- MongoDB guarda `storageProvider=drive`, `driveFileId`, `generatedFolderId` y `downloadFileName`; el contenido del XLSX no se escribe al disco del servidor.
- La descarga conserva compatibilidad de lectura para archivos locales creados por versiones anteriores; las generaciones nuevas nunca usan ese almacenamiento.
- El archivo de un reporte se actualiza al generar una revisión nueva y se mueve al destino correcto si cambian la marca o el período.
- El slot `FOR` (`archivo2`) de `AgencyMonthlyFiles` representa su origen con `mode=drive|system`; en modo sistema referencia el único `ForReport` permitido para la agencia y el período. Los otros tipos continúan operando desde Drive.
- El guardado de una revisión nueva invalida el Excel previo; la descarga confirma que el archivo de Drive corresponda a la revisión actual.

## Seguridad y validaciones

- Todas las rutas del módulo requieren autenticación; el backend comprueba permisos sobre la agencia y el reporte.
- El encolado exige la revisión esperada para impedir que el worker procese contenido obsoleto.
- La plantilla y el directorio de salida son controlados por configuración del servidor; los nombres de archivos internos se validan antes de resolver rutas.
- La plantilla debe contener las hojas requeridas y cada marcador esperado exactamente una vez. Marcadores faltantes, duplicados, desconocidos o ubicados en la hoja incorrecta detienen el proceso.
- La fecha, respuestas, evidencias, número de imágenes y estado de carga se validan antes de generar.
- Las fallas se registran en el estado del reporte y en los eventos del servidor; no se publica un Excel como listo si su validación falla.

## Mantenimiento y pruebas

Desde `Servidor-scm`, ejecutar:

```powershell
npm test -- --test-name-pattern="forReport"
```

Al sustituir la plantilla o cambiar el formato del generador, actualizar `TEMPLATE_VERSION`, reemplazar el archivo en `src/templates`, validar sus marcadores y ejecutar los casos de generación. Al iniciar, el worker invalida las generaciones listas de una versión anterior para que puedan regenerarse. Además, abrir una muestra en Excel o compatible para revisar impresión, estilos, imágenes y visibilidad.

Las siguientes mejoras requieren su propia fase: habilitar formularios del sistema para los otros tres tipos de archivo. El sufijo común por agencia y el código del tipo ya permiten nombrarlos con una convención compartida.
