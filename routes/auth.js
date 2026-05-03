// routes/auth.js
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

    // User has no direct park relation — park is always reached via branch
    const user = await prisma.user.findUnique({
      where:   { email },
      include: {
        branch: { include: { park: true } },
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

    // Park is always via branch for all roles
    const parkId   = user.branch?.park?.id   || null;
    const parkName = user.branch?.park?.name || null;

    const token = jwt.sign(
      {
        id:         user.id,
        role:       user.role,
        branchId:   user.branchId     || null,
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
      branchId:   user.branchId     || null,
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