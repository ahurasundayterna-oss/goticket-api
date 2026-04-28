// backend/routes/super/index.js
// Mount this in server.js as: app.use("/api/super", require("./routes/super"));

const router  = require("express").Router();
const prisma  = require("../../prismaClient");
const bcrypt  = require("bcrypt");
const auth    = require("../../middleware/auth");
const { requireSuperAdmin } = require("../../middleware/role");

// All super admin routes require auth + super admin role
router.use(auth, requireSuperAdmin);

/* ══════════════════════════════════════════════
   DATE FILTER HELPER
   range: "today" | "week" | "month" | "custom"
══════════════════════════════════════════════ */
function getDateFilter(range, from, to) {
  const now = new Date();
  let start, end;

  switch (range) {
    case "week": {
      start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      break;
    }
    case "month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      end   = new Date(now);
      break;
    }
    case "custom": {
      if (!from || !to) {
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end   = new Date(now); end.setHours(23, 59, 59, 999);
      } else {
        start = new Date(from + "T00:00:00");
        end   = new Date(to   + "T23:59:59");
      }
      break;
    }
    case "today":
    default: {
      start = new Date(now); start.setHours(0, 0, 0, 0);
      end   = new Date(now); end.setHours(23, 59, 59, 999);
      break;
    }
  }

  return { start, end };
}

/* ══════════════════════════════════════════════
   GET /api/super/stats
   UPDATED: supports ?range= and ?parkId= filters
   Keeps all original fields for backward compat.
══════════════════════════════════════════════ */
router.get("/stats", async (req, res) => {
  try {
    const { range = "all", from, to, parkId } = req.query;

    // "all" = no date filter (original behaviour)
    let dateFilter = {};
    if (range !== "all") {
      const { start, end } = getDateFilter(range, from, to);
      dateFilter = { createdAt: { gte: start, lte: end } };
    }

    const parkFilter = parkId ? { branch: { parkId } } : {};

    // Previous period for % change
    let prevBookings  = 0;
    let prevRevenue   = 0;
    if (range !== "all") {
      const { start, end } = getDateFilter(range, from, to);
      const periodMs = end.getTime() - start.getTime();
      const prevStart = new Date(start.getTime() - periodMs);
      const prevEnd   = new Date(start.getTime() - 1);
      const prevFilter = { createdAt: { gte: prevStart, lte: prevEnd } };

      const [pb, pr] = await Promise.all([
        prisma.booking.count({ where: { ...prevFilter, ...parkFilter } }),
        prisma.booking.aggregate({
          _sum:  { totalAmount: true },
          where: { ...prevFilter, ...parkFilter, paymentStatus: "PAID" },
        }),
      ]);
      prevBookings = pb;
      prevRevenue  = pr._sum.totalAmount || 0;
    }

    const [
      totalParks, activeParks, suspendedParks,
      totalTrips, totalBookings, totalUsers,
      revenueAgg, onlinePayments, offlinePayments,
    ] = await Promise.all([
      prisma.park.count({ where: { deletedAt: null } }),
      prisma.park.count({ where: { status: "ACTIVE",    deletedAt: null } }),
      prisma.park.count({ where: { status: "SUSPENDED", deletedAt: null } }),
      prisma.trip.count({ where: { ...dateFilter, ...( parkId ? { branch: { parkId } } : {} ) } }),
      prisma.booking.count({ where: { ...dateFilter, ...parkFilter } }),
      prisma.user.count({ where: { role: "BRANCH_ADMIN" } }),
      // ── FIXED: revenue uses aggregate on totalAmount where PAID ──────────
      prisma.booking.aggregate({
        _sum:  { totalAmount: true },
        where: { ...dateFilter, ...parkFilter, paymentStatus: "PAID" },
      }),
      prisma.booking.count({
        where: { ...dateFilter, ...parkFilter, bookingSource: "WHATSAPP", paymentStatus: "PAID" },
      }),
      prisma.booking.count({
        where: { ...dateFilter, ...parkFilter, bookingSource: { not: "WHATSAPP" }, status: "CONFIRMED" },
      }),
    ]);

    const totalRevenue = revenueAgg._sum.totalAmount || 0;

    function pctChange(curr, prev) {
      if (!prev) return null;
      return Math.round(((curr - prev) / prev) * 100);
    }

    res.json({
      // original fields (backward compat)
      totalParks,
      activeParks,
      suspendedParks,
      totalTrips,
      totalBookings,
      totalRevenue,
      totalUsers,
      // new fields
      onlinePayments,
      offlinePayments,
      changes: {
        bookings: pctChange(totalBookings, prevBookings),
        revenue:  pctChange(totalRevenue,  prevRevenue),
      },
      period: { range },
    });
  } catch (err) {
    console.error("SA STATS ERROR:", err);
    res.status(500).json({ message: "Failed to load stats" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/chart  (NEW)
   Bookings + revenue grouped by day
   Query: ?range=...&from=...&to=...&parkId=...
══════════════════════════════════════════════ */
router.get("/chart", async (req, res) => {
  try {
    const { range = "week", from, to, parkId } = req.query;
    const { start, end } = getDateFilter(range, from, to);

    const where = {
      createdAt: { gte: start, lte: end },
      ...(parkId ? { branch: { parkId } } : {}),
    };

    const bookings = await prisma.booking.findMany({
      where,
      select: { createdAt: true, paymentStatus: true, totalAmount: true },
      orderBy: { createdAt: "asc" },
    });

    // Group by calendar day in Nigerian time
    const byDay = {};
    for (const b of bookings) {
      const day = new Date(b.createdAt).toLocaleDateString("en-CA", {
        timeZone: "Africa/Lagos",
      });
      if (!byDay[day]) byDay[day] = { date: day, bookings: 0, revenue: 0 };
      byDay[day].bookings += 1;
      if (b.paymentStatus === "PAID") {
        byDay[day].revenue += b.totalAmount || 0;
      }
    }

    // Fill missing days with zero for continuous chart line
    const result = [];
    const cursor = new Date(start); cursor.setHours(0, 0, 0, 0);
    while (cursor <= end) {
      const key = cursor.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
      result.push(byDay[key] || { date: key, bookings: 0, revenue: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json(result);
  } catch (err) {
    console.error("SA CHART ERROR:", err);
    res.status(500).json({ message: "Chart error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/payments  (NEW)
   Online vs offline payment counts
══════════════════════════════════════════════ */
router.get("/payments", async (req, res) => {
  try {
    const { range = "week", from, to, parkId } = req.query;
    const { start, end } = getDateFilter(range, from, to);

    const base = {
      createdAt: { gte: start, lte: end },
      ...(parkId ? { branch: { parkId } } : {}),
    };

    const [online, offline] = await Promise.all([
      prisma.booking.count({ where: { ...base, bookingSource: "WHATSAPP", paymentStatus: "PAID" } }),
      prisma.booking.count({ where: { ...base, bookingSource: { not: "WHATSAPP" }, status: "CONFIRMED" } }),
    ]);

    res.json({ online, offline });
  } catch (err) {
    console.error("SA PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Payments error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/top-parks  (NEW)
   Top 5 parks by booking count in period
══════════════════════════════════════════════ */
router.get("/top-parks", async (req, res) => {
  try {
    const { range = "week", from, to } = req.query;
    const { start, end } = getDateFilter(range, from, to);

    const bookings = await prisma.booking.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: { branch: { select: { park: { select: { id: true, name: true } } } } },
    });

    const parkMap = {};
    for (const b of bookings) {
      const park = b.branch?.park;
      if (!park) continue;
      if (!parkMap[park.id]) parkMap[park.id] = { name: park.name, count: 0 };
      parkMap[park.id].count += 1;
    }

    const sorted = Object.values(parkMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json(sorted);
  } catch (err) {
    console.error("TOP PARKS ERROR:", err);
    res.status(500).json({ message: "Top parks error" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/trip-status  (NEW)
   Trip status breakdown for donut chart
══════════════════════════════════════════════ */
router.get("/trip-status", async (req, res) => {
  try {
    const { range = "week", from, to, parkId } = req.query;
    const { start, end } = getDateFilter(range, from, to);

    const base = {
      createdAt: { gte: start, lte: end },
      ...(parkId ? { branch: { parkId } } : {}),
    };

    const [open, full, departed, cancelled] = await Promise.all([
      prisma.trip.count({ where: { ...base, status: "OPEN"      } }),
      prisma.trip.count({ where: { ...base, status: "FULL"      } }),
      prisma.trip.count({ where: { ...base, status: "DEPARTED"  } }),
      prisma.trip.count({ where: { ...base, status: "CANCELLED" } }),
    ]);

    res.json({ open, full, departed, cancelled });
  } catch (err) {
    console.error("SA TRIP STATUS ERROR:", err);
    res.status(500).json({ message: "Trip status error" });
  }
});

/* ══════════════════════════════════════════════
   ALL EXISTING ROUTES BELOW — UNCHANGED
══════════════════════════════════════════════ */

router.get("/parks", async (req, res) => {
  try {
    const parks = await prisma.park.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { branches: true } },
        branches: {
          include: {
            _count: { select: { trips: true, bookings: true } }
          }
        }
      }
    });

    const result = parks.map(park => {
      const trips    = park.branches.reduce((sum, b) => sum + (b._count?.trips    || 0), 0);
      const bookings = park.branches.reduce((sum, b) => sum + (b._count?.bookings || 0), 0);
      return {
        id: park.id, name: park.name, location: park.location,
        status: park.status, createdAt: park.createdAt,
        _count: { trips, bookings, branches: park.branches.length },
      };
    });

    res.json(result);
  } catch (err) {
    console.error("SA PARKS ERROR:", err);
    res.status(500).json({ message: "Failed to load parks" });
  }
});

router.post("/parks", async (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name) return res.status(400).json({ message: "Park name is required" });
    const park = await prisma.park.create({
      data: { name, location: location || null, status: "ACTIVE" }
    });
    res.status(201).json(park);
  } catch (err) {
    console.error("SA CREATE PARK ERROR:", err);
    res.status(500).json({ message: "Failed to create park" });
  }
});

router.post("/branches", async (req, res) => {
  try {
    const { name, parkId } = req.body;
    if (!name || !parkId) return res.status(400).json({ message: "Branch name and parkId are required" });
    const park = await prisma.park.findUnique({ where: { id: parkId } });
    if (!park) return res.status(404).json({ message: "Park not found" });
    const branch = await prisma.branch.create({ data: { name, parkId } });
    res.status(201).json(branch);
  } catch (err) {
    console.error("SA CREATE BRANCH ERROR:", err);
    res.status(500).json({ message: "Failed to create branch" });
  }
});

router.get("/branches/:parkId", async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where:   { parkId: req.params.parkId },
      orderBy: { name: "asc" },
    });
    res.json(branches);
  } catch (err) {
    console.error("GET BRANCHES ERROR:", err);
    res.status(500).json({ error: "Failed to fetch branches" });
  }
});

router.post("/branch-admin", async (req, res) => {
  try {
    const { name, email, password, branchId } = req.body;
    if (!name || !email || !password || !branchId)
      return res.status(400).json({ message: "name, email, password and branchId are required" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: "Email already in use" });
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    const hashed = await bcrypt.hash(password, 10);
    const admin = await prisma.user.create({
      data: { name, email, password: hashed, role: "BRANCH_ADMIN", branchId }
    });
    res.status(201).json({ id: admin.id, name: admin.name, email: admin.email });
  } catch (err) {
    console.error("SA CREATE BRANCH ADMIN ERROR:", err);
    res.status(500).json({ message: "Failed to create branch admin" });
  }
});

router.patch("/parks/:id/suspend", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.$transaction(async (tx) => {
      await tx.park.update({ where: { id }, data: { status: "SUSPENDED" } });
      const branches  = await tx.branch.findMany({ where: { parkId: id }, select: { id: true } });
      const branchIds = branches.map(b => b.id);
      if (branchIds.length) {
        await tx.user.updateMany({
          where: { branchId: { in: branchIds }, role: "BRANCH_ADMIN" },
          data:  { suspended: true }
        });
      }
    });
    res.json({ message: "Park suspended" });
  } catch (err) {
    console.error("SA SUSPEND ERROR:", err);
    res.status(500).json({ message: "Failed to suspend park" });
  }
});

router.patch("/parks/:id/activate", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.$transaction(async (tx) => {
      await tx.park.update({ where: { id }, data: { status: "ACTIVE" } });
      const branches  = await tx.branch.findMany({ where: { parkId: id }, select: { id: true } });
      const branchIds = branches.map(b => b.id);
      if (branchIds.length) {
        await tx.user.updateMany({
          where: { branchId: { in: branchIds }, role: "BRANCH_ADMIN" },
          data:  { suspended: false }
        });
      }
    });
    res.json({ message: "Park activated" });
  } catch (err) {
    console.error("SA ACTIVATE ERROR:", err);
    res.status(500).json({ message: "Failed to activate park" });
  }
});

router.delete("/parks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.$transaction(async (tx) => {
      await tx.park.update({ where: { id }, data: { status: "DELETED", deletedAt: new Date() } });
      const branches  = await tx.branch.findMany({ where: { parkId: id }, select: { id: true } });
      const branchIds = branches.map(b => b.id);
      if (branchIds.length) {
        await tx.user.updateMany({
          where: { branchId: { in: branchIds }, role: "BRANCH_ADMIN" },
          data:  { suspended: true }
        });
      }
    });
    res.json({ message: "Park deleted successfully" });
  } catch (err) {
    console.error("SA DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete park" });
  }
});

router.get("/admins", async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: {
        role: "BRANCH_ADMIN",
        branch: { park: { deletedAt: null } }
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, email: true, suspended: true, createdAt: true,
        branch: {
          select: {
            id: true, name: true,
            park: { select: { id: true, name: true } }
          }
        }
      }
    });
    res.json(admins);
  } catch (err) {
    console.error("SA ADMINS ERROR:", err);
    res.status(500).json({ message: "Failed to load admins" });
  }
});

module.exports = router;