const router = require("express").Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireSuperAdmin } = require("../middleware/role");

router.use(auth);

// CREATE BRANCH
router.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const { name, parkId } = req.body;

    if (!name || !parkId) {
      return res.status(400).json({ message: "Branch name and parkId required" });
    }

    const branch = await prisma.branch.create({ data: { name, parkId } });
    res.json(branch);

  } catch (error) {
    console.error("CREATE BRANCH ERROR:", error);
    res.status(500).json({ message: "Error creating branch" });
  }
});

// GET BRANCHES BY PARK
router.get("/:parkId", requireSuperAdmin, async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where:   { parkId: req.params.parkId },
      orderBy: { createdAt: "desc" }
    });
    res.json(branches);

  } catch (error) {
    console.error("GET BRANCHES ERROR:", error);
    res.status(500).json({ message: "Error fetching branches" });
  }
});

module.exports = router;