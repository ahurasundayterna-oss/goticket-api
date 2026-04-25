"use strict";

const express  = require("express");
const router   = express.Router();
const prisma   = require("../prismaClient");
const auth     = require("../middleware/auth");
const bcrypt   = require("bcryptjs");

const { requireSuperAdmin } = require("../middleware/role");

/* ═════════════════════════════════════════════════════════════
   DASHBOARD STATS
═════════════════════════════════════════════════════════════ */

router.get("/stats", auth, requireSuperAdmin, async (req, res) => {
  try {
    const totalParks = await prisma.park.count();

    const activeParks = await prisma.park.count({
      where: { status: "ACTIVE" },
    });

    const suspendedParks = await prisma.park.count({
      where: { status: "SUSPENDED" },
    });

    const totalBookings = await prisma.booking.count();

    const revenue = await prisma.booking.aggregate({
      _sum:  { totalAmount: true },
      where: { paymentStatus: "PAID" },
    });

    res.json({
      totalParks,
      activeParks,
      suspendedParks,
      totalBookings,
      totalRevenue: revenue._sum.totalAmount || 0,
    });

  } catch (err) {
    console.error("STATS ERROR:", err);
    res.status(500).json({ message: "Error fetching stats" });
  }
});

/* ═════════════════════════════════════════════════════════════
   PARKS — LIST
═════════════════════════════════════════════════════════════ */

router.get("/parks", auth, requireSuperAdmin, async (req, res) => {
  try {
    const parks = await prisma.park.findMany({
      include: {
        branches: {
          include: {
            trips:    true,
            bookings: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const formatted = parks.map((park) => {
      let trips    = 0;
      let bookings = 0;
      park.branches.forEach((b) => {
        trips    += b.trips.length;
        bookings += b.bookings.length;
      });
      return { ...park, _count: { trips, bookings } };
    });

    res.json(formatted);

  } catch (err) {
    console.error("GET PARKS ERROR:", err);
    res.status(500).json({ message: "Error fetching parks" });
  }
});

/* ═════════════════════════════════════════════════════════════
   PARKS — CREATE
═════════════════════════════════════════════════════════════ */

router.post("/parks", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { name, location } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Park name is required" });
    }

    const park = await prisma.park.create({
      data: { name, location },
    });

    res.json(park);

  } catch (err) {
    console.error("CREATE PARK ERROR:", err);
    res.status(500).json({ message: "Error creating park" });
  }
});

/* ═════════════════════════════════════════════════════════════
   PARKS — SUSPEND / UNSUSPEND
═════════════════════════════════════════════════════════════ */

router.patch("/parks/:id/suspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const park = await prisma.park.findUnique({ where: { id: req.params.id } });

    if (!park)                       return res.status(404).json({ message: "Park not found" });
    if (park.status === "DELETED")   return res.status(400).json({ message: "Cannot suspend deleted park" });
    if (park.status === "SUSPENDED") return res.status(400).json({ message: "Already suspended" });

    const updated = await prisma.park.update({
      where: { id: req.params.id },
      data:  { status: "SUSPENDED" },
    });

    res.json({ message: "Park suspended", park: updated });

  } catch (err) {
    console.error("SUSPEND PARK ERROR:", err);
    res.status(500).json({ message: "Error suspending park" });
  }
});

router.patch("/parks/:id/unsuspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const park = await prisma.park.findUnique({ where: { id: req.params.id } });

    if (!park)                     return res.status(404).json({ message: "Park not found" });
    if (park.status === "DELETED") return res.status(400).json({ message: "Cannot activate a deleted park" });
    if (park.status === "ACTIVE")  return res.status(400).json({ message: "Park is already active" });

    const updated = await prisma.park.update({
      where: { id: req.params.id },
      data:  { status: "ACTIVE" },
    });

    res.json({ message: `Park "${updated.name}" reactivated`, park: updated });

  } catch (err) {
    console.error("UNSUSPEND PARK ERROR:", err);
    res.status(500).json({ message: "Error unsuspending park" });
  }
});

/* ═════════════════════════════════════════════════════════════
   BRANCHES — LIST BY PARK
   Called by SAAdmins CreateAdminModal to populate branch dropdown
═════════════════════════════════════════════════════════════ */

router.get("/branches/:parkId", auth, requireSuperAdmin, async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where:   { parkId: req.params.parkId },
      select:  { id: true, name: true, suspended: true },
      orderBy: { name: "asc" },
    });

    res.json(branches);

  } catch (err) {
    console.error("GET BRANCHES ERROR:", err);
    res.status(500).json({ message: "Error fetching branches" });
  }
});

/* ═════════════════════════════════════════════════════════════
   BRANCHES — CREATE
═════════════════════════════════════════════════════════════ */

router.post("/branches", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { name, parkId } = req.body;

    if (!name || !parkId) {
      return res.status(400).json({ message: "name and parkId are required" });
    }

    const park = await prisma.park.findUnique({ where: { id: parkId } });
    if (!park) return res.status(404).json({ message: "Park not found" });

    const branch = await prisma.branch.create({
      data: { name, parkId },
    });

    res.status(201).json(branch);

  } catch (err) {
    console.error("CREATE BRANCH ERROR:", err);
    res.status(500).json({ message: "Error creating branch" });
  }
});

/* ═════════════════════════════════════════════════════════════
   BRANCHES — SUSPEND / UNSUSPEND
═════════════════════════════════════════════════════════════ */

router.patch("/branches/:id/suspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const branch = await prisma.branch.findUnique({ where: { id: req.params.id } });
    if (!branch)          return res.status(404).json({ message: "Branch not found" });
    if (branch.suspended) return res.status(400).json({ message: "Branch already suspended" });

    const updated = await prisma.branch.update({
      where: { id: req.params.id },
      data:  { suspended: true },
    });

    res.json({ message: "Branch suspended", branch: updated });

  } catch (err) {
    console.error("SUSPEND BRANCH ERROR:", err);
    res.status(500).json({ message: "Error suspending branch" });
  }
});

router.patch("/branches/:id/unsuspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const branch = await prisma.branch.findUnique({ where: { id: req.params.id } });
    if (!branch)           return res.status(404).json({ message: "Branch not found" });
    if (!branch.suspended) return res.status(400).json({ message: "Branch is not suspended" });

    const updated = await prisma.branch.update({
      where: { id: req.params.id },
      data:  { suspended: false },
    });

    res.json({ message: "Branch active", branch: updated });

  } catch (err) {
    console.error("UNSUSPEND BRANCH ERROR:", err);
    res.status(500).json({ message: "Error unsuspending branch" });
  }
});

/* ═════════════════════════════════════════════════════════════
   ADMINS — LIST ALL BRANCH ADMINS
   Called by SAAdmins.js on page load
═════════════════════════════════════════════════════════════ */

router.get("/admins", auth, requireSuperAdmin, async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where:   { role: "BRANCH_ADMIN" },
      select: {
        id:        true,
        name:      true,
        email:     true,
        suspended: true,
        createdAt: true,
        branch: {
          select: {
            id:   true,
            name: true,
            park: {
              select: { id: true, name: true, status: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(admins);

  } catch (err) {
    console.error("GET ADMINS ERROR:", err);
    res.status(500).json({ message: "Error fetching admins" });
  }
});

/* ═════════════════════════════════════════════════════════════
   ADMINS — CREATE BRANCH ADMIN
   Called by SAAdmins.js CreateAdminModal on submit
═════════════════════════════════════════════════════════════ */

router.post("/branch-admin", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, password, branchId } = req.body;

    if (!name || !email || !password || !branchId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ message: "Email already in use" });
    }

    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const admin = await prisma.user.create({
      data: {
        name,
        email,
        password:  hashed,
        role:      "BRANCH_ADMIN",
        branchId,
      },
      select: {
        id:        true,
        name:      true,
        email:     true,
        role:      true,
        suspended: true,
        branch: {
          select: {
            id:   true,
            name: true,
            park: { select: { id: true, name: true } },
          },
        },
      },
    });

    res.status(201).json(admin);

  } catch (err) {
    console.error("CREATE BRANCH ADMIN ERROR:", err);
    res.status(500).json({ message: "Error creating branch admin" });
  }
});

/* ═════════════════════════════════════════════════════════════
   STAFF / USER — SUSPEND / UNSUSPEND
═════════════════════════════════════════════════════════════ */

router.patch("/staff/:id/suspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user)          return res.status(404).json({ message: "User not found" });
    if (user.suspended) return res.status(400).json({ message: "User already suspended" });
    if (user.role === "SUPER_ADMIN") {
      return res.status(400).json({ message: "Cannot suspend a Super Admin" });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data:  { suspended: true },
    });

    res.json({ message: "User suspended", user: updated });

  } catch (err) {
    console.error("SUSPEND USER ERROR:", err);
    res.status(500).json({ message: "Error suspending user" });
  }
});

router.patch("/staff/:id/unsuspend", auth, requireSuperAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user)           return res.status(404).json({ message: "User not found" });
    if (!user.suspended) return res.status(400).json({ message: "User is not suspended" });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data:  { suspended: false },
    });

    res.json({ message: "User active", user: updated });

  } catch (err) {
    console.error("UNSUSPEND USER ERROR:", err);
    res.status(500).json({ message: "Error unsuspending user" });
  }
});

/* ═════════════════════════════════════════════════════════════
   EXPORT
═════════════════════════════════════════════════════════════ */

module.exports = router;