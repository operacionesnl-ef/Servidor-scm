const requireDeveloperDebug = (req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  if (req.user?.rol !== 'developer') {
    return res.status(403).json({ success: false, message: 'Developer access is required' });
  }
  return next();
};

module.exports = requireDeveloperDebug;