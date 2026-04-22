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
   GET /api/super/stats
   System-wide dashboard numbers
══════════════════════════════════════════════ */
router.get("/stats", async (req, res) => {
  try {
    const [
      totalParks,
      activeParks,
      suspendedParks,
      totalTrips,
      totalBookings,
      totalUsers,
      bookingsWithPrice,
    ] = await Promise.all([
      prisma.park.count({ where: { deletedAt: null } }),
      prisma.park.count({ where: { status: "ACTIVE",    deletedAt: null } }),
      prisma.park.count({ where: { status: "SUSPENDED", deletedAt: null } }),
      prisma.trip.count(),
      prisma.booking.count(),
      prisma.user.count({ where: { role: "BRANCH_ADMIN" } }),
      prisma.booking.findMany({ include: { trip: { select: { price: true } } } }),
    ]);

    const totalRevenue = bookingsWithPrice.reduce((sum, b) => sum + (b.trip?.price || 0), 0);

    res.json({
      totalParks,
      activeParks,
      suspendedParks,
      totalTrips,
      totalBookings,
      totalRevenue,
      totalUsers,
    });
  } catch (err) {
    console.error("SA STATS ERROR:", err);
    res.status(500).json({ message: "Failed to load stats" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/parks
   All parks with trip + booking counts
══════════════════════════════════════════════ */
router.get("/parks", async (req, res) => {
  try {
    const parks = await prisma.park.findMany({
      where: { 
  deletedAt: null,
  status: "ACTIVE"
},
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            branches: true,
          }
        },
        branches: {
          include: {
            _count: {
              select: {
                trips: true,
                bookings: true,
              }
            }
          }
        }
      }
    });

    // Aggregate trips, bookings, and branch count per park
    const result = parks.map(park => {
      const trips    = park.branches.reduce((sum, b) => sum + (b._count?.trips    || 0), 0);
      const bookings = park.branches.reduce((sum, b) => sum + (b._count?.bookings || 0), 0);
      return {
        id:        park.id,
        name:      park.name,
        location:  park.location,
        status:    park.status,
        createdAt: park.createdAt,
        _count:    { trips, bookings, branches: park.branches.length },
      };
    });

    res.json(result);
  } catch (err) {
    console.error("SA PARKS ERROR:", err);
    res.status(500).json({ message: "Failed to load parks" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/super/parks
   Create park only — branches and admins are
   added separately after the park exists.
══════════════════════════════════════════════ */
router.post("/parks", async (req, res) => {
  try {
    const { name, location } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Park name is required" });
    }

    const park = await prisma.park.create({
      data: { name, location: location || null, status: "ACTIVE" }
    });

    res.status(201).json(park);
  } catch (err) {
    console.error("SA CREATE PARK ERROR:", err);
    res.status(500).json({ message: "Failed to create park" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/super/branches
   Create a branch under an existing park
══════════════════════════════════════════════ */
router.post("/branches", async (req, res) => {
  try {
    const { name, parkId } = req.body;

    if (!name || !parkId) {
      return res.status(400).json({ message: "Branch name and parkId are required" });
    }

    const park = await prisma.park.findUnique({ where: { id: parkId } });
    if (!park) return res.status(404).json({ message: "Park not found" });

    const branch = await prisma.branch.create({
      data: { name, parkId }
    });

    res.status(201).json(branch);
  } catch (err) {
    console.error("SA CREATE BRANCH ERROR:", err);
    res.status(500).json({ message: "Failed to create branch" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/branches/:parkId
   Get all branches for a specific park
══════════════════════════════════════════════ */
router.get("/branches/:parkId", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { parkId } = req.params;

    const branches = await prisma.branch.findMany({
      where: {
        parkId: parkId
      },
      orderBy: {
        name: "asc"
      }
    });

    res.json(branches);
  } catch (error) {
    console.error("GET BRANCHES ERROR:", error);
    res.status(500).json({ error: "Failed to fetch branches" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/super/branch-admin
   Create a branch admin for an existing branch
══════════════════════════════════════════════ */
router.post("/branch-admin", async (req, res) => {
  try {
    const { name, email, password, branchId } = req.body;

    if (!name || !email || !password || !branchId) {
      return res.status(400).json({ message: "name, email, password and branchId are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: "Email already in use" });

    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    const hashed = await bcrypt.hash(password, 10);

    const admin = await prisma.user.create({
      data: {
        name, email,
        password: hashed,
        role:     "BRANCH_ADMIN",
        branchId,
      }
    });

    res.status(201).json({ id: admin.id, name: admin.name, email: admin.email });
  } catch (err) {
    console.error("SA CREATE BRANCH ADMIN ERROR:", err);
    res.status(500).json({ message: "Failed to create branch admin" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/super/parks/:id/suspend
   Suspend park — sets status + suspends users
══════════════════════════════════════════════ */
router.patch("/parks/:id/suspend", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.$transaction(async (tx) => {
      await tx.park.update({
        where: { id },
        data:  { status: "SUSPENDED" }
      });

      // Find all branches of this park, then suspend those users
      const branches = await tx.branch.findMany({ where: { parkId: id }, select: { id: true } });
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

/* ══════════════════════════════════════════════
   PATCH /api/super/parks/:id/activate
   Re-activate park + restore user access
══════════════════════════════════════════════ */
router.patch("/parks/:id/activate", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.$transaction(async (tx) => {
      await tx.park.update({
        where: { id },
        data:  { status: "ACTIVE" }
      });

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

/* ══════════════════════════════════════════════
   DELETE /api/super/parks/:id
   Soft delete park
══════════════════════════════════════════════ */
router.delete("/parks/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.$transaction(async (tx) => {
      // mark park deleted
      await tx.park.update({
        where: { id },
        data: { status: "DELETED", deletedAt: new Date() }
      });

      // find branches under park
      const branches = await tx.branch.findMany({
        where: { parkId: id },
        select: { id: true }
      });

      const branchIds = branches.map(b => b.id);

      // suspend branch admins
      if (branchIds.length) {
        await tx.user.updateMany({
          where: {
            branchId: { in: branchIds },
            role: "BRANCH_ADMIN"
          },
          data: { suspended: true }
        });
      }
    });

    res.json({ message: "Park deleted successfully" });
  } catch (err) {
    console.error("SA DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete park" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/super/admins
   All branch admins with their park info
══════════════════════════════════════════════ */
router.get("/admins", async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { 
        role: "BRANCH_ADMIN",
        branch: {
          park: {
            deletedAt: null   // 👈 add this
          }
        }
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        suspended: true,
        createdAt: true,
        branch: {
          select: {
            id: true,
            name: true,
            park: {
              select: {
                id: true,
                name: true
              }
            }
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