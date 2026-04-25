/**
 * middleware/auth.js
 *
 * CHANGED from previous version:
 *   - Replaces the inline `user.suspended` check with `checkSuspension()`
 *     which walks the full chain: User → Branch → Park.
 *   - Returns 403 with a structured JSON body:
 *       { message: string, suspended: true, level: string }
 *     The `suspended: true` flag lets the frontend distinguish a suspension
 *     403 from a permissions 403, without checking the message string.
 *
 * Everything else (JWT verify, route assignment fetch, req.user shape)
 * is byte-for-byte identical to the previous version.
 */

const jwt    = require("jsonwebtoken");
const prisma = require("../prismaClient");
const { checkSuspension } = require("./checkSuspension");

module.exports = async function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ── Suspension chain check (replaces the old single-field check) ─────────
    const suspension = await checkSuspension(decoded.id);

    if (suspension) {
      return res.status(403).json({
        message:   suspension.reason,
        suspended: true,          // ← frontend uses this flag
        level:     suspension.level,
      });
    }

    // ── Fetch assigned routes from DB (not from token) — unchanged ───────────
    const assignments = await prisma.routeStaffAssignment.findMany({
      where:  { staffId: decoded.id },
      select: { routeId: true },
    });

    // ── Attach user to request — unchanged ────────────────────────────────────
    req.user = {
      id:               decoded.id,
      role:             decoded.role,
      branchId:         decoded.branchId,
      branchName:       decoded.branchName,
      parkName:         decoded.parkName,
      assignedRouteIds: assignments.map(a => a.routeId),
    };

    next();

  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};