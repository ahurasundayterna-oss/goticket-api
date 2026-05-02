// middleware/role.js

module.exports.requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== "SUPER_ADMIN") {
    return res.status(403).json({ message: "Super Admin only." });
  }
  next();
};

module.exports.requireBranchAdmin = (req, res, next) => {
  if (req.user?.role !== "BRANCH_ADMIN") {
    return res.status(403).json({ message: "Branch Admin only." });
  }
  next();
};

module.exports.requireStaff = (req, res, next) => {
  if (req.user?.role !== "STAFF") {
    return res.status(403).json({ message: "Staff only." });
  }
  next();
};

module.exports.requireBranchMember = (req, res, next) => {
  if (!["BRANCH_ADMIN", "STAFF"].includes(req.user?.role)) {
    return res.status(403).json({ message: "Branch access required." });
  }
  next();
};