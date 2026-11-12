'use strict';

function hasIndependentDriveFile(file) {
  if (!file?.driveId) return false;
  if (file.mode === 'drive') return true;
  if (file.systemReportId && file.systemDriveId === file.driveId) return false;
  if (file.mode === 'system') return Boolean(file.systemDriveId && file.driveId !== file.systemDriveId);
  return true;
}

module.exports = { hasIndependentDriveFile };
