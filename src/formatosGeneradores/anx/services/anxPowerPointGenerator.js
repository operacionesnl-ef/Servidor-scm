'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const sharp = require('sharp');

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

function buildAnxFileName(report) {
  const date = report.generalData.startDate || report.generalData.inspectionDate;
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  const endDate = new Date(Date.UTC(year, month - 1, day));
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  if (endDate.getUTCDate() !== day) endDate.setUTCDate(0);
  const dateToken = (value) => `(${String(value.getUTCDate()).padStart(2, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCFullYear()).slice(-2)})`;
  const code = String(report.agencyFileNameCodeSnapshot || 'SIN-CODIGO')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'SIN-CODIGO';
  return `ANX-FOT-${code}-${dateToken(new Date(Date.UTC(year, month - 1, day)))}-${dateToken(endDate)}.pptx`;
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

function removeNamedShape(xml, shapeName) {
  const removedRelationships = [];
  const updated = xml.replace(/<p:(sp|pic)\b[\s\S]*?<\/p:\1>/g, (shape) => {
    if (!new RegExp(`<p:cNvPr\\b[^>]*\\bname="${shapeName}"`, 'i').test(shape)) return shape;
    const relationshipId = shape.match(/r:embed="([^"]+)"/)?.[1];
    if (relationshipId) removedRelationships.push(relationshipId);
    return '';
  });
  return { xml: updated, removedRelationships };
}

function removeRelationships(xml, relationshipIds) {
  return xml.replace(/<Relationship\b[^>]*\/>/g, (relationship) => (
    relationshipIds.some((id) => new RegExp(`\\bId="${id}"`).test(relationship)) ? '' : relationship
  ));
}

async function replaceLogo(zip, slidePath, xml, rels, logoBuffer, logoMimeType) {
  const shapeName = /name="logo"/i.test(xml) ? 'logo' : 'Logo';
  const shape = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)]
    .find((match) => new RegExp(`<p:cNvPr\\b[^>]*\\bname="${shapeName}"`, 'i').test(match[0]));
  if (!shape) return { xml, rels };
  const relationshipId = shape[0].match(/r:embed="([^"]+)"/)?.[1];
  const relationship = rels.match(new RegExp(`<Relationship\\b(?=[^>]*\\bId="${relationshipId}")([^>]*)\\/>`));
  const target = relationship?.[1].match(/\bTarget="([^"]+)"/)?.[1];
  if (!relationshipId || !target) throw new AnxPowerPointError('El logotipo de la plantilla ANX no tiene una relación válida.');
  const mediaPath = path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), target));
  const extension = path.posix.extname(mediaPath).slice(1).toLowerCase();
  const converted = extension === 'png' ? await sharp(logoBuffer).png().toBuffer()
    : ['jpg', 'jpeg'].includes(extension) ? await sharp(logoBuffer).jpeg().toBuffer()
      : extension === 'webp' ? await sharp(logoBuffer).webp().toBuffer()
        : null;
  if (!converted || !['image/png', 'image/jpeg', 'image/webp'].includes(logoMimeType)) {
    throw new AnxPowerPointError('El formato del logotipo de la sucursal no es compatible.');
  }
  zip.file(mediaPath, converted);
  return { xml, rels };
}

function getRelationshipAttributes(xml) {
  return [...xml.matchAll(/<Relationship\b([^>]*)\/>/g)].map((match) => ({
    raw: match[0],
    ...Object.fromEntries([...match[1].matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)]
      .map((attribute) => [attribute[1], attribute[2]])),
  }));
}

async function removeUnusedSlides(zip, slideCount) {
  const presentationPath = 'ppt/presentation.xml';
  const relationshipsPath = 'ppt/_rels/presentation.xml.rels';
  const presentation = await zip.file(presentationPath)?.async('string');
  const relationships = await zip.file(relationshipsPath)?.async('string');
  if (!presentation || !relationships) {
    throw new AnxPowerPointError('La plantilla ANX no contiene relaciones válidas para sus diapositivas.');
  }
  const slideRelations = getRelationshipAttributes(relationships)
    .map((relation) => ({
      ...relation,
      slideNumber: Number(relation.Target?.match(/slide(\d+)\.xml$/)?.[1]),
    }))
    .filter(({ Type, slideNumber }) => Type?.endsWith('/slide') && slideNumber > slideCount);
  const removedIds = new Set(slideRelations.map(({ Id }) => Id));
  zip.file(presentationPath, presentation.replace(/<p:sldId\b[^>]*\/>/g, (slide) => (
    removedIds.has(slide.match(/\br:id="([^"]+)"/)?.[1]) ? '' : slide
  )));
  zip.file(relationshipsPath, relationships.replace(/<Relationship\b[^>]*\/>/g, (relation) => (
    slideRelations.some(({ Id }) => new RegExp(`\\bId="${Id}"`).test(relation)) ? '' : relation
  )));
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  for (const { slideNumber } of slideRelations) {
    zip.remove(`ppt/slides/slide${slideNumber}.xml`);
    zip.remove(`ppt/slides/_rels/slide${slideNumber}.xml.rels`);
    contentTypes = contentTypes.replace(
      new RegExp(`<Override\\b(?=[^>]*PartName="/ppt/slides/slide${slideNumber}\\.xml")[^>]*/>`),
      '',
    );
  }
  zip.file('[Content_Types].xml', contentTypes);
}

async function generateAnxPowerPointBuffer(images, { logoBuffer, logoMimeType } = {}) {
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
  if (!imageList.length) throw new AnxPowerPointError('ANX requiere al menos una imagen.');
  const slideCount = Math.ceil(imageList.length / 4);
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

  for (let slideNumber = 1; slideNumber <= slideCount; slideNumber += 1) {
    const slidePath = `ppt/slides/slide${slideNumber}.xml`;
    const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const slideFile = zip.file(slidePath);
    const relsFile = zip.file(relationshipsPath);
    if (!slideFile || !relsFile) throw new AnxPowerPointError(`Falta la diapositiva ${slideNumber} o sus relaciones.`);
    let xml = await slideFile.async('string');
    let rels = await relsFile.async('string');
    if (logoBuffer?.length) {
      ({ xml, rels } = await replaceLogo(zip, slidePath, xml, rels, logoBuffer, logoMimeType));
    }
    for (let slot = 1; slot <= 4; slot += 1) {
      const image = imageList[(slideNumber - 1) * 4 + slot - 1];
      if (!image) {
        const picture = removeNamedShape(xml, `imagen${slot}`);
        const caption = removeNamedShape(picture.xml, `imagen${slot}txt`);
        xml = caption.xml;
        rels = removeRelationships(rels, [...picture.removedRelationships, ...caption.removedRelationships]);
        continue;
      }
      const numero = image.numero;
      const relationshipId = `rIdAnx${numero}`;
      const extension = IMAGE_TYPES.get(image.mimeType);
      const mediaName = `anx_image_${numero}.${extension}`;
      xml = updatePicture(xml, `imagen${slot}`, relationshipId);
      rels = rels.replace('</Relationships>',
        `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/></Relationships>`);
      zip.file(`ppt/media/${mediaName}`, image.buffer);
      xml = replaceTextForShape(xml, `imagen${slot}txt`, `IMAGEN ${numero}`);
    }
    await removeUnusedSlides(zip, slideCount);
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
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

module.exports = { AnxPowerPointError, buildAnxFileName, generateAnxPowerPointBuffer };
