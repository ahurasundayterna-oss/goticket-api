/**
 * routes/reports.js
 *
 * Role-based report endpoints.
 * Mount in server.js: app.use("/api/reports", require("./routes/reports"));
 *
 * SUPER_ADMIN  → all data, filterable by park + branch + date range
 * BRANCH_ADMIN → own branch only, filterable by date range
 * STAFF        → own branch only, limited to bookings they created
 */

"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireBranchMember } = require("../middleware/role");

/* ── Role helper ─────────────────────────────────────────────────────────── */
function isSuperAdmin(req) { return req.user?.role === "SUPER_ADMIN"; }
function isBranchAdmin(req) { return req.user?.role === "BRANCH_ADMIN"; }

/* ── Date range helper ───────────────────────────────────────────────────── */
function getDateRange(from, to) {
  const start = from ? new Date(from + "T00:00:00") : new Date("2000-01-01");
  const end   = to   ? new Date(to   + "T23:59:59") : new Date();
  return { start, end };
}

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/reports/bookings
   Query params: from, to, parkId, branchId (SA only)
══════════════════════════════════════════════════════════════════════════ */
router.get("/bookings", auth, async (req, res) => {
  try {
    const { from, to, parkId, branchId: queryBranch } = req.query;
    const { start, end } = getDateRange(from, to);

    let where = {
      createdAt: { gte: start, lte: end },
    };

    if (isSuperAdmin(req)) {
      // SA: filter by parkId or branchId if provided
      if (queryBranch) {
        where.branchId = queryBranch;
      } else if (parkId) {
        where.branch = { parkId };
      }
    } else {
      // Branch Admin / Staff: locked to own branch
      where.branchId = req.user.branchId;
      // Staff: only their own bookings
      if (req.user.role === "STAFF") {
        where.createdById = req.user.id;
      }
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:   { select: { departureCity: true, destination: true, price: true, tripType: true } },
        branch: { select: { name: true, park: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Format for table + CSV
    const rows = bookings.map(b => ({
      reference:      b.reference,
      passengerName:  b.passengerName,
      passengerPhone: b.passengerPhone,
      seatNumber:     b.seatNumber,
      route:          `${b.trip?.departureCity} → ${b.trip?.destination}`,
      tripType:       b.trip?.tripType,
      price:          b.trip?.price ?? 0,
      paymentStatus:  b.paymentStatus ?? "N/A",
      bookingSource:  b.bookingSource,
      branch:         b.branch?.name ?? "N/A",
      park:           b.branch?.park?.name ?? "N/A",
      createdAt:      b.createdAt,
      status:         b.status,
    }));

    res.json({ total: rows.length, rows });
  } catch (err) {
    console.error("REPORT BOOKINGS ERROR:", err);
    res.status(500).json({ message: "Error fetching bookings report" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/reports/trips
   Query params: from, to, parkId, branchId (SA only)
══════════════════════════════════════════════════════════════════════════ */
router.get("/trips", auth, async (req, res) => {
  try {
    const { from, to, parkId, branchId: queryBranch } = req.query;
    const { start, end } = getDateRange(from, to);

    let where = {
      createdAt: { gte: start, lte: end },
    };

    if (isSuperAdmin(req)) {
      if (queryBranch) {
        where.branchId = queryBranch;
      } else if (parkId) {
        where.branch = { parkId };
      }
    } else {
      where.branchId = req.user.branchId;
    }

    const trips = await prisma.trip.findMany({
      where,
      include: {
        bookings: { select: { id: true } },
        branch:   { select: { name: true, park: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });

    const rows = trips.map(t => ({
      id:            t.id,
      route:         `${t.departureCity} → ${t.destination}`,
      tripType:      t.tripType,
      departureTime: t.departureTime,
      price:         t.price,
      totalSeats:    t.totalSeats,
      seatsBooked:   t.bookings.length,
      seatsRemaining: t.totalSeats - t.bookings.length,
      status:        t.status,
      branch:        t.branch?.name ?? "N/A",
      park:          t.branch?.park?.name ?? "N/A",
      createdAt:     t.createdAt,
    }));

    res.json({ total: rows.length, rows });
  } catch (err) {
    console.error("REPORT TRIPS ERROR:", err);
    res.status(500).json({ message: "Error fetching trips report" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/reports/revenue
   Query params: from, to, parkId, branchId (SA only)
══════════════════════════════════════════════════════════════════════════ */
router.get("/revenue", auth, async (req, res) => {
  try {
    const { from, to, parkId, branchId: queryBranch } = req.query;
    const { start, end } = getDateRange(from, to);

    let where = {
      createdAt:     { gte: start, lte: end },
      paymentStatus: "PAID",
    };

    if (isSuperAdmin(req)) {
      if (queryBranch) {
        where.branchId = queryBranch;
      } else if (parkId) {
        where.branch = { parkId };
      }
    } else {
      where.branchId = req.user.branchId;
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:   { select: { departureCity: true, destination: true, price: true } },
        branch: { select: { name: true, park: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });

    const totalRevenue = bookings.reduce((sum, b) => sum + (b.totalAmount || b.trip?.price || 0), 0);

    const rows = bookings.map(b => ({
      reference:   b.reference,
      passenger:   b.passengerName,
      route:       `${b.trip?.departureCity} → ${b.trip?.destination}`,
      amount:      b.totalAmount || b.trip?.price || 0,
      paidAt:      b.paidAt,
      branch:      b.branch?.name ?? "N/A",
      park:        b.branch?.park?.name ?? "N/A",
      source:      b.bookingSource,
    }));

    res.json({ total: rows.length, totalRevenue, rows });
  } catch (err) {
    console.error("REPORT REVENUE ERROR:", err);
    res.status(500).json({ message: "Error fetching revenue report" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   GET /api/reports/branches  (SUPER ADMIN only)
   Summary of all branches with trip and booking counts
══════════════════════════════════════════════════════════════════════════ */
router.get("/branches", auth, async (req, res) => {
  try {
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ message: "Super Admin only" });
    }

    const { from, to, parkId } = req.query;
    const { start, end } = getDateRange(from, to);

    const where = parkId ? { parkId } : {};

    const branches = await prisma.branch.findMany({
      where,
      include: {
        park: { select: { name: true, status: true } },
        bookings: {
          where: { createdAt: { gte: start, lte: end } },
          select: { id: true, totalAmount: true, paymentStatus: true },
        },
        trips: {
          where: { createdAt: { gte: start, lte: end } },
          select: { id: true, status: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const rows = branches.map(b => ({
      branchName:    b.name,
      parkName:      b.park?.name ?? "N/A",
      parkStatus:    b.park?.status ?? "N/A",
      suspended:     b.suspended,
      totalBookings: b.bookings.length,
      totalTrips:    b.trips.length,
      totalRevenue:  b.bookings
        .filter(bk => bk.paymentStatus === "PAID")
        .reduce((sum, bk) => sum + (bk.totalAmount || 0), 0),
    }));

    res.json({ total: rows.length, rows });
  } catch (err) {
    console.error("REPORT BRANCHES ERROR:", err);
    res.status(500).json({ message: "Error fetching branches report" });
  }
});

module.exports = router;