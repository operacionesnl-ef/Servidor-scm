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

function getPictureBounds(xml, shapeName) {
  const picture = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)]
    .map((match) => match[0])
    .find((shape) => new RegExp(`<p:cNvPr\\b[^>]*\\bname="${shapeName}"`).test(shape));
  const values = picture?.match(/<a:xfrm\b[^>]*>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\s*\/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/);
  assert.ok(values, `missing picture geometry for ${shapeName}`);
  return values.slice(1).map(Number);
}

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
  assert.match(slideOne, /name="imagen2txt"[\s\S]*?<a:t>IMAGEN 2<\/a:t>/);
  assert.match(slideOneRels, /Target="\.\.\/media\/anx_image_1\.png"/);
  assert.equal(Object.keys(result.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 1);
  assert.equal(slideTen, null);
  assert.ok(result.file('ppt/media/anx_image_40.png'));
});

test('lays out up to four separate photos inside one finding image area', async () => {
  const dimensions = [[400, 100], [100, 400], [300, 200], [200, 300]];
  const images = await Promise.all(dimensions.map(async ([width, height], index) => ({
    numero: index + 1,
    findingId: 'finding-123456',
    mimeType: 'image/png',
    buffer: await sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
    }).png().toBuffer(),
  })));
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const originalSlide = await template.file('ppt/slides/slide1.xml').async('string');
  const result = await JSZip.loadAsync(await generateAnxPowerPointBuffer(images));
  const generatedSlide = await result.file('ppt/slides/slide1.xml').async('string');

  const [originalX, originalY, originalWidth, originalHeight] = getPictureBounds(originalSlide, 'imagen1');
  assert.match(generatedSlide, /<a:t>IMAGEN 1<\/a:t>/);
  assert.doesNotMatch(generatedSlide, /<a:t>IMAGEN 1, 2/);
  const generatedZip = await JSZip.loadAsync(await generateAnxPowerPointBuffer(images));
  const bounds = [];
  const gap = Math.min(originalWidth, originalHeight) * 0.015;
  const expectedPhotoWidth = (originalWidth - gap * (dimensions.length - 1)) / dimensions.length;
  for (let index = 0; index < dimensions.length; index += 1) {
    const shapeName = index === 0 ? 'imagen1' : `imagen1-photo-${index + 1}`;
    const [x, y, width, height] = getPictureBounds(generatedSlide, shapeName);
    const metadata = await sharp(await generatedZip.file(`ppt/media/anx_image_${index + 1}.png`).async('nodebuffer')).metadata();
    assert.equal(height, originalHeight);
    assert.ok(Math.abs(width - expectedPhotoWidth) <= 1);
    assert.ok(x >= originalX && y >= originalY);
    assert.ok(x + width <= originalX + originalWidth);
    assert.ok(y + height <= originalY + originalHeight);
    assert.equal(metadata.width, dimensions[index][0]);
    assert.equal(metadata.height, dimensions[index][1]);
    bounds.push({ x, y, width, height });
  }
  for (let left = 0; left < bounds.length; left += 1) {
    for (let right = left + 1; right < bounds.length; right += 1) {
      const a = bounds[left];
      const b = bounds[right];
      if (right === left + 1) assert.ok(Math.abs(b.x - a.x - a.width - gap) <= 1);
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
});

test('stretches a single portrait photo to fill the full image area', async () => {
  const image = await sharp({
    create: { width: 400, height: 900, channels: 3, background: { r: 20, g: 120, b: 200 } },
  }).png().toBuffer();
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const originalSlide = await template.file('ppt/slides/slide1.xml').async('string');
  const generated = await JSZip.loadAsync(await generateAnxPowerPointBuffer([
    { numero: 1, mimeType: 'image/png', buffer: image },
  ]));
  const generatedSlide = await generated.file('ppt/slides/slide1.xml').async('string');
  const [originalX, originalY, originalWidth, originalHeight] = getPictureBounds(originalSlide, 'imagen1');
  const [x, y, width, height] = getPictureBounds(generatedSlide, 'imagen1');
  const imageMetadata = await sharp(
    await generated.file('ppt/media/anx_image_1.png').async('nodebuffer'),
  ).metadata();

  assert.equal(x, originalX);
  assert.equal(y, originalY);
  assert.equal(width, originalWidth);
  assert.equal(height, originalHeight);
  assert.notEqual(width / height, imageMetadata.width / imageMetadata.height);
});

test('numbers finding image areas continuously across slides', async () => {
  const template = await JSZip.loadAsync(await fs.readFile(TEMPLATE_PATH));
  const image = await template.file('ppt/media/image2.png').async('nodebuffer');
  const groupSizes = [2, 1, 3, 1, 1, 2, 1];
  const images = [];
  let numero = 1;
  for (const [findingIndex, count] of groupSizes.entries()) {
    for (let photoIndex = 0; photoIndex < count; photoIndex += 1) {
      images.push({
        numero,
        findingId: `finding-${findingIndex + 1}`,
        mimeType: 'image/png',
        buffer: image,
      });
      numero += 1;
    }
  }
  const generated = await JSZip.loadAsync(await generateAnxPowerPointBuffer(images));
  const secondSlide = await generated.file('ppt/slides/slide2.xml').async('string');

  assert.match(secondSlide, /<a:t>IMAGEN 5<\/a:t>/);
  assert.match(secondSlide, /<a:t>IMAGEN 6<\/a:t>/);
  assert.match(secondSlide, /<a:t>IMAGEN 7<\/a:t>/);
  assert.doesNotMatch(secondSlide, /<a:t>IMAGEN 8<\/a:t>/);
});

test('normalizes photo orientation and caps embedded image dimensions', async () => {
  const image = await sharp({
    create: { width: 1800, height: 900, channels: 3, background: { r: 20, g: 120, b: 200 } },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const generated = await generateAnxPowerPointBuffer([
    { numero: 1, mimeType: 'image/jpeg', buffer: image },
  ]);
  const zip = await JSZip.loadAsync(generated);
  const embedded = await sharp(await zip.file('ppt/media/anx_image_1.jpg').async('nodebuffer')).metadata();
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  const [x, y, width, height] = getPictureBounds(slide, 'imagen1');

  assert.equal(embedded.width, 800);
  assert.equal(embedded.height, 1600);
  assert.equal(embedded.orientation, undefined);
  assert.notEqual(width / height, embedded.width / embedded.height);
  assert.ok(x >= 0 && y >= 0);
});

test('uses a one-month interval by default in the ANX-FOT filename', () => {
  assert.equal(buildAnxFileName({
    agencyFileNameCodeSnapshot: 'TOY-SEN-NL',
    generalData: { inspectionDate: '2026-10-01' },
  }), 'ANX-FOT-TOY-SEN-NL-(01-10-2026)-(01-11-2026).pptx');
});

test('uses the configured month interval in the ANX-FOT filename', () => {
  assert.equal(buildAnxFileName({
    agencyFileNameCodeSnapshot: 'TOY-SEN-NL',
    generalData: {
      inspectionDate: '2026-10-01',
      startDate: '2026-10-01',
      endDate: '2026-10-01',
    },
  }, 2), 'ANX-FOT-TOY-SEN-NL-(01-10-2026)-(01-12-2026).pptx');
});

test('uses the configured two-month interval from September through November', () => {
  assert.equal(buildAnxFileName({
    agencyFileNameCodeSnapshot: 'ALT-DEL-CUU',
    generalData: { inspectionDate: '2026-09-01', startDate: '2026-09-01' },
  }, 2), 'ANX-FOT-ALT-DEL-CUU-(01-09-2026)-(01-11-2026).pptx');
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
    const generatedLogo = await sharp(await result.file(`ppt/media/${logoPath}`).async('nodebuffer'))
      .raw().toBuffer({ resolveWithObject: true });
    const expectedLogo = await sharp(normalizedLogo).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(generatedLogo.info, expectedLogo.info);
    assert.deepEqual(generatedLogo.data, expectedLogo.data);
  }
});
