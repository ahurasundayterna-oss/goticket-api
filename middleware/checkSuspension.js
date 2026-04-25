/**
 * middleware/checkSuspension.js
 *
 * Pure suspension checker — no JWT, no express req/res.
 * Takes a userId and returns the first suspension reason found,
 * walking the chain: User → Branch → Park.
 *
 * Separation of concerns: auth.js handles token validation,
 * this file handles the suspension business rules.
 * Both are small and independently testable.
 *
 * Returns:
 *   null                          — no suspension, access granted
 *   { reason: string, level: string }  — suspended, access denied
 *
 * Level values: "USER" | "BRANCH" | "PARK" | "PARK_DELETED"
 */

"use strict";

const prisma = require("../prismaClient");

/**
 * @param {string} userId
 * @returns {Promise<null | { reason: string, level: string }>}
 */
async function checkSuspension(userId) {
  // Single query — fetch user with branch and park in one round-trip
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: {
      suspended: true,
      branch: {
        select: {
          suspended: true,
          park: {
            select: {
              status: true,   // "ACTIVE" | "SUSPENDED" | "DELETED"
              name:   true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    // User not found — treat as suspended so auth middleware returns 401
    return { reason: "User account not found.", level: "USER" };
  }

  // ── Rule 3: Staff/Admin account directly suspended ────────────────────────
  if (user.suspended) {
    return {
      reason: "Your account has been suspended. Contact your branch admin.",
      level:  "USER",
    };
  }

  // Users with no branch (e.g. SUPER_ADMIN) pass through — no branch checks
  if (!user.branch) return null;

  // ── Rule 2: Branch suspended ──────────────────────────────────────────────
  if (user.branch.suspended) {
    return {
      reason: "Your branch has been suspended. Contact your park administrator.",
      level:  "BRANCH",
    };
  }

  // ── Rule 4: Park deleted ──────────────────────────────────────────────────
  if (user.branch.park?.status === "DELETED") {
    return {
      reason: "This park account no longer exists. Contact GoTicket support.",
      level:  "PARK_DELETED",
    };
  }

  // ── Rule 1: Park suspended ────────────────────────────────────────────────
  if (user.branch.park?.status === "SUSPENDED") {
    return {
      reason: "Your park account has been suspended. Contact GoTicket support.",
      level:  "PARK",
    };
  }

  return null; // all clear
}

module.exports = { checkSuspension };