'use strict';

const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const AgencyNote = require('../models/AgencyNote');
const { success } = require('../utils/response');

function validObjectId(id, res, label) {
  if (mongoose.isValidObjectId(id)) return true;
  res.status(400).json({ success: false, message: `Invalid ${label} ID` });
  return false;
}

async function getAgencyNotes(req, res, next) {
  if (!validObjectId(req.params.id, res, 'agency')) return;
  try {
    if (!await Agency.exists({ _id: req.params.id })) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    const notes = await AgencyNote.find({ agencyId: req.params.id })
      .populate('authorId', 'nombre correo rol')
      .sort({ createdAt: 1 })
      .lean();
    return success(res, {
      notes: notes.map((note) => ({
        id: String(note._id),
        text: note.text,
        author: note.authorId ? {
          id: String(note.authorId._id),
          name: note.authorId.nombre,
          email: note.authorId.correo,
          role: note.authorId.rol,
        } : null,
        createdAt: note.createdAt,
      })),
    }, 'Agency notes fetched');
  } catch (error) {
    return next(error);
  }
}

async function appendAgencyNote(req, res, next) {
  if (!validObjectId(req.params.id, res, 'agency')) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 4000) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: { text: 'Must be a non-empty string of at most 4000 characters' },
    });
  }
  try {
    if (!await Agency.exists({ _id: req.params.id })) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    const note = await AgencyNote.create({
      agencyId: req.params.id,
      authorId: req.user._id,
      text: text.trim(),
    });
    return success(res, {
      id: String(note._id),
      text: note.text,
      author: { id: String(req.user._id), name: req.user.nombre },
      createdAt: note.createdAt,
    }, 'Agency note appended', 201);
  } catch (error) {
    return next(error);
  }
}

async function deleteAgencyNote(req, res, next) {
  if (!validObjectId(req.params.id, res, 'agency')
    || !validObjectId(req.params.noteId, res, 'note')) return;
  try {
    const note = await AgencyNote.findOneAndDelete({
      _id: req.params.noteId,
      agencyId: req.params.id,
    });
    if (!note) return res.status(404).json({ success: false, message: 'Agency note not found' });
    return success(res, { id: String(note._id) }, 'Agency note deleted');
  } catch (error) {
    return next(error);
  }
}

module.exports = { appendAgencyNote, deleteAgencyNote, getAgencyNotes };
