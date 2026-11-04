'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, '../templates/ANX-FOT.pptx');
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

class AnxPowerPointError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'AnxPowerPointError';
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[character]));
}

function replaceTextForShape(xml, shapeName, text) {
  const shapePattern = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let found = false;
  const updated = xml.replace(shapePattern, (shape) => {
    if (!new RegExp(`<p:cNvPr\\b[^>]*\\bname="${shapeName}"`).test(shape)) return shape;
    found = true;
    let replaced = false;
    return shape.replace(/<a:t>[\s\S]*?<\/a:t>/g, (run) => {
      if (replaced) return '';
      replaced = true;
      return `<a:t>${escapeXml(text)}</a:t>`;
    });
  });
  if (!found) throw new AnxPowerPointError(`No se encontró el elemento de texto ${shapeName}.`);
  return updated;
}

function updatePicture(xml, shapeName, relationshipId) {
  const shapePattern = /<p:pic\b[\s\S]*?<\/p:pic>/g;
  let found = false;
  const updated = xml.replace(shapePattern, (shape) => {
    if (!new RegExp(`<p:cNvPr\\b[^>]*\\bname="${shapeName}"`).test(shape)) return shape;
    found = true;
    return shape.replace(/<a:blip\b([^>]*)>/, (tag, attributes) => {
      const next = attributes.replace(/\br:embed="[^"]*"/, `r:embed="${relationshipId}"`);
      return `<a:blip${next}>`;
    });
  });
  if (!found) throw new AnxPowerPointError(`No se encontró el elemento de imagen ${shapeName}.`);
  return updated;
}

async function generateAnxPowerPointBuffer(images) {
  const template = await fs.readFile(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(template);
  const presentation = zip.file('ppt/presentation.xml');
  if (!presentation) throw new AnxPowerPointError('La plantilla ANX no contiene una presentación válida.');
  const slideFiles = Object.keys(zip.files)
    .map((name) => name.match(/^ppt\/slides\/slide(\d+)\.xml$/))
    .filter(Boolean)
    .sort((left, right) => Number(left[1]) - Number(right[1]));
  if (slideFiles.length !== 10) throw new AnxPowerPointError('La plantilla ANX debe contener exactamente 10 diapositivas.');

  const imageList = [...images].sort((left, right) => left.numero - right.numero);
  const numbers = new Set();
  for (const image of imageList) {
    if (!Number.isInteger(image.numero) || image.numero < 1 || image.numero > 40 || numbers.has(image.numero)) {
      throw new AnxPowerPointError('ANX contiene una numeración de imágenes inválida o duplicada.');
    }
    if (!IMAGE_TYPES.has(image.mimeType) || !Buffer.isBuffer(image.buffer) || !image.buffer.length) {
      throw new AnxPowerPointError(`No se pudo recuperar la Imagen ${image.numero} o su tipo no está admitido.`);
    }
    numbers.add(image.numero);
  }

  for (let slideNumber = 1; slideNumber <= 10; slideNumber += 1) {
    const slidePath = `ppt/slides/slide${slideNumber}.xml`;
    const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const slideFile = zip.file(slidePath);
    const relsFile = zip.file(relationshipsPath);
    if (!slideFile || !relsFile) throw new AnxPowerPointError(`Falta la diapositiva ${slideNumber} o sus relaciones.`);
    let xml = await slideFile.async('string');
    let rels = await relsFile.async('string');
    for (let slot = 1; slot <= 4; slot += 1) {
      const numero = (slideNumber - 1) * 4 + slot;
      const image = imageList.find((entry) => entry.numero === numero);
      if (!image) continue;
      const relationshipId = `rIdAnx${numero}`;
      const extension = IMAGE_TYPES.get(image.mimeType);
      const mediaName = `anx_image_${numero}.${extension}`;
      xml = updatePicture(xml, `imagen${slot}`, relationshipId);
      rels = rels.replace('</Relationships>',
        `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/></Relationships>`);
      zip.file(`ppt/media/${mediaName}`, image.buffer);
      xml = replaceTextForShape(xml, `imagen${slot}txt`, `IMAGEN ${numero}`);
    }
    zip.file(slidePath, xml);
    zip.file(relationshipsPath, rels);
  }
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  for (const extension of new Set(imageList.map((image) => IMAGE_TYPES.get(image.mimeType)))) {
    const mimeType = [...IMAGE_TYPES].find(([, candidate]) => candidate === extension)?.[0];
    if (!contentTypes.includes(`Extension="${extension}"`)) {
      contentTypes = contentTypes.replace('</Types>',
        `<Default Extension="${extension}" ContentType="${mimeType}"/></Types>`);
    }
  }
  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { AnxPowerPointError, generateAnxPowerPointBuffer };
