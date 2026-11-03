'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const sharp = require('sharp');
const {
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  processForReportImage,
} = require('../src/formatosGeneradores/for/services/forReportImageProcessor');

test('keeps images within 1080p byte-for-byte unchanged', async () => {
  const original = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: '#336699' },
  }).jpeg().toBuffer();

  const processed = await processForReportImage(original, 'image/jpeg');

  assert.equal(processed.resized, false);
  assert.deepEqual(processed.buffer, original);
  assert.deepEqual([processed.width, processed.height], [1280, 720]);
});

test('resizes oversized images on the server while preserving aspect ratio and format', async () => {
  const original = await sharp({
    create: { width: 2560, height: 1440, channels: 3, background: '#336699' },
  }).jpeg().toBuffer();

  const processed = await processForReportImage(original, 'image/jpeg');
  const metadata = await sharp(processed.buffer).metadata();

  assert.equal(processed.resized, true);
  assert.ok(processed.width <= MAX_IMAGE_WIDTH);
  assert.ok(processed.height <= MAX_IMAGE_HEIGHT);
  assert.equal(Math.round(processed.width / processed.height * 100), Math.round(2560 / 1440 * 100));
  assert.equal(metadata.format, 'jpeg');
});

test('rejects a corrupt image instead of storing it unchanged', async () => {
  await assert.rejects(
    processForReportImage(Buffer.from('not an image'), 'image/jpeg'),
    /No se pudo procesar la imagen/,
  );
});
