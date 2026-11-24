'use strict';

const mongoose = require('mongoose');
const sharp = require('sharp');
const { createGoogleDriveClient } = require('../config/googleDrive');
const Formulario = require('../models/Formulario');
const { generateImage } = require('../scripts/testCloudflareImageGeneration');
const {
  getOrCreateFormularioFlyerBackground,
  getFormularioFlyerBackgroundFile,
  listFormularioFlyerBackgrounds,
  saveFormularioFlyerFiles,
} = require('../formatosGeneradores/flyer/services/flyerDriveStorage');

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function receiveFlyerFiles(req, res, next) {
  const multer = require('multer');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 2, fields: 0 },
  }).fields([
    { name: 'pptx', maxCount: 1 },
    { name: 'image', maxCount: 1 },
  ]);
  upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Cada archivo del flyer debe pesar menos de 15 MiB.' });
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ success: false, message: 'La carga debe incluir un PPTX y una imagen PNG.' });
    }
    return next(error);
  });
}

async function generateFlyerBackground(req, res, next) {
  const formId = req.body?.formId;
  const force = req.body?.force ?? false;
  if (!mongoose.isValidObjectId(formId) || typeof force !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'El formulario o la opción de regeneración no son válidos.',
    });
  }

  try {
    const form = await Formulario.findById(formId).lean();
    if (!form) return res.status(404).json({ success: false, message: 'No se encontró el formulario.' });
    if (!(form.tituloCurso || form.nombreCurso) || !form.norma?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'El formulario debe incluir nombre del curso y norma antes de generar el fondo.',
      });
    }

    const background = await getOrCreateFormularioFlyerBackground(createGoogleDriveClient(), {
      form,
      force,
      generate: async () => {
        const result = await generateImage({
          course: form.tituloCurso || form.nombreCurso,
          norms: form.norma,
          outputFile: null,
        });
        return result.imageBuffer;
      },
    });
    if (form.flyerBackgroundDriveId !== background.driveFileId) {
      const update = await Formulario.updateOne(
        { _id: form._id },
        { $set: { flyerBackgroundDriveId: background.driveFileId } },
      );
      if (update.matchedCount !== 1) {
        return res.status(409).json({ success: false, message: 'El formulario cambió mientras se guardaba su fondo.' });
      }
    }
    return res
      .set('Cache-Control', 'no-store')
      .type('image/jpeg')
      .send(background.buffer);
  } catch (error) {
    return next(error);
  }
}

async function getFlyerBackgrounds(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'El identificador del formulario no es válido.' });
  }
  try {
    const form = await Formulario.findById(req.params.id).lean();
    if (!form) return res.status(404).json({ success: false, message: 'No se encontró el formulario.' });
    const result = await listFormularioFlyerBackgrounds(createGoogleDriveClient(), form._id);
    return res.json({
      success: true,
      data: {
        selectedDriveFileId: form.flyerBackgroundDriveId || result.backgrounds[0]?.driveFileId || '',
        backgrounds: result.backgrounds,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getFlyerBackgroundImage(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id) || typeof req.params.fileId !== 'string') {
    return res.status(400).json({ success: false, message: 'El formulario o la imagen no son válidos.' });
  }
  try {
    const file = await getFormularioFlyerBackgroundFile(
      createGoogleDriveClient(),
      req.params.id,
      req.params.fileId,
    );
    if (!file) return res.status(404).json({ success: false, message: 'No se encontró esa imagen de fondo.' });
    const image = req.query.thumbnail === '1'
      ? await sharp(file.buffer).resize({ width: 320, height: 400, fit: 'cover', withoutEnlargement: true })
        .jpeg({ quality: 76 })
        .toBuffer()
      : file.buffer;
    return res
      .set('Cache-Control', 'no-store, private')
      .type('image/jpeg')
      .send(image);
  } catch (error) {
    return next(error);
  }
}

async function selectFlyerBackground(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)
    || typeof req.body?.driveFileId !== 'string'
    || !req.body.driveFileId.trim()
    || req.body.driveFileId.length > 200) {
    return res.status(400).json({ success: false, message: 'El formulario o la imagen no son válidos.' });
  }
  try {
    const form = await Formulario.findById(req.params.id).lean();
    if (!form) return res.status(404).json({ success: false, message: 'No se encontró el formulario.' });
    const file = await getFormularioFlyerBackgroundFile(
      createGoogleDriveClient(),
      form._id,
      req.body.driveFileId.trim(),
    );
    if (!file) return res.status(404).json({ success: false, message: 'La imagen no pertenece a la galería de este formulario.' });
    const update = await Formulario.updateOne(
      { _id: form._id },
      { $set: { flyerBackgroundDriveId: file.id } },
    );
    if (update.matchedCount !== 1) {
      return res.status(409).json({ success: false, message: 'El formulario cambió mientras se seleccionaba el fondo.' });
    }
    return res.json({
      success: true,
      data: { driveFileId: file.id, fileName: file.name },
    });
  } catch (error) {
    return next(error);
  }
}

async function saveFlyerToDrive(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'El identificador del formulario no es válido.' });
  }
  const pptxFile = req.files?.pptx?.[0];
  const imageFile = req.files?.image?.[0];
  if (!pptxFile || !imageFile) {
    return res.status(400).json({ success: false, message: 'Adjunta el PPTX editable y la imagen PNG del flyer.' });
  }
  if (pptxFile.mimetype !== PPTX_MIME_TYPE
    || !pptxFile.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return res.status(400).json({ success: false, message: 'El archivo editable no es un PPTX válido.' });
  }
  if (imageFile.mimetype !== 'image/png' || !imageFile.buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return res.status(400).json({ success: false, message: 'La imagen del flyer debe ser un PNG válido.' });
  }

  try {
    const form = await Formulario.findById(req.params.id).lean();
    if (!form) return res.status(404).json({ success: false, message: 'No se encontró el formulario.' });
    const data = await saveFormularioFlyerFiles(createGoogleDriveClient(), {
      form,
      pptxBuffer: pptxFile.buffer,
      imageBuffer: imageFile.buffer,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  generateFlyerBackground,
  getFlyerBackgroundImage,
  getFlyerBackgrounds,
  receiveFlyerFiles,
  saveFlyerToDrive,
  selectFlyerBackground,
};
