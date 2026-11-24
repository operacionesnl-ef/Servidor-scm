
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');
const sharp = require('sharp');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ============================================
// CONFIGURACIÓN
// ============================================

const MODEL = '@cf/black-forest-labs/flux-1-schnell';

const IMAGE_CONFIG = {
  width: 1024,
  height: 1280,
  steps: 4,
  finalWidth: 1687,
  finalHeight: 2107,
  quality: 92,
};

// ============================================
// PROMPT MAESTRO
// ============================================


function buildMasterPrompt(course, norms) {
  const prompt = `
Create ONE professional image representing this training course.

COURSE: ${course}
REFERENCE REGULATIONS: ${norms}

UNDERSTAND THE SUBJECT:
Interpret the course and regulations to identify what is actually
being taught. Determine the most representative people, activities,
objects, tools, environments, natural elements or concepts.

Act as a professional art director. Independently choose the best
visual representation for this exact subject. Do not use generic
stock scenes or repeat a fixed composition.

SCENE:
Create a specific, recognizable scene that communicates the course
immediately. Show people actively performing relevant tasks when
appropriate. For conceptual topics, make meaningful objects,
nature, technology or symbols the main subjects.
Combine elements only when they improve understanding.

Make the main subject large, prominent and clearly recognizable.
Show meaningful actions and relevant details. Every element must
help communicate the course.

QUALITY:
Professional, polished and visually engaging.
Sharp focus, excellent visibility, bright balanced lighting,
natural colors and realistic details.
Use the visual style best suited to the subject.
Avoid blur, dark scenes, clutter and distant subjects.

IMAGE ONLY:
Absolutely NO text, words, letters, numbers, typography, titles,
captions, labels, signs, logos, watermarks or written content.
Never create posters, covers, infographics or advertisements.
Do not write the course name in the image.

Vertical portrait, approximately 4:5.
One coherent scene with a clear focal point.
Prioritize subject accuracy and immediate recognition.

Return only the image.
`.trim();

  if (prompt.length > 2048) {
    throw new Error(
      `Prompt exceeds FLUX limit: ${prompt.length}/2048 characters.`
    );
  }

  console.log(`Prompt length: ${prompt.length}/2048 characters`);

  return prompt;
}



// ============================================
// GENERADOR DE IMÁGENES
// ============================================

async function generateImage({
  course,
  norms,
  outputFile = 'portada-curso.jpg',
}) {
  // Validar entradas
  if (!course || typeof course !== 'string') {
    throw new Error('Debes proporcionar el nombre del curso.');
  }

  if (!norms || typeof norms !== 'string') {
    throw new Error('Debes proporcionar las normas aplicables.');
  }

  // Credenciales
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const apiToken =
    process.env.CLOUD_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error(
      'Faltan CLOUDFLARE_ACCOUNT_ID o CLOUD_API_TOKEN en .env.'
    );
  }

  if (typeof fetch !== 'function') {
    throw new Error(
      'Se requiere Node.js 18 o superior.'
    );
  }

  // Construir prompt
  const prompt = buildMasterPrompt(course, norms);

  console.log('\n====================================');
  console.log('CLOUDFLARE IMAGE GENERATION');
  console.log('====================================');
  console.log(`Curso: ${course}`);
  console.log(`Normativa: ${norms}`);
  console.log(`Modelo: ${MODEL}`);
  console.log(`Pasos: ${IMAGE_CONFIG.steps}`);
  console.log('====================================\n');

  // Solicitud a Cloudflare
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        steps: IMAGE_CONFIG.steps,
      }),
    }
  );

  // Procesar respuesta
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Respuesta no válida de Cloudflare (HTTP ${response.status}).`
    );
  }

  if (!response.ok || !data || data.success !== true) {
    const details = Array.isArray(data?.errors)
      ? data.errors.map((error) => {
        const code =
          error?.code == null ? '' : `[${error.code}] `;

        return `${code}${error?.message || ''}`.trim();
      }).filter(Boolean).join('; ')
      : '';

    const message =
      `Cloudflare image generation failed (HTTP ${response.status})`;

    throw new Error(
      details ? `${message}: ${details}` : `${message}.`
    );
  }

  // Validar imagen recibida
  if (
    typeof data.result?.image !== 'string' ||
    !data.result.image
  ) {
    throw new Error(
      'Cloudflare respondió correctamente, pero no devolvió una imagen.'
    );
  }

  const imageBuffer = Buffer.from(
    data.result.image,
    'base64'
  );

  if (!imageBuffer.length) {
    throw new Error('La imagen recibida está vacía.');
  }

  // Ajustar dimensiones exactas con Sharp
  console.log('Procesando imagen con Sharp...');

  const finalImage = await sharp(imageBuffer)
    .resize({
      width: IMAGE_CONFIG.finalWidth,
      height: IMAGE_CONFIG.finalHeight,
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    })
    .jpeg({
      quality: IMAGE_CONFIG.quality,
      mozjpeg: true,
    })
    .toBuffer();

  // Guardar archivo
  const outputPath = outputFile ? path.resolve(outputFile) : null;

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), {
      recursive: true,
    });

    await fs.writeFile(outputPath, finalImage);
  }

  // Verificar dimensiones finales
  const metadata = await sharp(finalImage).metadata();

  if (
    metadata.width !== IMAGE_CONFIG.finalWidth ||
    metadata.height !== IMAGE_CONFIG.finalHeight
  ) {
    throw new Error('Las dimensiones finales no son correctas.');
  }

  console.log('\n====================================');
  console.log('IMAGEN GENERADA CORRECTAMENTE');
  console.log('====================================');
  console.log(`Archivo: ${outputPath || 'No guardado (respuesta en memoria)'}`);
  console.log(`Dimensiones: ${metadata.width} x ${metadata.height}`);
  console.log(`Formato: ${metadata.format}`);
  console.log(`Tamaño: ${(finalImage.length / 1024).toFixed(2)} KB`);
  console.log('====================================\n');

  return {
    success: true,
    outputPath,
    imageBuffer: finalImage,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    size: finalImage.length,
  };
}

// ============================================
// EJECUCIÓN DESDE TERMINAL
// ============================================

if (require.main === module) {
  const course = process.argv[2];
  const norms = process.argv[3];
  const outputFile = process.argv[4] || 'portada-curso.jpg';

  generateImage({
    course,
    norms,
    outputFile,
  }).catch((error) => {
    console.error('\nCloudflare image test failed:');
    console.error(error.message);

    process.exitCode = 1;
  });
}

module.exports = {
  generateImage,
  buildMasterPrompt,
};
