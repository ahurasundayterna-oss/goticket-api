const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const bcrypt  = require("bcrypt");
const auth    = require("../middleware/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");

// CREATE BRANCH ADMIN — Super Admin only
router.post("/branch-admin", auth, requireSuperAdmin, async (req, res) => {
  try {
    const { name, email, password, branchId } = req.body;

    if (!name || !email || !password || !branchId) {
      return res.status(400).json({ error: "All fields required" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashed,
        role:     "BRANCH_ADMIN",
        branchId: String(branchId)
      }
    });

    res.status(201).json(user);

  } catch (error) {
    console.error("CREATE ADMIN ERROR:", error);
    res.status(500).json({ error: "Failed to create branch admin" });
  }
});

module.exports = router;