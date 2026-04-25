// routes/routes-mgmt/index.js
// Branch Admin manages permanent routes and staff assignments.
// Mount as: app.use("/api/routes", require("./routes/routes-mgmt"))

const router = require("express").Router();
const prisma  = require("../../prismaClient");
const auth    = require("../../middleware/auth");
const { requireBranchAdmin } = require("../../middleware/role");

router.use(auth);

/* ══════════════════════════════════════════════
   GET /api/routes
   Branch Admin: all routes for their branch
   Staff: only their assigned routes
══════════════════════════════════════════════ */
router.get("/", async (req, res) => {
  try {
    const { branchId, role, assignedRouteIds } = req.user;

    let routes;

    if (role === "BRANCH_ADMIN") {
      routes = await prisma.route.findMany({
        where:   { branchId, active: true },
        include: {
          staffAssignments: {
            include: { staff: { select: { id: true, name: true, email: true } } }
          },
          _count: { select: { trips: true } }
        },
        orderBy: { createdAt: "asc" }
      });
    } else {
      routes = await prisma.route.findMany({
        where: {
          branchId,
          active: true,
          id: { in: assignedRouteIds || [] }
        },
        include: { _count: { select: { trips: true } } },
        orderBy: { origin: "asc" }
      });
    }

    res.json(routes);
  } catch (err) {
    console.error("GET ROUTES ERROR:", err);
    res.status(500).json({ message: "Failed to fetch routes" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/routes
   Branch Admin only — create a new route
══════════════════════════════════════════════ */
router.post("/", requireBranchAdmin, async (req, res) => {
  try {
    const { origin, destination, price } = req.body;
    const { branchId } = req.user;

    if (!origin || !destination || !price) {
      return res.status(400).json({ message: "origin, destination and price are required" });
    }

    const existing = await prisma.route.findUnique({
      where: { branchId_origin_destination: { branchId, origin, destination } }
    });
    if (existing) {
      return res.status(400).json({ message: `Route ${origin} → ${destination} already exists` });
    }

    const route = await prisma.route.create({
      data: { branchId, origin, destination, price: parseFloat(price) }
    });

    res.status(201).json(route);
  } catch (err) {
    console.error("CREATE ROUTE ERROR:", err);
    res.status(500).json({ message: "Failed to create route" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/routes/:id/deactivate
   Branch Admin only — soft-deactivate route
══════════════════════════════════════════════ */
router.patch("/:id/deactivate", requireBranchAdmin, async (req, res) => {
  try {
    const route = await prisma.route.findFirst({
      where: { id: req.params.id, branchId: req.user.branchId }
    });
    if (!route) return res.status(404).json({ message: "Route not found" });

    await prisma.route.update({ where: { id: route.id }, data: { active: false } });
    res.json({ message: "Route deactivated" });
  } catch (err) {
    console.error("DEACTIVATE ROUTE ERROR:", err);
    res.status(500).json({ message: "Failed to deactivate route" });
  }
});

/* ══════════════════════════════════════════════
   DELETE /api/routes/:id
   Branch Admin only — hard delete (only if no trips)
   FIX: was prisma.staffRoute — corrected to prisma.routeStaffAssignment
══════════════════════════════════════════════ */
router.delete("/:id", requireBranchAdmin, async (req, res) => {
  try {
    const route = await prisma.route.findFirst({
      where:   { id: req.params.id, branchId: req.user.branchId },
      include: { _count: { select: { trips: true } } }
    });
    if (!route) return res.status(404).json({ message: "Route not found" });
    if (route._count.trips > 0) {
      return res.status(400).json({ message: "Cannot delete route with existing trips. Deactivate it instead." });
    }

    // FIX: prisma.staffRoute → prisma.routeStaffAssignment
    await prisma.routeStaffAssignment.deleteMany({ where: { routeId: route.id } });
    await prisma.route.delete({ where: { id: route.id } });

    res.json({ message: "Route deleted" });
  } catch (err) {
    console.error("DELETE ROUTE ERROR:", err);
    res.status(500).json({ message: "Failed to delete route" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/routes/:id/assign
   Branch Admin assigns a staff member to a route
   Body: { staffId }
══════════════════════════════════════════════ */
router.post("/:id/assign", requireBranchAdmin, async (req, res) => {
  try {
    const { staffId } = req.body;
    const { branchId } = req.user;

    if (!staffId) return res.status(400).json({ message: "staffId required" });

    const route = await prisma.route.findFirst({
      where: { id: req.params.id, branchId }
    });
    if (!route) return res.status(404).json({ message: "Route not found" });

    const staff = await prisma.user.findFirst({
      where: { id: staffId, branchId, role: "STAFF" }
    });
    if (!staff) return res.status(404).json({ message: "Staff member not found in this branch" });

    await prisma.routeStaffAssignment.upsert({
      where:  { routeId_staffId: { routeId: route.id, staffId } },
      update: {},
      create: { staffId, routeId: route.id }
    });

    res.json({ message: `${staff.name} assigned to ${route.origin} → ${route.destination}` });
  } catch (err) {
    console.error("ASSIGN ROUTE ERROR:", err);
    res.status(500).json({ message: "Failed to assign route" });
  }
});

/* ══════════════════════════════════════════════
   DELETE /api/routes/:id/assign/:staffId
   Branch Admin removes a staff assignment
   FIX: was prisma.staffRoute — corrected to prisma.routeStaffAssignment
══════════════════════════════════════════════ */
router.delete("/:id/assign/:staffId", requireBranchAdmin, async (req, res) => {
  try {
    const { branchId } = req.user;

    // Verify route belongs to this branch before removing assignment
    const route = await prisma.route.findFirst({
      where: { id: req.params.id, branchId }
    });
    if (!route) return res.status(404).json({ message: "Route not found" });

    // FIX: prisma.staffRoute → prisma.routeStaffAssignment
    await prisma.routeStaffAssignment.deleteMany({
      where: { routeId: req.params.id, staffId: req.params.staffId }
    });

    res.json({ message: "Assignment removed" });
  } catch (err) {
    console.error("REMOVE ASSIGNMENT ERROR:", err);
    res.status(500).json({ message: "Failed to remove assignment" });
  }
});

module.exports = router;