'use strict';

const crypto = require('node:crypto');
const { google } = require('googleapis');
const { DRIVE_FILE_SCOPE, createGoogleDriveOAuthClient, getGoogleDriveOAuthConfig } = require('../config/googleDrive');
const GoogleDriveOAuthState = require('../models/GoogleDriveOAuthState');
const { findOrCreateRootFolder, getRootFolderStatus } = require('../services/googleDriveService');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
};

function hashState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

async function startGoogleDriveAuthorization(req, res, next) {
  try {
    const config = getGoogleDriveOAuthConfig();
    const oauthClient = createGoogleDriveOAuthClient(config);
    const state = crypto.randomBytes(32).toString('base64url');
    await GoogleDriveOAuthState.create({
      stateHash: hashState(state),
      userId: req.user._id,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });
    const authorizationUrl = oauthClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_FILE_SCOPE],
      state,
    });
    res.set(NO_STORE_HEADERS).json({ authorizationUrl });
  } catch (error) {
    next(error);
  }
}

async function completeGoogleDriveAuthorization(req, res, next) {
  try {
    res.set(NO_STORE_HEADERS);
    const { code, state, error: googleError } = req.query;
    if (typeof state !== 'string' || !state) {
      return res.status(400).json({ message: 'El estado de autorización de Google no es válido.' });
    }

    const oauthState = await GoogleDriveOAuthState.findOneAndDelete({
      stateHash: hashState(state),
      userId: req.user._id,
      expiresAt: { $gt: new Date() },
    });
    if (!oauthState) {
      return res.status(400).json({ message: 'La autorización expiró o ya fue utilizada. Iníciala de nuevo.' });
    }
    if (googleError) {
      return res.status(400).json({ message: 'La autorización de Google Drive fue cancelada.' });
    }
    if (typeof code !== 'string' || !code) {
      return res.status(400).json({ message: 'Google no devolvió un código de autorización válido.' });
    }

    const config = getGoogleDriveOAuthConfig();
    const oauthClient = createGoogleDriveOAuthClient(config);
    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(409).json({
        message: 'Google no entregó un refresh token. Revisa el consentimiento OAuth e inténtalo de nuevo.',
      });
    }

    oauthClient.setCredentials(tokens);
    const { rootFolderName } = config;
    const drive = google.drive({ version: 'v3', auth: oauthClient });
    const rootFolder = await findOrCreateRootFolder(drive, rootFolderName);

    return res.json({
      message: 'Autorización completada. Configura estos valores como secretos del backend y después elimina el refresh token de esta respuesta.',
      environment: {
        GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token,
        GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolder.id,
      },
      folder: { name: rootFolder.name },
    });
  } catch (error) {
    next(error);
  }
}

async function getGoogleDriveStatus(req, res, next) {
  try {
    const status = await getRootFolderStatus();
    res.set(NO_STORE_HEADERS).json(status);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  completeGoogleDriveAuthorization,
  getGoogleDriveStatus,
  startGoogleDriveAuthorization,
};
