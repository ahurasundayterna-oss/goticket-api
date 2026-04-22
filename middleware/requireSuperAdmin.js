// middleware/requireSuperAdmin.js
module.exports = (req, res, next) => {
  if (req.user?.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Access denied. Super Admin only." });
  }
  next();
};