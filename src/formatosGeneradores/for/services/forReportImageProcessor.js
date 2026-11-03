'use strict';

const sharp = require('sharp');

const MAX_IMAGE_WIDTH = 1920;
const MAX_IMAGE_HEIGHT = 1080;
const MAX_INPUT_PIXELS = 100_000_000;

class ImageProcessingError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ImageProcessingError';
  }
}

async function processForReportImage(buffer, mimeType) {
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await image.metadata();
    const oriented = metadata.autoOrient || { width: metadata.width, height: metadata.height };
    if (!metadata.width || !metadata.height || metadata.format !== mimeType.split('/')[1]) {
      throw new ImageProcessingError('El archivo no es una imagen válida del tipo indicado.');
    }

    if (oriented.width <= MAX_IMAGE_WIDTH && oriented.height <= MAX_IMAGE_HEIGHT) {
      return { buffer, width: oriented.width, height: oriented.height, resized: false };
    }

    let pipeline = image.rotate().resize({
      width: MAX_IMAGE_WIDTH,
      height: MAX_IMAGE_HEIGHT,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (mimeType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 90 });
    else if (mimeType === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 });
    else if (mimeType === 'image/webp') pipeline = pipeline.webp({ quality: 90 });

    const result = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height,
      resized: true,
    };
  } catch (error) {
    if (error instanceof ImageProcessingError) throw error;
    throw new ImageProcessingError('No se pudo procesar la imagen. Verifica que el archivo esté completo y sea válido.', error);
  }
}

module.exports = {
  ImageProcessingError,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  processForReportImage,
};
