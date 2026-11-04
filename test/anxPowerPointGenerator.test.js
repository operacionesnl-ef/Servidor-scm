'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const JSZip = require('jszip');
const { generateAnxPowerPointBuffer } = require('../src/formatosGeneradores/anx/services/anxPowerPointGenerator');

const TEMPLATE_PATH = path.join(__dirname, '../src/formatosGeneradores/anx/templates/ANX-FOT.pptx');

test('replaces template image and caption while retaining all ten template slides', async () => {
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const image = await template.file('ppt/media/image2.png').async('nodebuffer');
  const result = await JSZip.loadAsync(await generateAnxPowerPointBuffer([
    { numero: 1, mimeType: 'image/png', buffer: image },
    { numero: 40, mimeType: 'image/png', buffer: image },
  ]));
  const slideOne = await result.file('ppt/slides/slide1.xml').async('string');
  const slideTen = await result.file('ppt/slides/slide10.xml').async('string');
  const slideOneRels = await result.file('ppt/slides/_rels/slide1.xml.rels').async('string');

  assert.match(slideOne, /name="imagen1"[\s\S]*?r:embed="rIdAnx1"/);
  assert.match(slideOne, /name="imagen1txt"[\s\S]*?<a:t>IMAGEN 1<\/a:t>/);
  assert.match(slideTen, /name="imagen4"[\s\S]*?r:embed="rIdAnx40"/);
  assert.match(slideTen, /name="imagen4txt"[\s\S]*?<a:t>IMAGEN 40<\/a:t>/);
  assert.match(slideOneRels, /Target="\.\.\/media\/anx_image_1\.png"/);
  assert.equal(Object.keys(result.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 10);
  assert.ok(result.file('ppt/media/anx_image_40.png'));
});
