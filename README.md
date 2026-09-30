# Node.js + Express + MongoDB Base

## Instalación
```bash
npm install
```

## Variables de entorno
Copia `.env.example` a `.env` y configura tus variables.

## Scripts
```bash
npm run dev   # Desarrollo con nodemon
npm start     # Producción
```

## Envío con Gmail API
Habilita Gmail API en el mismo proyecto de Google Cloud que usa el front. La cuenta debe autorizar el permiso `https://www.googleapis.com/auth/gmail.send` la primera vez que envía un correo. Si la pantalla de consentimiento está en modo de pruebas, agrega esa cuenta como usuario de prueba.

El front envía `POST /api/gmail/send` con el JWT de sesión y el access token de Gmail. El servidor solo permite enviar si ambos tokens pertenecen al mismo usuario activo.

## Estructura
```
src/
├── config/         # DB y variables de entorno
├── controllers/    # Lógica de cada recurso
├── middlewares/    # Error handler, notFound
├── models/         # Schemas de Mongoose
├── routes/         # Definición de rutas
└── utils/          # Helpers reutilizables
logs/               # Logs del servidor
```
