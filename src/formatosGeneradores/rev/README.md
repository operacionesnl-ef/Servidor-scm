# REV-EXT

El módulo REV genera el reporte de revisión mensual de extintores con la plantilla `templates/REV-EXT.xlsx`. Los reportes se guardan en MongoDB y los Excel se generan en segundo plano y almacenan en Google Drive, bajo la carpeta mensual de la agencia. El archivo generado se sincroniza con el slot REV (`archivo4`) del expediente mensual.

`REV_EXCEL_TEMPLATE_PATH` en `.env` permite configurar una plantilla alternativa. Si no se define, se usa la plantilla incluida en este módulo.

## API

- `GET /api/rev?agencyId=<id>[&inspectionDate=AAAA-MM-DD]`: lista reportes REV.
- `POST /api/rev`: crea un reporte.
- `GET /api/rev/:reportId`: obtiene el reporte.
- `PUT /api/rev/:reportId`: actualiza el reporte; requiere `expectedRevision`.
- `POST /api/rev/:reportId/excel/generate`: encola la generación; requiere `expectedRevision`.
- `GET /api/rev/:reportId/excel`: consulta el estado de generación.
- `GET /api/rev/:reportId/excel/download`: descarga el Excel listo desde Drive.

La creación requiere `agencyId`, `generalData.inspectionDate`, `generalData.responsible` y `extinguishers` (máximo 80 extintores). En cada extintor, solo uno de `pqs`, `co2`, `agua`, `tipod` o `tipok` puede tener el valor `"1"`; los demás se guardan vacíos. `capacidad` es un número mayor o igual a cero. Las 13 revisiones (`pintura`, `golpes`, `adhesivo`, `transporte`, `disparo`, `presion`, `manometro`, `manguera`, `ring`, `boquilla`, `senalizacion`, `libre` y `limpio`) aceptan `"1"`, `"0"`, `"NA"`, `"2"` o `"NR"`; `"NT"` sigue aceptándose para reportes existentes. `status` acepta `"En buen estado"`, `"Próximo a vencer"` o `"Vencido"` y `ubicacion` es texto libre de hasta 500 caracteres. Si `observaciones` llega vacía, se guarda como `"Sin Observaciones"`. El número `n` se asigna automáticamente según el orden de la lista.

Los valores de carátula `mes`, `year`, `razon_social` y `sucursal`, así como la fecha de inspección y el logotipo de marca, se calculan o toman del registro de agencia. Si la marca no tiene un logotipo configurado, REV utiliza el logotipo de CLEBER como respaldo. La imagen `cleber` de la plantilla se muestra automáticamente solo para agencias de esa marca. La fila 11 de INSPECCIÓN se replica para cada extintor.
