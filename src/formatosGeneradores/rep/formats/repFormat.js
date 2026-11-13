'use strict';

const REVIEW_ROW = 5;
const DOCUMENT_MARKERS = [
  'estudio_iluminacion',
  'estudio_ruido',
  'permisos_recipientes',
  'registro_programa',
  'licencia_uso',
  'estudio_grado',
  'estudio_sustancias',
];

const FINDING_MARKERS = [
  'fecha_recorrido',
  'area',
  'n',
  'elemento_revisado',
  'descripcion',
  'numero_imagen',
  'accion',
  'prioridad',
  'responsable',
  'fundamento_legal',
  'fecha_hallazgo',
  'fecha_cumplimiento',
  'status',
  'en_tiempo',
  'sancion',
];

const GENERAL_MARKERS = [
  'razon_social',
  'sucursal',
  'direccion',
  'tipo_recorrido_or',
  'tipo_recorrido_ext',
  'mes',
  'year',
  'año',
  'fecha_inicio',
  'hora_inicio',
  'fecha_fin',
  'hora_fin',
];

const OPTIONAL_GENERAL_MARKERS = [
  'ciudad',
  'estado',
  'semana',
  'year_mes',
  'year_semana',
  'marca',
];

module.exports = {
  DOCUMENT_MARKERS,
  FINDING_MARKERS,
  GENERAL_MARKERS,
  OPTIONAL_GENERAL_MARKERS,
  REVIEW_ROW,
};
