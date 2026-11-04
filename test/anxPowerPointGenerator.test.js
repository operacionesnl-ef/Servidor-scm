'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const JSZip = require('jszip');
const sharp = require('sharp');
const {
  buildAnxFileName,
  generateAnxPowerPointBuffer,
} = require('../src/formatosGeneradores/anx/services/anxPowerPointGenerator');

const TEMPLATE_PATH = path.join(__dirname, '../src/formatosGeneradores/anx/templates/ANX-FOT.pptx');

test('keeps only slides needed for images and removes unused image slots', async () => {
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const image = await template.file('ppt/media/image2.png').async('nodebuffer');
  const result = await JSZip.loadAsync(await generateAnxPowerPointBuffer([
    { numero: 1, mimeType: 'image/png', buffer: image },
    { numero: 40, mimeType: 'image/png', buffer: image },
  ]));
  const slideOne = await result.file('ppt/slides/slide1.xml').async('string');
  const slideTen = result.file('ppt/slides/slide10.xml');
  const slideOneRels = await result.file('ppt/slides/_rels/slide1.xml.rels').async('string');

  assert.match(slideOne, /name="imagen1"[\s\S]*?r:embed="rIdAnx1"/);
  assert.match(slideOne, /name="imagen1txt"[\s\S]*?<a:t>IMAGEN 1<\/a:t>/);
  assert.doesNotMatch(slideOne, /name="imagen3"/);
  assert.doesNotMatch(slideOne, /name="imagen3txt"/);
  assert.match(slideOne, /name="imagen2"[\s\S]*?r:embed="rIdAnx40"/);
  assert.match(slideOne, /name="imagen2txt"[\s\S]*?<a:t>IMAGEN 40<\/a:t>/);
  assert.match(slideOneRels, /Target="\.\.\/media\/anx_image_1\.png"/);
  assert.equal(Object.keys(result.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 1);
  assert.equal(slideTen, null);
  assert.ok(result.file('ppt/media/anx_image_40.png'));
});

test('uses the ANX-FOT filename convention from the report agency code and visit date', () => {
  assert.equal(buildAnxFileName({
    agencyFileNameCodeSnapshot: 'TOY-SEN-NL',
    generalData: { inspectionDate: '2026-10-01' },
  }), 'ANX-FOT-TOY-SEN-NL-(01-10-26)-(01-11-26).pptx');
});

test('retains three slides for ten images', async () => {
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const image = await template.file('ppt/media/image2.png').async('nodebuffer');
  const images = Array.from({ length: 10 }, (_, index) => ({
    numero: index + 1,
    mimeType: 'image/png',
    buffer: image,
  }));
  const result = await JSZip.loadAsync(await generateAnxPowerPointBuffer(images, {
    logoBuffer: image,
    logoMimeType: 'image/png',
  }));
  const presentation = await result.file('ppt/presentation.xml').async('string');
  const presentationRels = await result.file('ppt/_rels/presentation.xml.rels').async('string');
  const normalizedLogo = await sharp(image).png().toBuffer();

  assert.equal(Object.keys(result.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 3);
  assert.equal(result.file('ppt/slides/slide4.xml'), null);
  assert.equal([...presentation.matchAll(/<p:sldId\b/g)].length, 3);
  assert.equal([...presentationRels.matchAll(/\/slide"/g)].length, 3);
  for (let slideNumber = 1; slideNumber <= 3; slideNumber += 1) {
    const slide = await result.file(`ppt/slides/slide${slideNumber}.xml`).async('string');
    const relations = await result.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`).async('string');
    const logoPicture = slide.match(/<p:pic\b[\s\S]*?<p:cNvPr\b[^>]*\bname="logo"[\s\S]*?<\/p:pic>/i)?.[0];
    const logoId = logoPicture?.match(/r:embed="([^"]+)"/)?.[1];
    const logoRelation = relations.match(new RegExp(`<Relationship\\b(?=[^>]*\\bId="${logoId}")([^>]*)\\/>`));
    const logoPath = logoRelation?.[1].match(/\bTarget="\.\.\/media\/([^"]+)"/)?.[1];
    assert.ok(logoPath);
    assert.deepEqual(await result.file(`ppt/media/${logoPath}`).async('nodebuffer'), normalizedLogo);
  }
});
