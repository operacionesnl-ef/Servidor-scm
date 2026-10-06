const Template = require('../models/Template');
const { logError } = require('../utils/consoleLogger');

const getTemplates = async (req, res) => {
  try {
    const templates = await Template.find()
      .sort({ activa: -1, createdAt: 1 })
      .lean();

    res.json({ ok: true, data: templates });
  } catch (error) {
    logError('No se pudieron cargar las plantillas', error);
    res.status(500).json({ ok: false, message: 'No se pudieron obtener las plantillas.' });
  }
};

const getMeta = (_req, res) => {
  res.json({
    ok: true,
    data: {
      variablesDisponibles: Template.VARIABLES_DISPONIBLES,
      codigosArchivos:      Template.CODIGOS_ARCHIVOS,
    },
  });
};

const getTemplateByKey = async (req, res) => {
  try {
    const template = await Template.findOne({ key: req.params.key.toLowerCase() }).lean();

    if (!template) {
      return res.status(404).json({ ok: false, message: 'Plantilla no encontrada.' });
    }

    res.json({ ok: true, data: template });
  } catch (error) {
    logError('No se pudo consultar la plantilla', error);
    res.status(500).json({ ok: false, message: 'No se pudo obtener la plantilla.' });
  }
};

const createTemplate = async (req, res) => {
  try {
    const { key, nombre, asunto, cuerpo, archivosIndividuales, archivosGlobales, activa } = req.body;

    if (!key || !nombre) {
      return res.status(400).json({ ok: false, message: 'Los campos key y nombre son obligatorios.' });
    }

    const exists = await Template.findOne({ key: key.toLowerCase().trim() });
    if (exists) {
      return res.status(409).json({ ok: false, message: `Ya existe una plantilla con la key "${key}".` });
    }

    const template = await Template.create({
      key:                  key.toLowerCase().trim(),
      nombre:               nombre.trim(),
      asunto:               asunto  || '',
      cuerpo:               cuerpo  || '',
      archivosIndividuales: archivosIndividuales || [],
      archivosGlobales:     archivosGlobales     || [],
      activa:               activa !== undefined ? activa : true,
    });

    res.status(201).json({ ok: true, data: template });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ ok: false, message: 'Ya existe una plantilla con esa key.' });
    }
    logError('No se pudo crear la plantilla', error);
    res.status(500).json({ ok: false, message: 'No se pudo crear la plantilla.' });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const { nombre, asunto, cuerpo, archivosIndividuales, archivosGlobales, activa } = req.body;

    const allowed = {};
    if (nombre               !== undefined) allowed.nombre               = nombre.trim();
    if (asunto               !== undefined) allowed.asunto               = asunto;
    if (cuerpo               !== undefined) allowed.cuerpo               = cuerpo;
    if (archivosIndividuales !== undefined) allowed.archivosIndividuales = archivosIndividuales;
    if (archivosGlobales     !== undefined) allowed.archivosGlobales     = archivosGlobales;
    if (activa               !== undefined) allowed.activa               = activa;

    if (!Object.keys(allowed).length) {
      return res.status(400).json({ ok: false, message: 'No se enviaron campos para actualizar.' });
    }

    const template = await Template.findOneAndUpdate(
      { key: req.params.key.toLowerCase() },
      { $set: allowed },
      { new: true, runValidators: true }
    );

    if (!template) {
      return res.status(404).json({ ok: false, message: 'Plantilla no encontrada.' });
    }

    res.json({ ok: true, data: template });
  } catch (error) {
    logError('No se pudo actualizar la plantilla', error);
    res.status(500).json({ ok: false, message: 'No se pudo actualizar la plantilla.' });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const template = await Template.findOneAndDelete({ key: req.params.key.toLowerCase() });

    if (!template) {
      return res.status(404).json({ ok: false, message: 'Plantilla no encontrada.' });
    }

    req.auditRecovery = { entity: 'Template', snapshot: template.toObject({ depopulate: true }) };
    res.json({ ok: true, message: 'Plantilla eliminada correctamente.' });
  } catch (error) {
    logError('No se pudo eliminar la plantilla', error);
    res.status(500).json({ ok: false, message: 'No se pudo eliminar la plantilla.' });
  }
};

const toggleTemplate = async (req, res) => {
  try {
    const template = await Template.findOne({ key: req.params.key.toLowerCase() });

    if (!template) {
      return res.status(404).json({ ok: false, message: 'Plantilla no encontrada.' });
    }

    template.activa = !template.activa;
    await template.save();

    res.json({ ok: true, data: template });
  } catch (error) {
    logError('No se pudo cambiar el estado de la plantilla', error);
    res.status(500).json({ ok: false, message: 'No se pudo cambiar el estado de la plantilla.' });
  }
};

module.exports = {
  getTemplates,
  getMeta,
  getTemplateByKey,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  toggleTemplate,
};