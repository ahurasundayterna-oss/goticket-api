// routes/auth.js
const router = require("express").Router();
const prisma  = require("../prismaClient");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        branch: { include: { park: true } }
      }
    });

    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: "Invalid credentials" });

    if (user.suspended) {
      return res.status(403).json({
        message: "Your account has been suspended. Contact your branch admin."
      });
    }

    const token = jwt.sign(
      {
        id:         user.id,
        role:       user.role,
        branchId:   user.branchId,
        branchName: user.branch?.name || null,
        parkName:   user.branch?.park?.name || "GoTicket"
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({ token, role: user.role });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ message: "Login failed" });
  }
});

module.exports = router;