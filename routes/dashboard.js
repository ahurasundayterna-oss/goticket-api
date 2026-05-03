"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");

/* ══════════════════════════════════════════════
   DATE FILTER HELPER
══════════════════════════════════════════════ */
function getDateFilter(range, from, to) {
  const now = new Date();

  function startOfDay(d) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    return s;
  }

  function endOfDay(d) {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  }

  switch (range) {
    case "week": {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case "custom": {
      if (!from || !to) return { gte: startOfDay(now), lte: endOfDay(now) };
      return {
        gte: startOfDay(new Date(from)),
        lte: endOfDay(new Date(to)),
      };
    }

    default:
      return { gte: startOfDay(now), lte: endOfDay(now) };
  }
}

/* ══════════════════════════════════════════════
   PREVIOUS PERIOD FILTER
   Used to compute % change vs prior period.
══════════════════════════════════════════════ */
function getPreviousDateFilter(range, from, to) {
  const now = new Date();

  function startOfDay(d) { const s = new Date(d); s.setHours(0,0,0,0); return s; }
  function endOfDay(d)   { const e = new Date(d); e.setHours(23,59,59,999); return e; }

  switch (range) {
    case "week": {
      const thisStart = new Date(now);
      thisStart.setDate(now.getDate() - now.getDay());
      const prevEnd   = new Date(thisStart); prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd);   prevStart.setDate(prevEnd.getDate() - 6);
      return { gte: startOfDay(prevStart), lte: endOfDay(prevEnd) };
    }
    case "month": {
      const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevEnd   = new Date(now.getFullYear(), now.getMonth(), 0);
      return { gte: startOfDay(prevStart), lte: endOfDay(prevEnd) };
    }
    case "custom": {
      if (!from || !to) return null;
      const f   = new Date(from);
      const t   = new Date(to);
      const len = t - f;
      const pf  = new Date(f.getTime() - len - 86400000);
      const pt  = new Date(f.getTime() - 86400000);
      return { gte: startOfDay(pf), lte: endOfDay(pt) };
    }
    default: {
      // today vs yesterday
      const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
      return { gte: startOfDay(yesterday), lte: endOfDay(yesterday) };
    }
  }
}

function pctChange(curr, prev) {
  if (!prev) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

/* ══════════════════════════════════════════════
   ROLE FILTER HELPERS
══════════════════════════════════════════════ */
function bookingWhere(user, dateFilter) {
  const base = { createdAt: dateFilter };
  if (user.role === "SUPER_ADMIN") return base;
  if (user.role === "STAFF") return { ...base, branchId: user.branchId, createdById: user.id };
  return { ...base, branchId: user.branchId };
}

function tripWhere(user, dateFilter) {
  const base = { createdAt: dateFilter };
  if (user.role === "SUPER_ADMIN") return base;
  return { ...base, branchId: user.branchId };
}

/* ══════════════════════════════════════════════
   GET /api/dashboard
   ──────────────────────────────────────────────
   Returns all stat card numbers:
   - bookings (total in period)
   - revenue  (sum of paid bookings)
   - trips    (active trips in period)
   - onlinePayments  (count of ONLINE paid)
   - offlinePayments (count of CASH/TRANSFER paid)
   - seatsAvailable  (sum of remaining seats)
   - changes  (% change vs prior period)
══════════════════════════════════════════════ */
router.get("/", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter     = getDateFilter(range, from, to);
    const prevDateFilter = getPreviousDateFilter(range, from, to);
    const bWhere         = bookingWhere(req.user, dateFilter);
    const tWhere         = tripWhere(req.user, dateFilter);

    const prevBWhere = prevDateFilter
      ? bookingWhere(req.user, prevDateFilter)
      : null;

    // ── Current period ───────────────────────────────────────────
    const [
      totalBookings,
      paidBookings,
      activeTrips,
      onlinePayments,
      offlinePayments,
      allTrips,
    ] = await Promise.all([
      prisma.booking.count({ where: bWhere }),

      prisma.booking.findMany({
        where: { ...bWhere, paymentStatus: "PAID" },
        select: { totalAmount: true, trip: { select: { price: true } } },
      }),

      prisma.trip.count({
        where: { ...tWhere, status: { in: ["OPEN", "FULL"] } },
      }),

      prisma.booking.count({
        where: { ...bWhere, paymentStatus: "PAID", paymentMethod: "ONLINE" },
      }),

      prisma.booking.count({
        where: {
          ...bWhere,
          paymentStatus: "PAID",
          paymentMethod: { in: ["CASH", "TRANSFER"] },
        },
      }),

      // For seats available — scoped to branch if not super admin
      prisma.trip.findMany({
        where: {
          ...(req.user.role !== "SUPER_ADMIN" ? { branchId: req.user.branchId } : {}),
          status: "OPEN",
        },
        select: { totalSeats: true, seatsBooked: true },
      }),
    ]);

    const revenue        = paidBookings.reduce((sum, b) => sum + (b.totalAmount || b.trip?.price || 0), 0);
    const seatsAvailable = allTrips.reduce((sum, t) => sum + Math.max(0, t.totalSeats - t.seatsBooked), 0);

    // ── Previous period (for % change) ───────────────────────────
    let changes = {};
    if (prevBWhere) {
      const [prevBookings, prevPaid] = await Promise.all([
        prisma.booking.count({ where: prevBWhere }),
        prisma.booking.findMany({
          where: { ...prevBWhere, paymentStatus: "PAID" },
          select: { totalAmount: true, trip: { select: { price: true } } },
        }),
      ]);

      const prevRevenue = prevPaid.reduce((sum, b) => sum + (b.totalAmount || b.trip?.price || 0), 0);

      changes = {
        bookings: pctChange(totalBookings, prevBookings),
        revenue:  pctChange(revenue, prevRevenue),
      };
    }

    res.json({
      bookings:        totalBookings,
      revenue,
      trips:           activeTrips,
      onlinePayments,
      offlinePayments,
      seatsAvailable,
      changes,
    });

  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    res.status(500).json({ message: "Dashboard error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/payments
══════════════════════════════════════════════ */
router.get("/payments", auth, async (req, res) => {
  try {
    const { range = "today", from, to } = req.query;
    const dateFilter = getDateFilter(range, from, to);
    const bWhere     = bookingWhere(req.user, dateFilter);

    const [online, offline] = await Promise.all([
      prisma.booking.count({
        where: { ...bWhere, paymentStatus: "PAID", paymentMethod: "ONLINE" },
      }),
      prisma.booking.count({
        where: {
          ...bWhere,
          paymentStatus: "PAID",
          paymentMethod: { in: ["CASH", "TRANSFER"] },
        },
      }),
    ]);

    res.json({ online, offline });
  } catch (err) {
    console.error("PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Payments error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/dashboard/chart
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
        trip: { select: { price: true } },
      },
      orderBy: { createdAt: "asc" },
    });

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
   GET /api/dashboard/routes
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

    // Normalise to what the frontend expects
    const statusMap = {};
    for (const g of grouped) {
      statusMap[g.status] = g._count.status;
    }

    res.json({
      departed:  statusMap["DEPARTED"]  || 0,
      full:      statusMap["FULL"]      || 0,
      open:      statusMap["OPEN"]      || 0,
      cancelled: statusMap["CANCELLED"] || 0,
    });
  } catch (err) {
    console.error("TRIP STATUS ERROR:", err);
    res.status(500).json({ message: "Trip status error" });
  }
});

module.exports = router;