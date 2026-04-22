const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

async function reset() {
  const password = await bcrypt.hash("admin123", 10);

  await prisma.user.update({
    where: {
      email: "superadmin@abibot.com"
    },
    data: {
      password: password,
      role: "SUPER_ADMIN"
    }
  });

  console.log("Super admin password reset");
}

reset()
  .catch(console.error)
  .finally(() => prisma.$disconnect());