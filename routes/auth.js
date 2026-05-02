// routes/auth.js  (login handler — add parkId to token)
const express = require("express");
const router  = express.Router();
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const prisma  = require("../prismaClient");

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await prisma.user.findUnique({
      where:   { email },
      include: {
        branch: { include: { park: true } },
        park:   true,   // for PARK_ADMIN — their directly assigned park
      },
    });

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.suspended) {
      return res.status(403).json({ message: "Account suspended", suspended: true });
    }

    // ── Determine parkId ─────────────────────────────────────────
    // PARK_ADMIN  → user.parkId (directly assigned)
    // BRANCH_ADMIN / STAFF → user.branch.parkId (via branch)
    const parkId = user.parkId || user.branch?.parkId || null;
    const parkName = user.park?.name || user.branch?.park?.name || null;

    const token = jwt.sign(
      {
        id:         user.id,
        role:       user.role,
        branchId:   user.branchId   || null,
        branchName: user.branch?.name || null,
        parkId,
        parkName,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      role:       user.role,
      name:       user.name,
      branchId:   user.branchId || null,
      branchName: user.branch?.name || null,
      parkId,
      parkName,
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ message: "Login failed" });
  }
});

module.exports = router;