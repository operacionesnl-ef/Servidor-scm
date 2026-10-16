'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyPersonalization = require('../models/AgencyPersonalization');
const AgencyTag = require('../models/AgencyTag');
const { AGENCY_TAG_COLORS } = require('../models/AgencyTag');
const { success } = require('../utils/response');
const { recordAgencyHistory } = require('../services/agencyHistory');

const ROLES = new Set(['developer', 'admin', 'user']);

async function migrateLegacyPersonalizations() {
  const agencies = await Agency.find({ personalizationMigrated: { $ne: true } })
    .select('_id favorite tags +personalizationMigrated')
    .lean();
  if (!agencies.length) return;

  const legacyPreferences = await AgencyPersonalization.find({
    agencyId: { $in: agencies.map(({ _id }) => _id) },
  }).select('agencyId favorite tags').lean();
  const legacyByAgency = new Map();
  legacyPreferences.forEach((preference) => {
    const agencyId = String(preference.agencyId);
    const current = legacyByAgency.get(agencyId) || { favorite: false, tagIds: new Set() };
    current.favorite ||= preference.favorite;
    (preference.tags || []).forEach((tagId) => current.tagIds.add(String(tagId)));
    legacyByAgency.set(agencyId, current);
  });

  await Promise.all(agencies.map((agency) => {
    const legacy = legacyByAgency.get(String(agency._id));
    const tagIds = new Set((agency.tags || []).map(String));
    legacy?.tagIds.forEach((tagId) => tagIds.add(tagId));
    return Agency.updateOne(
      { _id: agency._id, personalizationMigrated: { $ne: true } },
      {
        $set: {
          favorite: Boolean(agency.favorite || legacy?.favorite),
          tags: [...tagIds],
          personalizationMigrated: true,
        },
      },
    );
  }));
}

function validationFailure(res, errors) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors });
}

function validateTagInput(body, partial = false) {
  const errors = {};
  const value = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { body: 'A JSON object is required' }, value };
  }

  for (const field of Object.keys(body)) {
    if (!['name', 'color', 'allowedRoles'].includes(field)) errors[field] = 'Unknown field';
  }
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      errors.name = 'A tag name is required';
    } else if (body.name.trim().length > 40) {
      errors.name = 'Must not exceed 40 characters';
    } else {
      value.name = body.name.trim();
      value.nameKey = value.name.toLocaleLowerCase();
    }
  }
  if (!partial || body.color !== undefined) {
    if (!AGENCY_TAG_COLORS.includes(body.color)) errors.color = 'Choose one of the available colors';
    else value.color = body.color;
  }
  if (!partial || body.allowedRoles !== undefined) {
    if (!Array.isArray(body.allowedRoles) || body.allowedRoles.length === 0
      || body.allowedRoles.some((role) => !ROLES.has(role))) {
      errors.allowedRoles = 'Select at least one valid role';
    } else {
      value.allowedRoles = [...new Set(body.allowedRoles)];
    }
  }
  return { errors, value };
}

const getAgencyPersonalization = async (req, res, next) => {
  try {
    await migrateLegacyPersonalizations();
    const [tags, preferences] = await Promise.all([
      AgencyTag.find().sort({ name: 1 }).lean(),
      Agency.find({ $or: [{ favorite: true }, { tags: { $exists: true, $ne: [] } }] })
        .select('_id favorite tags')
        .lean(),
    ]);
    return success(res, {
      tags: tags.map(({ _id, name, color, allowedRoles }) => ({
        id: String(_id),
        name,
        color,
        allowedRoles,
        assignable: allowedRoles.includes(req.user.rol),
      })),
      preferences: preferences.map(({ _id, favorite, tags: assignedTags }) => ({
        agencyId: String(_id),
        favorite: Boolean(favorite),
        tagIds: (assignedTags || []).map(String),
      })),
    }, 'Agency personalization fetched');
  } catch (error) {
    return next(error);
  }
};

const getAgencyTags = async (req, res, next) => {
  try {
    const tags = await AgencyTag.find().sort({ name: 1 }).lean();
    return success(res, tags.map(({ _id, name, color, allowedRoles }) => ({
      id: String(_id), name, color, allowedRoles,
    })), 'Agency tags fetched');
  } catch (error) {
    return next(error);
  }
};

const updateAgencyPersonalization = async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid agency ID' });

  const body = req.body || {};
  const errors = {};
  for (const field of Object.keys(body)) {
    if (!['favorite', 'tagIds'].includes(field)) errors[field] = 'Unknown field';
  }
  if (body.favorite !== undefined && typeof body.favorite !== 'boolean') {
    errors.favorite = 'Must be true or false';
  }
  if (body.tagIds !== undefined
    && (!Array.isArray(body.tagIds) || body.tagIds.some((tagId) => !mongoose.isValidObjectId(tagId)))) {
    errors.tagIds = 'Must be an array of valid tag IDs';
  }
  if (!Object.keys(body).length) errors.body = 'At least one preference is required';
  if (Object.keys(errors).length) return validationFailure(res, errors);

  try {
    await migrateLegacyPersonalizations();
    const agency = await Agency.findById(id).select('_id nombre favorite tags');
    if (!agency) return res.status(404).json({ success: false, message: 'Agency not found' });
    const previousFavorite = agency.favorite;
    const previousTagIds = (agency.tags || []).map(String).sort();
    if (body.tagIds !== undefined) {
      const tagIds = [...new Set(body.tagIds)];
      const matchingTags = tagIds.length
        ? await AgencyTag.find({ _id: { $in: tagIds }, allowedRoles: req.user.rol }).select('_id').lean()
        : [];
      if (matchingTags.length !== tagIds.length) {
        return validationFailure(res, { tagIds: 'One or more tags are unavailable for your role' });
      }

      const inaccessibleTagIds = agency.tags?.length
        ? await AgencyTag.find({ _id: { $in: agency.tags }, allowedRoles: { $ne: req.user.rol } })
          .distinct('_id')
        : [];
      agency.tags = [...new Set([...inaccessibleTagIds.map(String), ...tagIds])];
    }
    if (body.favorite !== undefined) agency.favorite = body.favorite;
    agency.personalizationMigrated = true;
    await agency.save();
    const nextTagIds = agency.tags.map(String).sort();
    if (previousFavorite !== agency.favorite || JSON.stringify(previousTagIds) !== JSON.stringify(nextTagIds)) {
      await recordAgencyHistory({
        agencyId: agency._id,
        actor: req.user,
        action: 'agency_personalization_updated',
        summary: 'Se actualizaron las etiquetas o preferencias de la sucursal',
        details: {
          favoriteChanged: previousFavorite !== agency.favorite,
          tagsChanged: JSON.stringify(previousTagIds) !== JSON.stringify(nextTagIds),
        },
      });
    }
    return success(res, {
      agencyId: String(agency._id),
      favorite: agency.favorite,
      tagIds: agency.tags.map(String),
    }, 'Agency personalization updated');
  } catch (error) {
    return next(error);
  }
};

const createAgencyTag = async (req, res, next) => {
  const { errors, value } = validateTagInput(req.body);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  try {
    const duplicate = await AgencyTag.exists({ nameKey: value.nameKey });
    if (duplicate) return res.status(409).json({ success: false, message: 'A tag with this name already exists' });
    const tag = await AgencyTag.create({ ...value, createdBy: req.user._id });
    return success(res, {
      id: String(tag._id), name: tag.name, color: tag.color, allowedRoles: tag.allowedRoles,
    }, 'Agency tag created', 201);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'A tag with this name already exists' });
    return next(error);
  }
};

const updateAgencyTag = async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.tagId)) {
    return res.status(400).json({ success: false, message: 'Invalid tag ID' });
  }
  const { errors, value } = validateTagInput(req.body, true);
  if (Object.keys(errors).length) return validationFailure(res, errors);
  try {
    if (value.nameKey && await AgencyTag.exists({ nameKey: value.nameKey, _id: { $ne: req.params.tagId } })) {
      return res.status(409).json({ success: false, message: 'A tag with this name already exists' });
    }
    const tag = await AgencyTag.findByIdAndUpdate(req.params.tagId, { $set: value }, {
      new: true, runValidators: true,
    });
    if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });
    return success(res, {
      id: String(tag._id), name: tag.name, color: tag.color, allowedRoles: tag.allowedRoles,
    }, 'Agency tag updated');
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'A tag with this name already exists' });
    return next(error);
  }
};

const deleteAgencyTag = async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.tagId)) {
    return res.status(400).json({ success: false, message: 'Invalid tag ID' });
  }
  try {
    const tag = await AgencyTag.findByIdAndDelete(req.params.tagId);
    if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });
    await Promise.all([
      Agency.updateMany(
        { tags: tag._id },
        { $pull: { tags: tag._id } },
      ),
      AgencyPersonalization.updateMany(
        { tags: tag._id },
        { $pull: { tags: tag._id } },
      ),
    ]);
    return success(res, { id: String(tag._id) }, 'Agency tag deleted');
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAgencyPersonalization,
  getAgencyTags,
  updateAgencyPersonalization,
  createAgencyTag,
  updateAgencyTag,
  deleteAgencyTag,
  validateTagInput,
  migrateLegacyPersonalizations,
};
