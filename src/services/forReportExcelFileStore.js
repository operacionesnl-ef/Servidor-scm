'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_OUTPUT_DIRECTORY = path.resolve(__dirname, '../../storage/for-report-excels');
const REPORT_EXCEL_FILENAME_PATTERN = /^FOR-[a-f\d-]{36}-rev-\d+\.xlsx$/i;

function getOutputDirectory() {
  return path.resolve(process.env.FOR_REPORT_EXCEL_OUTPUT_DIR || DEFAULT_OUTPUT_DIRECTORY);
}

function resolveLocalExcelPath(fileName) {
  if (typeof fileName !== 'string' || !REPORT_EXCEL_FILENAME_PATTERN.test(fileName)) {
    throw new TypeError('El nombre del archivo Excel generado no es válido.');
  }
  const directory = getOutputDirectory();
  return path.join(directory, fileName);
}

async function getGeneratedForReportExcelPath(fileName) {
  const filePath = resolveLocalExcelPath(fileName);
  await fs.access(filePath);
  return filePath;
}

module.exports = {
  getOutputDirectory,
  getGeneratedForReportExcelPath,
  resolveLocalExcelPath,
};
