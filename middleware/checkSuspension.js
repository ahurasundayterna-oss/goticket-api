"use strict";

const prisma = require("../prismaClient");

/**
 * @param {string} userId
 * @returns {Promise<null | { reason: string, level: string }>}
 */
async function checkSuspension(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      suspended: true,
      branch: {
        select: {
          suspended: true,
          park: {
            select: {
              status: true, // "ACTIVE" | "SUSPENDED" | "DELETED"
              name: true,
            },
          },
        },
      },
    },
  });

  // ❗ Do NOT treat missing user as suspension
  if (!user) return null;

  // ── USER ──────────────────────────────────────────────────────
  if (user.suspended) {
    return {
      reason: "Your account has been suspended. Contact your branch admin.",
      level: "USER",
    };
  }

  // ── SUPER ADMIN (no branch) ───────────────────────────────────
  if (!user.branch) return null;

  // ── BRANCH ────────────────────────────────────────────────────
  if (user.branch.suspended) {
    return {
      reason: "Your branch has been suspended. Contact your park administrator.",
      level: "BRANCH",
    };
  }

  // ── Missing park linkage (data integrity issue) ───────────────
  if (!user.branch.park) {
    return {
      reason: "Branch is not linked to a park. Contact administrator.",
      level: "BRANCH",
    };
  }

  // ── PARK DELETED ──────────────────────────────────────────────
  if (user.branch.park.status === "DELETED") {
    return {
      reason: "This park account no longer exists. Contact GoTicket support.",
      level: "PARK_DELETED",
    };
  }

  // ── PARK SUSPENDED ────────────────────────────────────────────
  if (user.branch.park.status === "SUSPENDED") {
    return {
      reason: "Your park account has been suspended. Contact GoTicket support.",
      level: "PARK",
    };
  }

  return null;
}

module.exports = { checkSuspension };