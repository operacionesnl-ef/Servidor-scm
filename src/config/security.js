const allowedOrigins = (process.env.CORS_ORIGINS || [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:43127',
  'https://0sj2cvrmofimguhvqrrmcmasqex7uqfvc8yc3.netlify.app',
].join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}

module.exports = { allowedOrigins, isAllowedOrigin };
