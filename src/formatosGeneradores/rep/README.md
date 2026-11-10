# REP-INS

Los Excel REP y los PowerPoint ANX se guardan bajo `Servicios EF/Recorridos Medio Ambiente/<año>/<mes>/<marca>`, con la misma jerarquía de FOR. Las fotografías se guardan por separado bajo `Evidencias/<año>/<mes>/<agencia>/REP/<reporteId>`. Los archivos generados se registran en el expediente mensual en modo Sistema; el ANX usa el slot ANX y el ID del REP asociado.

El módulo REST se monta en `/api/rep` y almacena reportes REP en MongoDB. La generación se procesa en segundo plano y el XLSX resultante se guarda en Google Drive.

## Plantilla

`REP_EXCEL_TEMPLATE_PATH` en `.env` puede apuntar a una ruta absoluta o relativa a la raíz del servidor. Si no se configura, se usa la plantilla incluida en `src/formatosGeneradores/rep/templates/REP-INS.xlsx`.

El reemplazo del logotipo busca en `GOOGLE_DRIVE_ROOT_FOLDER_ID/Recursos/Logotipos` una imagen cuyo nombre, sin extensión, coincida con `Agency.brand` o `Agency.marca` (sin distinguir mayúsculas, espacios ni acentos). Se admiten PNG, JPEG y WebP. La búsqueda registra en consola la carpeta consultada y todos los nombres/tipos de archivo encontrados para facilitar el diagnóstico.

Para asignar logotipos explícitos, edita `src/config/repBrandLogoPaths.js`: usa la marca como clave y un enlace `https://drive.google.com/open?id=...` o una ruta relativa a `GOOGLE_DRIVE_ROOT_FOLDER_ID` como valor. Las claves se normalizan al comparar, por lo que `BMW` y `bmw` coinciden. Se pueden asignar varias marcas al mismo enlace o ruta. Las marcas sin entrada siguen usando la búsqueda automática en `Recursos/Logotipos`. Si el token OAuth actual no puede leer un ID preexistente, el servidor intenta descargarlo mediante el enlace público; estos enlaces deben permitir acceso de lector a cualquiera que tenga el enlace y no requieren cambiar el token OAuth.

## API

- `GET /api/rep?agencyId=<id>&inspectionDate=AAAA-MM-DD`: lista reportes de una agencia y fecha.
- `GET /api/rep/logo?agencyId=<id>[&reportId=<id>]`: carga el logotipo desde `Recursos/Logotipos`.
- `POST /api/rep`: crea un reporte.
- `GET /api/rep/:reportId`: obtiene sus datos y estado.
- `PUT /api/rep/:reportId`: actualiza el reporte con `expectedRevision`.
- `POST /api/rep/:reportId/findings/:findingId/images/:imageId`: guarda una foto multipart (`file`) en Google Drive y la asocia a ANX; admite JPEG, PNG y WebP de hasta 10 MiB, hasta cuatro fotos por hallazgo y 40 por anexo.
- `GET /api/rep/:reportId/findings/:findingId/images/:imageId`: transmite la foto guardada para vista previa.
- `POST /api/rep/:reportId/excel/generate`: encola la generación con `expectedRevision`.
- `GET /api/rep/:reportId/excel`: consulta el estado de generación.
- `GET /api/rep/:reportId/excel/download`: descarga el Excel listo desde Drive.
- `POST /api/rep/:reportId/anx/generate`: encola la generación y guardado del PowerPoint ANX en Drive.
- `GET /api/rep/:reportId/anx`: consulta el estado de generación del ANX.
- `GET /api/rep/:reportId/anx/download`: descarga el ANX listo desde Drive.

El cuerpo de creación contiene `agencyId`, `calendarEventId`, `generalData`, `findings` y `documents`. El servidor valida que la programación pertenezca a la sucursal y toma de ella las fechas y horas del recorrido. `generalData.visitType` acepta `ordinario` o `extraordinario`. Cada hallazgo distingue `correctiveAction` y `preventiveAction`; el área y el elemento revisado son obligatorios. Los catálogos de área y status corresponden a las listas de la plantilla; prioridad acepta `baja`, `media`, `alta` o `crítica`; `onTime` acepta booleano o `Sí`/`No`. `imageNumber` es el texto que se escribe en la columna de evidencia y `sanction` es un monto numérico no negativo. Los siete campos de `documents` usan los marcadores de la plantilla: `estudio_iluminacion`, `estudio_ruido`, `permisos_recipientes`, `registro_programa`, `licencia_uso`, `estudio_grado` y `estudio_sustancias`.

Si no hay hallazgos, se elimina la fila 5 de datos. El número de trabajadores permanece como `N/D`, conforme a la plantilla.
