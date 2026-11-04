# REP-INS

El módulo REST se monta en `/api/rep` y almacena reportes REP en MongoDB. La generación se procesa en segundo plano y el XLSX resultante se guarda en Google Drive.

## Plantilla

`REP_EXCEL_TEMPLATE_PATH` en `.env` puede apuntar a una ruta absoluta o relativa a la raíz del servidor. Si no se configura, se usa la plantilla incluida en `src/formatosGeneradores/rep/templates/REP-INS.xlsx`.

El reemplazo del logotipo busca en `GOOGLE_DRIVE_ROOT_FOLDER_ID/Recursos/Logotipos` una imagen cuyo nombre, sin extensión, coincida con `Agency.marca` (sin distinguir mayúsculas, espacios ni acentos). Se admiten PNG, JPEG y WebP.

## API

- `GET /api/rep?agencyId=<id>&inspectionDate=AAAA-MM-DD`: lista reportes de una agencia y fecha.
- `POST /api/rep`: crea un reporte.
- `GET /api/rep/:reportId`: obtiene sus datos y estado.
- `PUT /api/rep/:reportId`: actualiza el reporte con `expectedRevision`.
- `POST /api/rep/:reportId/excel/generate`: encola la generación con `expectedRevision`.
- `GET /api/rep/:reportId/excel`: consulta el estado de generación.
- `GET /api/rep/:reportId/excel/download`: descarga el Excel listo desde Drive.

El cuerpo de creación contiene `agencyId`, `calendarEventId`, `generalData`, `findings` y `documents`. El servidor valida que la programación pertenezca a la sucursal y toma de ella las fechas y horas del recorrido. `generalData.visitType` acepta `ordinario` o `extraordinario`. Cada hallazgo distingue `correctiveAction` y `preventiveAction`; el área y el elemento revisado son obligatorios. Los catálogos de área y status corresponden a las listas de la plantilla; prioridad acepta `baja`, `media`, `alta` o `crítica`; `onTime` acepta booleano o `Sí`/`No`. `imageNumber` es el texto que se escribe en la columna de evidencia y `sanction` es un monto numérico no negativo. Los siete campos de `documents` usan los marcadores de la plantilla: `estudio_iluminacion`, `estudio_ruido`, `permisos_recipientes`, `registro_programa`, `licencia_uso`, `estudio_grado` y `estudio_sustancias`.

Si no hay hallazgos, se elimina la fila 5 de datos. El número de trabajadores permanece como `N/D`, conforme a la plantilla.
