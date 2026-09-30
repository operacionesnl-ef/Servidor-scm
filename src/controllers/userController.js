const User = require('../models/User');
const { success } = require('../utils/response');

const getUsers = async (req, res, next) => {
  try {
    const users = await User.find()
      .select('nombre correo status autenticacion.proveedor autenticacion.ultimoAcceso createdAt updatedAt')
      .sort({ nombre: 1 });
    return success(res, users, 'Users fetched');
  } catch (err) {
    return next(err);
  }
};

module.exports = { getUsers };
