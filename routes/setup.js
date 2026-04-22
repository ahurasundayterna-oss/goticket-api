const router = require("express").Router();
const prisma = require("../prismaClient");
const bcrypt = require("bcrypt");

router.get("/create-super-admin", async (req, res) => {
  try {
    const hashed = await bcrypt.hash("admin123", 10);

    const user = await prisma.user.create({
      data: {
        name: "Super Admin",
        email: "superadmin@abibot.com",
        password: hashed,
        role: "SUPER_ADMIN"
      }
    });

    res.json(user);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "error" });
  }
});

module.exports = router;