/**
 * routes/payments.js
 *
 * Payment management endpoints for the admin dashboard.
 * Mount in server.js: app.use("/api/payments", require("./routes/payments"));
 *
 * GET /api/payments/pending   — pending unpaid bookings
 * GET /api/payments/paid      — confirmed paid bookings
 * GET /api/payments/expired   — expired/failed bookings
 * GET /api/payments/logs      — webhook logs
 */

"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireBranchMember, requireBranchAdmin } = require("../middleware/role");

function isSuperAdmin(req) { return req.user?.role === "SUPER_ADMIN"; }

function buildBranchFilter(req) {
  if (isSuperAdmin(req)) return {};
  return { branchId: req.user.branchId };
}

/* ── GET /api/payments/pending ───────────────────────────────────────────── */
router.get("/pending", auth, requireBranchMember, async (req, res) => {
  try {
    const where = {
      ...buildBranchFilter(req),
      paymentStatus: "PENDING",
      bookingSource: "WHATSAPP",
      status:        { not: "CANCELLED" },
    };

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:    { select: { departureCity: true, destination: true, departureTime: true } },
        payment: { select: { status: true, providerReference: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ total: bookings.length, bookings });
  } catch (err) {
    console.error("PENDING PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Error fetching pending payments" });
  }
});

/* ── GET /api/payments/paid ──────────────────────────────────────────────── */
router.get("/paid", auth, requireBranchMember, async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = {
      ...buildBranchFilter(req),
      paymentStatus: "PAID",
    };

    if (from) where.paidAt = { ...where.paidAt, gte: new Date(from + "T00:00:00") };
    if (to)   where.paidAt = { ...where.paidAt, lte: new Date(to   + "T23:59:59") };

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:    { select: { departureCity: true, destination: true, departureTime: true } },
        payment: { select: { providerReference: true, amount: true } },
      },
      orderBy: { paidAt: "desc" },
    });

    const totalRevenue = bookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
    res.json({ total: bookings.length, totalRevenue, bookings });
  } catch (err) {
    console.error("PAID PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Error fetching paid payments" });
  }
});

/* ── GET /api/payments/expired ───────────────────────────────────────────── */
router.get("/expired", auth, requireBranchMember, async (req, res) => {
  try {
    const where = {
      ...buildBranchFilter(req),
      status: "CANCELLED",
      bookingSource: "WHATSAPP",
    };

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:    { select: { departureCity: true, destination: true } },
        payment: { select: { status: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ total: bookings.length, bookings });
  } catch (err) {
    console.error("EXPIRED PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Error fetching expired payments" });
  }
});

/* ── GET /api/payments/logs ──────────────────────────────────────────────── */
router.get("/logs", auth, requireBranchAdmin, async (req, res) => {
  try {
    // Super admin sees all logs; branch admin is informational only
    const logs = await prisma.webhookLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ total: logs.length, logs });
  } catch (err) {
    console.error("WEBHOOK LOGS ERROR:", err);
    res.status(500).json({ message: "Error fetching webhook logs" });
  }
});

module.exports = router;