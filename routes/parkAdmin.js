// backend/routes/parkAdmin.js
// All routes scoped to a PARK_ADMIN's park.
// parkId comes from req.user.parkId (set during login).

const router = require("express").Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireParkAdmin } = require("../middleware/role");

router.use(auth, requireParkAdmin);

/* ══════════════════════════════════════════════
   HELPER — get all branchIds for this park
   Used to scope all queries to park's branches
══════════════════════════════════════════════ */
async function getParkBranchIds(parkId) {
  const branches = await prisma.branch.findMany({
    where:  { parkId, suspended: false },
    select: { id: true },
  });
  return branches.map(b => b.id);
}

/* ══════════════════════════════════════════════
   GET /api/park-admin/stats
   Dashboard overview numbers
══════════════════════════════════════════════ */
router.get("/stats", async (req, res) => {
  try {
    const { parkId } = req.user;

    const branchIds = await getParkBranchIds(parkId);

    const [
      totalBranches,
      totalBookings,
      confirmedBookings,
      pendingBookings,
      totalAdmins,
      bookingsWithAmount,
    ] = await Promise.all([
      prisma.branch.count({ where: { parkId } }),
      prisma.booking.count({ where: { branchId: { in: branchIds } } }),
      prisma.booking.count({ where: { branchId: { in: branchIds }, status: "CONFIRMED" } }),
      prisma.booking.count({ where: { branchId: { in: branchIds }, paymentStatus: "PENDING" } }),
      prisma.user.count({
        where: { branchId: { in: branchIds }, role: "BRANCH_ADMIN" }
      }),
      prisma.booking.findMany({
        where:  { branchId: { in: branchIds }, paymentStatus: "PAID" },
        select: { totalAmount: true },
      }),
    ]);

    const totalRevenue = bookingsWithAmount.reduce(
      (sum, b) => sum + (b.totalAmount || 0), 0
    );

    res.json({
      totalBranches,
      totalBookings,
      confirmedBookings,
      pendingBookings,
      totalAdmins,
      totalRevenue,
    });
  } catch (err) {
    console.error("PA STATS ERROR:", err);
    res.status(500).json({ message: "Failed to load stats" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/branches
   All branches under this park with stats
══════════════════════════════════════════════ */
router.get("/branches", async (req, res) => {
  try {
    const { parkId } = req.user;

    const branches = await prisma.branch.findMany({
      where:   { parkId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            trips:    true,
            bookings: true,
            users:    true,
          },
        },
      },
    });

    // Get revenue per branch
    const revenueByBranch = await Promise.all(
      branches.map(async (branch) => {
        const result = await prisma.booking.aggregate({
          where: { branchId: branch.id, paymentStatus: "PAID" },
          _sum:  { totalAmount: true },
        });
        return { branchId: branch.id, revenue: result._sum.totalAmount || 0 };
      })
    );

    const revenueMap = Object.fromEntries(
      revenueByBranch.map(r => [r.branchId, r.revenue])
    );

    const result = branches.map(branch => ({
      id:        branch.id,
      name:      branch.name,
      suspended: branch.suspended,
      createdAt: branch.createdAt,
      revenue:   revenueMap[branch.id] || 0,
      _count:    branch._count,
    }));

    res.json(result);
  } catch (err) {
    console.error("PA BRANCHES ERROR:", err);
    res.status(500).json({ message: "Failed to load branches" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/bookings
   All bookings across all branches
   Supports: ?date=YYYY-MM-DD&branchId=&status=
══════════════════════════════════════════════ */
router.get("/bookings", async (req, res) => {
  try {
    const { parkId } = req.user;
    const { date, branchId, status } = req.query;

    const branchIds = await getParkBranchIds(parkId);

    // If branchId filter provided, validate it belongs to this park
    const scopedBranchIds = branchId
      ? branchIds.filter(id => id === branchId)
      : branchIds;

    const where = { branchId: { in: scopedBranchIds } };

    if (status) where.status = status;

    if (date) {
      const start = new Date(date + "T00:00:00");
      const end   = new Date(date + "T23:59:59");
      where.trip  = {
        OR: [
          { tripType: "SCHEDULED", departureTime: { gte: start, lte: end } },
          { tripType: "INSTANT" },
        ],
      };
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:   true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take:    200, // limit for performance
    });

    res.json(bookings);
  } catch (err) {
    console.error("PA BOOKINGS ERROR:", err);
    res.status(500).json({ message: "Failed to load bookings" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/payments
   All payments across all branches
   Supports: ?branchId=&status=
══════════════════════════════════════════════ */
router.get("/payments", async (req, res) => {
  try {
    const { parkId } = req.user;
    const { branchId, status } = req.query;

    const branchIds = await getParkBranchIds(parkId);
    const scopedBranchIds = branchId
      ? branchIds.filter(id => id === branchId)
      : branchIds;

    const where = { branchId: { in: scopedBranchIds } };
    if (status) where.paymentStatus = status;

    const bookings = await prisma.booking.findMany({
      where,
      select: {
        id:               true,
        reference:        true,
        passengerName:    true,
        passengerPhone:   true,
        totalAmount:      true,
        paymentStatus:    true,
        paymentMethod:    true,
        paymentReference: true,
        paidAt:           true,
        createdAt:        true,
        branch:           { select: { id: true, name: true } },
        trip:             { select: { departureCity: true, destination: true } },
      },
      orderBy: { createdAt: "desc" },
      take:    200,
    });

    res.json(bookings);
  } catch (err) {
    console.error("PA PAYMENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load payments" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/revenue
   Revenue breakdown per branch
══════════════════════════════════════════════ */
router.get("/revenue", async (req, res) => {
  try {
    const { parkId } = req.user;

    const branches = await prisma.branch.findMany({
      where:   { parkId },
      select:  { id: true, name: true },
    });

    const revenue = await Promise.all(
      branches.map(async (branch) => {
        const [paid, pending, total] = await Promise.all([
          prisma.booking.aggregate({
            where: { branchId: branch.id, paymentStatus: "PAID" },
            _sum:  { totalAmount: true },
            _count: { id: true },
          }),
          prisma.booking.aggregate({
            where: { branchId: branch.id, paymentStatus: "PENDING" },
            _sum:  { totalAmount: true },
            _count: { id: true },
          }),
          prisma.booking.count({
            where: { branchId: branch.id },
          }),
        ]);

        return {
          branchId:      branch.id,
          branchName:    branch.name,
          paidRevenue:   paid._sum.totalAmount   || 0,
          paidCount:     paid._count.id          || 0,
          pendingAmount: pending._sum.totalAmount || 0,
          pendingCount:  pending._count.id        || 0,
          totalBookings: total,
        };
      })
    );

    // Sort by paidRevenue descending
    revenue.sort((a, b) => b.paidRevenue - a.paidRevenue);

    res.json(revenue);
  } catch (err) {
    console.error("PA REVENUE ERROR:", err);
    res.status(500).json({ message: "Failed to load revenue" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/admins
   All branch admins under this park
══════════════════════════════════════════════ */
router.get("/admins", async (req, res) => {
  try {
    const { parkId } = req.user;

    const branchIds = await getParkBranchIds(parkId);

    const admins = await prisma.user.findMany({
      where: {
        branchId: { in: branchIds },
        role:     "BRANCH_ADMIN",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id:        true,
        name:      true,
        email:     true,
        suspended: true,
        createdAt: true,
        branch: {
          select: { id: true, name: true },
        },
      },
    });

    res.json(admins);
  } catch (err) {
    console.error("PA ADMINS ERROR:", err);
    res.status(500).json({ message: "Failed to load admins" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/park-admin/admins/:id/suspend
   Suspend a branch admin
══════════════════════════════════════════════ */
router.patch("/admins/:id/suspend", async (req, res) => {
  try {
    const { parkId } = req.user;
    const branchIds  = await getParkBranchIds(parkId);

    // Verify admin belongs to this park
    const admin = await prisma.user.findFirst({
      where: {
        id:       req.params.id,
        role:     "BRANCH_ADMIN",
        branchId: { in: branchIds },
      },
    });

    if (!admin) {
      return res.status(404).json({ message: "Admin not found in your park" });
    }

    await prisma.user.update({
      where: { id: admin.id },
      data:  { suspended: true },
    });

    res.json({ message: "Admin suspended" });
  } catch (err) {
    console.error("PA SUSPEND ADMIN ERROR:", err);
    res.status(500).json({ message: "Failed to suspend admin" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/park-admin/admins/:id/activate
   Reactivate a branch admin
══════════════════════════════════════════════ */
router.patch("/admins/:id/activate", async (req, res) => {
  try {
    const { parkId } = req.user;
    const branchIds  = await getParkBranchIds(parkId);

    const admin = await prisma.user.findFirst({
      where: {
        id:       req.params.id,
        role:     "BRANCH_ADMIN",
        branchId: { in: branchIds },
      },
    });

    if (!admin) {
      return res.status(404).json({ message: "Admin not found in your park" });
    }

    await prisma.user.update({
      where: { id: admin.id },
      data:  { suspended: false },
    });

    res.json({ message: "Admin activated" });
  } catch (err) {
    console.error("PA ACTIVATE ADMIN ERROR:", err);
    res.status(500).json({ message: "Failed to activate admin" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/park-admin/reports
   Summary report across all branches
══════════════════════════════════════════════ */
router.get("/reports", async (req, res) => {
  try {
    const { parkId } = req.user;
    const { from, to } = req.query;

    const branchIds = await getParkBranchIds(parkId);

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from + "T00:00:00");
    if (to)   dateFilter.lte = new Date(to   + "T23:59:59");

    const bookingWhere = {
      branchId: { in: branchIds },
      ...(from || to ? { createdAt: dateFilter } : {}),
    };

    const [
      totalBookings,
      confirmedBookings,
      cancelledBookings,
      onlinePayments,
      cashPayments,
      revenueResult,
    ] = await Promise.all([
      prisma.booking.count({ where: bookingWhere }),
      prisma.booking.count({ where: { ...bookingWhere, status: "CONFIRMED" } }),
      prisma.booking.count({ where: { ...bookingWhere, status: "CANCELLED" } }),
      prisma.booking.count({ where: { ...bookingWhere, paymentMethod: "ONLINE" } }),
      prisma.booking.count({ where: { ...bookingWhere, paymentMethod: "CASH" } }),
      prisma.booking.aggregate({
        where: { ...bookingWhere, paymentStatus: "PAID" },
        _sum:  { totalAmount: true },
      }),
    ]);

    // Per-branch breakdown
    const branchBreakdown = await Promise.all(
      branchIds.map(async (branchId) => {
        const branch = await prisma.branch.findUnique({
          where:  { id: branchId },
          select: { id: true, name: true },
        });

        const [bookings, revenue] = await Promise.all([
          prisma.booking.count({ where: { ...bookingWhere, branchId } }),
          prisma.booking.aggregate({
            where: { ...bookingWhere, branchId, paymentStatus: "PAID" },
            _sum:  { totalAmount: true },
          }),
        ]);

        return {
          branchId,
          branchName:  branch?.name || "Unknown",
          bookings,
          revenue:     revenue._sum.totalAmount || 0,
        };
      })
    );

    res.json({
      summary: {
        totalBookings,
        confirmedBookings,
        cancelledBookings,
        onlinePayments,
        cashPayments,
        totalRevenue: revenueResult._sum.totalAmount || 0,
      },
      branchBreakdown: branchBreakdown.sort((a, b) => b.revenue - a.revenue),
    });
  } catch (err) {
    console.error("PA REPORTS ERROR:", err);
    res.status(500).json({ message: "Failed to load reports" });
  }
});

module.exports = router;