const prisma = require("../prismaClient");
const bcrypt = require("bcrypt");

async function main() {
  const hashedPassword = await bcrypt.hash("123456", 10);

  await prisma.user.upsert({
    where: { email: "admin@abibot.com" },
    update: {
      role: "SUPER_ADMIN",
      password: hashedPassword
    },
    create: {
      name: "Super Admin",
      email: "admin@abibot.com",
      password: hashedPassword,
      role: "SUPER_ADMIN"
    }
  });

  console.log("Super admin ready");
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());