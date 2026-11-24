'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sharp = require('sharp');
const { generateImage } = require('../src/scripts/testCloudflareImageGeneration');

async function withMockedCloudflare(mockFetch, run) {
  const previousFetch = global.fetch;
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousCloudToken = process.env.CLOUD_API_TOKEN;
  const previousCloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  delete process.env.CLOUD_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  global.fetch = mockFetch;

  try {
    await run();
  } finally {
    global.fetch = previousFetch;
    if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
    if (previousCloudToken === undefined) delete process.env.CLOUD_API_TOKEN;
    else process.env.CLOUD_API_TOKEN = previousCloudToken;
    if (previousCloudflareToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousCloudflareToken;
  }
}

test('resizes and saves the returned image using the configured Cloudflare token', async () => {
  const image = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).png().toBuffer();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudflare-image-test-'));
  const outputPath = path.join(tempDir, 'image.jpg');
  try {
    await withMockedCloudflare(async (url, options) => {
      assert.match(url, /\/accounts\/test-account\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      const request = JSON.parse(options.body);
      assert.match(request.prompt, /COURSE: Seguridad eléctrica/);
      assert.match(request.prompt, /REFERENCE REGULATIONS: NOM-029-STPS-2011/);
      assert.equal(request.steps, 4);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { image: image.toString('base64') } }),
      };
    }, async () => {
      const result = await generateImage({
        course: 'Seguridad eléctrica',
        norms: 'NOM-029-STPS-2011',
        outputFile: outputPath,
      });
      assert.deepEqual(await fs.readFile(outputPath), result.imageBuffer);
      assert.equal(result.width, 1687);
      assert.equal(result.height, 2107);
      assert.equal(result.format, 'jpeg');
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('returns the generated image without writing a file when outputFile is null', async () => {
  const image = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).png().toBuffer();

  await withMockedCloudflare(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { image: image.toString('base64') } }),
  }), async () => {
    const result = await generateImage({
      course: 'Seguridad industrial',
      norms: 'Higiene y Seguridad',
      outputFile: null,
    });

    assert.equal(result.outputPath, null);
    assert.equal(result.imageBuffer.length > 0, true);
    assert.equal(result.format, 'jpeg');
  });
});

test('reports Cloudflare API errors instead of writing an image', async () => {
  await withMockedCloudflare(async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    }),
  }), async () => {
    await assert.rejects(
      generateImage({
        course: 'Seguridad industrial',
        norms: 'Higiene y Seguridad',
        outputFile: path.join(os.tmpdir(), 'cloudflare-image-should-not-exist.jpg'),
      }),
      /HTTP 401\): \[10000\] Authentication error/,
    );
  });
});
