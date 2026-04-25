"use strict";

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireBranchAdmin } = require("../middleware/role");


// ================= CREATE STAFF =================
router.post("/", auth, requireBranchAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const { branchId } = req.user;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return res.status(400).json({ message: "User already exists" });
    }

    const bcrypt = require("bcrypt");
    const hashedPassword = await bcrypt.hash(password, 10);

    const newStaff = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role || "STAFF",
        branchId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    res.status(201).json({
      message: "Staff created successfully",
      user: newStaff,
    });

  } catch (err) {
    console.error("CREATE STAFF ERROR:", err);
    res.status(500).json({ message: "Error creating staff" });
  }
});

// ================= GET STAFF =================
router.get("/", auth, requireBranchAdmin, async (req, res) => {
  try {
    const { branchId } = req.user;

    const staff = await prisma.user.findMany({
      where: {
  branchId,
  role: "STAFF"
},
      include: {
        routeAssignments: {
          include: {
            route: true,
          },
        },
      },
    });

    res.json(staff);

  } catch (err) {
    console.error("GET STAFF ERROR:", err);
    res.status(500).json({ message: "Error fetching staff" });
  }
});

// ================= DELETE STAFF =================
router.delete("/:id", auth, requireBranchAdmin, async (req, res) => {
  try {
    const { branchId } = req.user;

    const user = await prisma.user.findFirst({
      where: { id: req.params.id, branchId },
    });

    if (!user) {
      return res.status(404).json({ message: "Staff not found in your branch" });
    }

    await prisma.user.delete({
      where: { id: req.params.id },
    });

    res.json({ message: "Staff removed successfully" });

  } catch (err) {
    console.error("DELETE STAFF ERROR:", err);
    res.status(500).json({ message: "Error removing staff" });
  }
});

// ================= SUSPEND =================
const staffSuspend = async (req, res) => {
  try {
    const { branchId } = req.user;

    const user = await prisma.user.findFirst({
      where: { id: req.params.id, branchId },
    });

    if (!user) return res.status(404).json({ message: "Staff not found in your branch" });
    if (user.suspended) return res.status(400).json({ message: "Staff is already suspended" });
    if (user.role === "BRANCH_ADMIN") {
      return res.status(403).json({ message: "Branch Admins can only be suspended by Super Admin" });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: true },
      select: { id: true, name: true, role: true, suspended: true },
    });

    return res.json({ message: `Staff "${updated.name}" suspended.`, user: updated });

  } catch (err) {
    console.error("STAFF SUSPEND ERROR:", err);
    return res.status(500).json({ message: "Error suspending staff" });
  }
};


// ================= UNSUSPEND =================
const staffUnsuspend = async (req, res) => {
  try {
    const { branchId } = req.user;

    const user = await prisma.user.findFirst({
      where: { id: req.params.id, branchId },
    });

    if (!user) return res.status(404).json({ message: "Staff not found in your branch" });
    if (!user.suspended) return res.status(400).json({ message: "Staff is not suspended" });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: false },
      select: { id: true, name: true, role: true, suspended: true },
    });

    return res.json({ message: `Staff "${updated.name}" reactivated.`, user: updated });

  } catch (err) {
    console.error("STAFF UNSUSPEND ERROR:", err);
    return res.status(500).json({ message: "Error unsuspending staff" });
  }
};


// ================= ROUTES =================
router.patch("/:id/suspend", auth, requireBranchAdmin, staffSuspend);
router.patch("/:id/unsuspend", auth, requireBranchAdmin, staffUnsuspend);


module.exports = router;