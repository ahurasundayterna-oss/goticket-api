"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");

/* ══════════════════════════════════════════════
   DATE FILTER HELPER
   range: "today" | "week" | "month" | "custom"
══════════════════════════════════════════════ */
function getDateFilter(range, from, to) {
  const now = new Date();

  function startOfDay(d) {
    const s = new Date(d); s.setHours(0, 0, 0, 0); return s;
  }
  function endOfDay(d) {
    const e = new Date(d); e.setHours(23, 59, 59, 999); return e;
  }

  switch (range) {
    case "week": {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay()); // back to Sunday
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }
    case "custom": {
      if (!from || !to) return { gte: startOfDay(now), lte: endOfDay(now) };
      return { gte: startOfDay(new Date(from)), lte: endOfDay(new Date(to)) };
    }
    default: // "today"
      return { gte: startOfDay(now), lte: endOfDay(now) };
  }
}

/* ── Role-aware where clauses ───────────────────────────────── */
function bookingWhere(user, dateFilter) {
  const base = { createdAt: dateFilter };
  if (user.role === "SUPER_ADMIN") return base;
  if (user.role === "STAFF")       return { ...base, branchId: user.branchId, createdById: user.id };
  return { ...base, branchId: user.branchId };
}

function tripWhere(user, dateFilter) {
  const base = { createdAt: dateFilter };
  if (user.role === "SUPER_ADMIN") return base;
  return { ...base, branchId: user.branchId };
}

/* ══════════════════════════════════════════════
   GET /api/dashboard
   Stats cards with date range support
   Query: ?range=today|week|month|custom &from=YYYY-MM-DD &to=YYYY-MM-DD
══════════════════════════════════════════════ */
router.get("/", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const bWhere     = bookingWhere(req.user, dateFilter);
    const tWhere     = tripWhere(req.user, dateFilter);

    // Run all queries in parallel
    const [
      bookings,
      revenueAgg,
      trips,
      onlinePayments,
      offlinePayments,
      activeTrips,
    ] = await Promise.all([
      // Total bookings in range
      prisma.booking.count({ where: bWhere }),

      // Revenue — PAID only
      prisma.booking.aggregate({
        where: { ...bWhere, paymentStatus: "PAID" },
        _sum:  { totalAmount: true },
      }),

      // Trip count in range
      prisma.trip.count({ where: tWhere }),

      // Online = PAID with a Monnify paymentReference
      prisma.booking.count({
        where: { ...bWhere, paymentStatus: "PAID", paymentReference: { not: null } },
      }),

      // Offline = MANUAL source with no paymentReference (cash)
      prisma.booking.count({
        where: { ...bWhere, bookingSource: "MANUAL", paymentReference: null },
      }),

      // Seats available across open trips
      prisma.trip.findMany({
        where:  { ...tWhere, status: { in: ["OPEN", "FULL"] } },
        select: { totalSeats: true, seatsBooked: true },
      }),
    ]);

    const revenue        = revenueAgg._sum.totalAmount || 0;
    const seatsAvailable = activeTrips.reduce((sum, t) =>
      sum + Math.max(0, t.totalSeats - (t.seatsBooked || 0)), 0
    );

    res.json({
      // New keys
      bookings,
      revenue,
      trips,
      onlinePayments,
      offlinePayments,
      seatsAvailable,
      // Legacy keys — keeps existing frontend working
      todayBookings:  bookings,
      activeTrips:    trips,
      revenueToday:   revenue,
    });

  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    res.status(500).json({ message: "Dashboard error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/chart
   Bookings + revenue grouped by day (sorted ASC)
   Returns: [{ date: "2026-04-01", bookings: 10, revenue: 50000 }]
══════════════════════════════════════════════ */
router.get("/chart", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const bWhere     = bookingWhere(req.user, dateFilter);

    const rows = await prisma.booking.findMany({
      where:   bWhere,
      select: {
        createdAt:     true,
        paymentStatus: true,
        totalAmount:   true,
        trip:          { select: { price: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // Group by WAT date string (en-CA gives YYYY-MM-DD)
    const map = new Map();
    for (const b of rows) {
      const key = new Date(b.createdAt).toLocaleDateString("en-CA", {
        timeZone: "Africa/Lagos",
      });
      if (!map.has(key)) map.set(key, { date: key, bookings: 0, revenue: 0 });
      const entry = map.get(key);
      entry.bookings += 1;
      if (b.paymentStatus === "PAID") {
        entry.revenue += b.totalAmount || b.trip?.price || 0;
      }
    }

    res.json(Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date)));

  } catch (err) {
    console.error("CHART ERROR:", err);
    res.status(500).json({ message: "Chart error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/payments
   Returns: { online: number, offline: number }
══════════════════════════════════════════════ */
router.get("/payments", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const bWhere     = bookingWhere(req.user, dateFilter);

    const [online, offline] = await Promise.all([
      prisma.booking.count({
        where: { ...bWhere, paymentStatus: "PAID", paymentReference: { not: null } },
      }),
      prisma.booking.count({
        where: { ...bWhere, bookingSource: "MANUAL", paymentReference: null },
      }),
    ]);

    res.json({ online, offline });

  } catch (err) {
    console.error("PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Payments error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/routes
   Top 5 routes by booking count
   Returns: [{ route: "Makurdi - Abuja", count: 78 }]
══════════════════════════════════════════════ */
router.get("/routes", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const bWhere     = bookingWhere(req.user, dateFilter);

    const bookings = await prisma.booking.findMany({
      where:  bWhere,
      select: { trip: { select: { departureCity: true, destination: true } } },
    });

    const routeMap = new Map();
    for (const b of bookings) {
      if (!b.trip) continue;
      const key = `${b.trip.departureCity} - ${b.trip.destination}`;
      routeMap.set(key, (routeMap.get(key) || 0) + 1);
    }

    const result = Array.from(routeMap.entries())
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json(result);

  } catch (err) {
    console.error("ROUTES ERROR:", err);
    res.status(500).json({ message: "Routes error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/trip-status
   Returns: [{ status: "OPEN", count: 19 }, ...]
══════════════════════════════════════════════ */
router.get("/trip-status", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const tWhere     = tripWhere(req.user, dateFilter);

    const grouped = await prisma.trip.groupBy({
      by:     ["status"],
      where:  tWhere,
      _count: { status: true },
    });

    res.json(grouped.map(g => ({ status: g.status, count: g._count.status })));

  } catch (err) {
    console.error("TRIP STATUS ERROR:", err);
    res.status(500).json({ message: "Trip status error" });
  }
});

module.exports = router;