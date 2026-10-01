'use strict';

const MONTH_NAMES_ES = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre',
];

/**
 * Normaliza texto: minúsculas, sin acentos.
 */
function normalize(str = '') {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Dado un nombre de archivo real y su ruta de carpetas (array de strings,
 * de raíz hacia el archivo), y el código esperado (ANX, FOR, REP, REV),
 * devuelve un objeto { relativePath, fileNamePattern } que representa
 * cómo está organizado este archivo.
 *
 * Ejemplo:
 *   fileName    = "REP_mayo_2025.xlsx"
 *   folderPath  = ["Agencia Norte", "2025", "mayo"]  (sin incluir el archivo)
 *   rootFolder  = "Agencia Norte"
 *   code        = "REP"
 *
 * → relativePath   = ["{year}", "{monthName}"]
 * → fileNamePattern = "{code}_{monthName}_{year}.xlsx"
 */
function learnPattern(fileName, folderPath, rootFolderName, code, year, month) {
  const monthName = MONTH_NAMES_ES[month - 1];
  const monthNum  = String(month).padStart(2, '0');

  // Segmentos de ruta relativos a la carpeta raíz
  const rootIndex = folderPath.findIndex(
    (seg) => normalize(seg) === normalize(rootFolderName)
  );
  if (rootIndex < 0) {
    throw new Error(`Root folder "${rootFolderName}" was not found in the supplied path`);
  }
  const relativeFolders = folderPath.slice(rootIndex + 1);

  // Tokeniza cada segmento de carpeta
  const tokenizedPath = relativeFolders.map((seg) => tokenizeSegment(seg, year, month, monthName, monthNum, code));

  // Tokeniza el nombre del archivo
  const tokenizedName = tokenizeSegment(fileName, year, month, monthName, monthNum, code);

  return {
    basePath: folderPath.slice(0, rootIndex + 1),
    relativePath: tokenizedPath,
    fileNamePattern: tokenizedName,
  };
}

/**
 * Reemplaza valores concretos por tokens en un segmento de texto.
 */
function tokenizeSegment(text, year, month, monthName, monthNum, code) {
  let result = text;

  // Año
  result = result.replace(new RegExp(String(year), 'g'), '{year}');

  // Mes con nombre (más específico primero)
  const normalizedResult = normalize(result);
  const normalizedMonthName = normalize(monthName);
  if (normalizedResult.includes(normalizedMonthName)) {
    // Reemplaza respetando mayúsculas originales
    const regex = new RegExp(monthName, 'gi');
    result = result.replace(regex, '{monthName}');
  }

  // Mes numérico con cero (p.ej. "05")
  result = result.replace(new RegExp(`\\b${monthNum}\\b`, 'g'), '{month}');

  // Mes numérico sin cero si es diferente
  if (month < 10) {
    result = result.replace(new RegExp(`\\b${month}\\b`, 'g'), '{month}');
  }

  // Código del archivo
  if (code) {
    result = result.replace(new RegExp(`\\b${code}\\b`, 'gi'), '{code}');
  }

  return result;
}

/**
 * Dado un patrón aprendido, genera la ruta esperada para un periodo nuevo.
 * Devuelve array de segmentos de carpeta + nombre de archivo esperado.
 *
 * Si el patrón tiene {monthName}, genera variantes con mayúscula inicial
 * y todo minúscula para tolerar inconsistencias.
 */
function applyPattern(pattern, year, month, code) {
  const monthName    = MONTH_NAMES_ES[month - 1];
  const monthNameCap = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const monthNum     = String(month).padStart(2, '0');

  const replace = (str, useCapitalized) => str
    .replace(/\{year\}/g, String(year))
    .replace(/\{monthName\}/g, useCapitalized ? monthNameCap : monthName)
    .replace(/\{month\}/g, monthNum)
    .replace(/\{code\}/g, code);

  // Genera dos variantes: nombre de mes capitalizado y en minúsculas
  return [false, true].map((cap) => ({
    folderSegments: (pattern.relativePath || []).map((seg) => replace(seg, cap)),
    expectedFileName: replace(pattern.fileNamePattern || '', cap),
  }));
}

/**
 * Dados los descendientes de Drive (con folderPath), busca el archivo
 * que mejor coincida con el patrón para el periodo dado.
 *
 * Devuelve { nombre, ruta } listo para guardar en archivos.archivoN,
 * o null si no encuentra nada.
 */
function matchFromPattern(pattern, descendants, year, month, code) {
  if (!pattern?.fileNamePattern) return null;

  const files = descendants.filter(
    (d) => d.mimeType !== 'application/vnd.google-apps.folder'
  );

  const variants = applyPattern(pattern, year, month, code);
  const matchesPath = (file, expectedSegments) => {
    const filePath = (file.folderPath || []).map(normalize);
    let expectedIndex = 0;
    for (const segment of filePath) {
      if (segment === normalize(expectedSegments[expectedIndex] || '')) expectedIndex += 1;
      if (expectedIndex === expectedSegments.length) return true;
    }
    return expectedSegments.length === 0;
  };

  for (const { folderSegments, expectedFileName } of variants) {
    const normalizedExpected = normalize(expectedFileName);

    // Match exact filename inside the saved segmented path, not anywhere in Drive.
    const exactMatch = files.find(
      (file) => normalize(file.name) === normalizedExpected && matchesPath(file, folderSegments)
    );
    if (exactMatch) {
      return { nombre: exactMatch.name, ruta: exactMatch.parents?.[0] || exactMatch.id };
    }

    // Segundo: el archivo está en la carpeta esperada y tiene el código
    if (folderSegments.length > 0) {
      const codePattern = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`, 'i');
      const folderMatch = files.find((f) => {
        return matchesPath(f, folderSegments) && codePattern.test(f.name);
      });
      if (folderMatch) {
        return { nombre: folderMatch.name, ruta: folderMatch.parents?.[0] || folderMatch.id };
      }
    }
  }

  // Fallback: búsqueda solo por código en el periodo correcto
  return null;
}

/**
 * Tras una asignación exitosa de archivos (manual o automática),
 * actualiza el objeto drivePattern de la agencia con lo aprendido.
 *
 * @param {Object} currentPattern  - agency.drivePattern (puede ser undefined)
 * @param {string} rootFolderName  - nombre de la carpeta principal
 * @param {Array}  fileAssignments - [{ key, code, fileName, folderPath }]
 * @param {number} year
 * @param {number} month
 * @returns {Object} nuevo drivePattern listo para guardar
 */
function updateDrivePattern(currentPattern = {}, rootFolderName, fileAssignments, year, month) {
  const updated = { ...currentPattern };

  for (const { key, code, fileName, folderPath, fileId } of fileAssignments) {
    if (!fileName) continue;

    const learned = learnPattern(fileName, folderPath, rootFolderName, code, year, month);
    const prev = updated[key] || {};
    const prevConfidence = prev.confidence || 0;

    // Solo sube la confianza, nunca baja (a menos que se corrija manualmente)
    updated[key] = {
      basePath:        learned.basePath,
      relativePath:    learned.relativePath,
      lastSeenPath:    [...folderPath, fileName],
      fileNamePattern: learned.fileNamePattern,
      lastSeenName:    fileName,
      lastSeenRuta:    fileId,
      confidence:      Math.min(1, prevConfidence + 0.25),
    };
  }

  return updated;
}

module.exports = {
  learnPattern,
  applyPattern,
  matchFromPattern,
  updateDrivePattern,
  MONTH_NAMES_ES,
};