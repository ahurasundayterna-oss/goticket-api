const router = require("express").Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireSuperAdmin } = require("../middleware/role");

router.use(auth);

// CREATE PARK
router.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "Park name required" });

    const park = await prisma.park.create({ data: { name } });
    res.json(park);

  } catch (error) {
    console.error("CREATE PARK ERROR:", error);
    res.status(500).json({ message: "Error creating park" });
  }
});

// GET ALL PARKS
router.get("/", requireSuperAdmin, async (req, res) => {
  try {
    const parks = await prisma.park.findMany({ orderBy: { createdAt: "desc" } });
    res.json(parks);

  } catch (error) {
    console.error("GET PARKS ERROR:", error);
    res.status(500).json({ message: "Error fetching parks" });
  }
});

module.exports = router;