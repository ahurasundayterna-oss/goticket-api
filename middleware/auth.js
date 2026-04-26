const jwt    = require("jsonwebtoken");
const prisma = require("../prismaClient");
const { checkSuspension } = require("./checkSuspension");

module.exports = async function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Invalid token format" });
  }

  const token = authHeader.split(" ")[1];

  try {
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET not set");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ── Suspension check ─────────────────────────────────────────
    const suspension = await checkSuspension(decoded.id);

    if (suspension) {
      return res.status(403).json({
        message:   suspension.reason,
        suspended: true,
        level:     suspension.level,
      });
    }

    // ── Staff route assignments ──────────────────────────────────
    let assignedRouteIds = [];

    if (decoded.role === "STAFF") {
      try {
        const assignments = await prisma.routeStaffAssignment.findMany({
          where:  { staffId: decoded.id },
          select: { routeId: true },
        });

        assignedRouteIds = assignments.map(a => a.routeId);

        console.log("ASSIGNED ROUTES:", assignedRouteIds); // 🔍 debug
      } catch (assignErr) {
        console.error("Staff route lookup failed:", assignErr.message);
        assignedRouteIds = [];
      }
    }

    // ── Attach decoded user to request ───────────────────────────
    req.user = {
      id:               decoded.id,
      role:             decoded.role,
      branchId:         decoded.branchId,
      branchName:       decoded.branchName,
      parkName:         decoded.parkName,
      assignedRouteIds,
    };

    next();

  } catch (err) {
    console.error("AUTH ERROR:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};