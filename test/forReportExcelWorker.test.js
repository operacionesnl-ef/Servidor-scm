'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const ForReport = require('../src/models/ForReport');
const AgencyMonthlyFiles = require('../src/models/AgencyMonthlyFiles');
const { TEMPLATE_VERSION } = require('../src/services/forReportExcelGenerator');
const { invalidateStaleGeneratedExcels } = require('../src/services/forReportExcelWorker');

const originalReportFind = ForReport.find;
const originalReportUpdateMany = ForReport.updateMany;
const originalMonthlyUpdateMany = AgencyMonthlyFiles.updateMany;

afterEach(() => {
  ForReport.find = originalReportFind;
  ForReport.updateMany = originalReportUpdateMany;
  AgencyMonthlyFiles.updateMany = originalMonthlyUpdateMany;
});

test('invalidates ready Excel files made with an older generator version', async () => {
  const report = {
    _id: '507f1f77bcf86cd799439099',
    reportId: 'FOR-12345678-1234-1234-1234-123456789012',
  };
  let reportFilter;
  let reportUpdate;
  let monthlyFilter;
  let monthlyUpdate;
  ForReport.find = (filter) => {
    reportFilter = filter;
    return {
      select: () => ({ lean: async () => [report] }),
    };
  };
  ForReport.updateMany = async (filter, update) => {
    reportUpdate = { filter, update };
    return { modifiedCount: 1 };
  };
  AgencyMonthlyFiles.updateMany = async (filter, update) => {
    monthlyFilter = filter;
    monthlyUpdate = update;
    return { modifiedCount: 1 };
  };

  const invalidatedCount = await invalidateStaleGeneratedExcels();

  assert.equal(invalidatedCount, 1);
  assert.deepEqual(reportFilter['generatedExcel.templateVersion'], { $ne: TEMPLATE_VERSION });
  assert.equal(reportUpdate.update.$set['generatedExcel.status'], 'not_requested');
  assert.equal(reportUpdate.update.$set['generatedExcel.templateVersion'], TEMPLATE_VERSION);
  assert.equal(reportUpdate.update.$set['generatedExcel.driveFileId'], '');
  assert.deepEqual(monthlyFilter['archivos.archivo2.systemReportId'], { $in: [report.reportId] });
  assert.equal(monthlyUpdate.$set['archivos.archivo2.generatedExcelStatus'], 'not_requested');
  assert.equal(monthlyUpdate.$set['archivos.archivo2.generatedExcelTemplateVersion'], '');
});
