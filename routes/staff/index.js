// routes/staff/index.js
// Branch Admin manages staff (bookers) within their branch.
// Mount as: app.use("/api/staff", require("./routes/staff"))

const router = require("express").Router();
const prisma  = require("../../prismaClient");
const bcrypt  = require("bcrypt");
const auth    = require("../../middleware/auth");
const { requireBranchAdmin } = require("../../middleware/role");

router.use(auth, requireBranchAdmin);

/* ══════════════════════════════════════════════
   GET /api/staff
   List all staff in this branch with assignments
══════════════════════════════════════════════ */
router.get("/", async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: {
        branchId: req.user.branchId,
        role: "STAFF"
      },
      orderBy: {
        createdAt: "desc"
      },
      select: {
        id: true,
        name: true,
        email: true,
        suspended: true,
        createdAt: true,
        routeAssignments: {   // 👈 FIXED HERE
          include: {
            route: {
              select: {
                id: true,
                origin: true,
                destination: true
              }
            }
          }
        }
      }
    });

    res.json(staff);
  } catch (err) {
    console.error("GET STAFF ERROR:", err);
    res.status(500).json({ message: "Failed to fetch staff" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/staff
   Create a new staff (booker) account
   Body: { name, email, password }
══════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const { branchId } = req.user;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: "Email already in use" });

    const hashed = await bcrypt.hash(password, 10);

    const staff = await prisma.user.create({
      data: { name, email, password: hashed, role: "STAFF", branchId }
    });

    res.status(201).json({ id: staff.id, name: staff.name, email: staff.email, role: staff.role });
  } catch (err) {
    console.error("CREATE STAFF ERROR:", err);
    res.status(500).json({ message: "Failed to create staff" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/staff/:id/suspend
   Suspend a staff member
══════════════════════════════════════════════ */
router.patch("/:id/suspend", async (req, res) => {
  try {
    await prisma.user.updateMany({
      where: { id: req.params.id, branchId: req.user.branchId, role: "STAFF" },
      data:  { suspended: true }
    });
    res.json({ message: "Staff suspended" });
  } catch (err) {
    res.status(500).json({ message: "Failed to suspend staff" });
  }
});

/* ══════════════════════════════════════════════
   PATCH /api/staff/:id/activate
   Re-activate a suspended staff member
══════════════════════════════════════════════ */
router.patch("/:id/activate", async (req, res) => {
  try {
    await prisma.user.updateMany({
      where: { id: req.params.id, branchId: req.user.branchId, role: "STAFF" },
      data:  { suspended: false }
    });
    res.json({ message: "Staff activated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to activate staff" });
  }
});

/* ══════════════════════════════════════════════
   DELETE /api/staff/:id
   Remove a staff member (also removes assignments)
══════════════════════════════════════════════ */
router.delete("/:id", async (req, res) => {
  try {
    const staff = await prisma.user.findFirst({
      where: { id: req.params.id, branchId: req.user.branchId, role: "STAFF" }
    });
    if (!staff) return res.status(404).json({ message: "Staff not found" });

    // Remove route assignments first
    await prisma.staffRoute.deleteMany({ where: { staffId: req.params.id } });
    await prisma.user.delete({ where: { id: req.params.id } });

    res.json({ message: "Staff removed" });
  } catch (err) {
    console.error("DELETE STAFF ERROR:", err);
    res.status(500).json({ message: "Failed to remove staff" });
  }
});

module.exports = router;