const jwt    = require("jsonwebtoken");
const prisma  = require("../prismaClient");
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
    // FIX: prisma.routeStaffAssignment does not exist in the schema.
    //      The correct model name is prisma.staffRoute.
    //      The old name threw on every request → catch returned 401
    //      → api.js interceptor cleared token → immediate logout.
    let assignedRouteIds = [];

    if (decoded.role === "STAFF") {
      try {
        const assignments = await prisma.staffRoute.findMany({
          where:  { staffId: decoded.id },
          select: { routeId: true },
        });
        assignedRouteIds = assignments.map(a => a.routeId);
      } catch (assignErr) {
        // Isolated — a DB error here won't kill the whole request.
        // Staff gets empty route list rather than a 401.
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
    // Only reaches here if jwt.verify itself fails
    // (token expired, tampered, wrong secret)
    console.error("AUTH ERROR:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
