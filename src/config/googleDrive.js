'use strict';

const { google } = require('googleapis');

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function getGoogleDriveOAuthConfig() {
  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI,
    GOOGLE_OAUTH_REFRESH_TOKEN,
    GOOGLE_DRIVE_ROOT_FOLDER_ID,
    GOOGLE_DRIVE_ROOT_FOLDER_NAME = 'EFCORE_STORAGE_APP',
  } = process.env;

  return {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    refreshToken: GOOGLE_OAUTH_REFRESH_TOKEN,
    rootFolderId: GOOGLE_DRIVE_ROOT_FOLDER_ID,
    rootFolderName: GOOGLE_DRIVE_ROOT_FOLDER_NAME,
  };
}

function createGoogleDriveOAuthClient(config = getGoogleDriveOAuthConfig()) {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error('Falta configurar el cliente OAuth de Google Drive.');
  }
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

function createGoogleDriveClient(config = getGoogleDriveOAuthConfig()) {
  if (!config.refreshToken) {
    throw new Error('Google Drive aún no está autorizado. Configura GOOGLE_OAUTH_REFRESH_TOKEN.');
  }
  const oauthClient = createGoogleDriveOAuthClient(config);
  oauthClient.setCredentials({ refresh_token: config.refreshToken });
  return google.drive({ version: 'v3', auth: oauthClient, timeout: 120_000 });
}

module.exports = {
  DRIVE_FILE_SCOPE,
  createGoogleDriveClient,
  createGoogleDriveOAuthClient,
  getGoogleDriveOAuthConfig,
};
