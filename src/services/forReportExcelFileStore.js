'use strict';

const crypto = require('node:crypto');
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

async function storeGeneratedForReportExcel(fileName, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('El archivo Excel generado no contiene datos.');
  }
  const directory = getOutputDirectory();
  const filePath = resolveLocalExcelPath(fileName);
  const temporaryPath = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { storageProvider: 'local', localFileName: fileName };
}

async function getGeneratedForReportExcelPath(fileName) {
  const filePath = resolveLocalExcelPath(fileName);
  await fs.access(filePath);
  return filePath;
}

async function removeGeneratedForReportExcel(fileName) {
  const filePath = resolveLocalExcelPath(fileName);
  await fs.unlink(filePath);
}

module.exports = {
  getGeneratedForReportExcelPath,
  removeGeneratedForReportExcel,
  resolveLocalExcelPath,
  storeGeneratedForReportExcel,
};
