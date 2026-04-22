// middleware/auth.js
const jwt    = require("jsonwebtoken");
const prisma = require("../prismaClient");

module.exports = async function (req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // check if user exists + not suspended
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, suspended: true }
    });

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.suspended) {
      return res.status(403).json({
        message: "Your account has been suspended. Contact your branch admin."
      });
    }

    // 🔥 Fetch assigned routes from DB (NOT from token)
    const assignments = await prisma.routeStaffAssignment.findMany({
      where: { staffId: decoded.id },
      select: { routeId: true }
    });

    // attach user to request
    req.user = {
      id: decoded.id,
      role: decoded.role,
      branchId: decoded.branchId,
      branchName: decoded.branchName,
      parkName: decoded.parkName,
      assignedRouteIds: assignments.map(a => a.routeId),
    };

    next();

  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};