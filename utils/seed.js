const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  // clear old data (optional)
  await prisma.booking.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.user.deleteMany();
  await prisma.branch.deleteMany();

  // create branches
  const abuja = await prisma.branch.create({
    data: {
      name: "Abuja",
      location: "Abuja"
    }
  });

  const lagos = await prisma.branch.create({
    data: {
      name: "Lagos",
      location: "Lagos"
    }
  });

  const makurdi = await prisma.branch.create({
    data: {
      name: "Makurdi",
      location: "Makurdi"
    }
  });

  // hash password
  const password = await bcrypt.hash("password123", 10);

  // create users
  await prisma.user.create({
    data: {
      name: "Abuja Admin",
      email: "abuja@benue.com",
      password,
      branchId: abuja.id
    }
  });

  await prisma.user.create({
    data: {
      name: "Lagos Admin",
      email: "lagos@benue.com",
      password,
      branchId: lagos.id
    }
  });

  await prisma.user.create({
    data: {
      name: "Makurdi Admin",
      email: "makurdi@benue.com",
      password,
      branchId: makurdi.id
    }
  });

  console.log("Seed completed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });