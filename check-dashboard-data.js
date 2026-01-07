const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkDashboardData() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    console.log('=== Dashboard Data Check ===\n');
    
    // Present today (from TimeEntry)
    const presentToday = await prisma.timeEntry.count({
      where: { clockIn: { gte: today, lt: tomorrow } }
    });
    console.log('Present today (from TimeEntry):', presentToday);
    
    // Get recent clock-ins
    const recentClockIns = await prisma.timeEntry.findMany({
      where: { clockIn: { gte: today } },
      take: 10,
      orderBy: { clockIn: 'desc' },
      include: {
        Employee: {
          select: {
            firstName: true,
            lastName: true,
            photo: true,
            department: { select: { name: true } }
          }
        }
      }
    });
    
    console.log('\nRecent clock-ins:');
    recentClockIns.forEach(entry => {
      const time = entry.clockIn.toLocaleTimeString();
      console.log(`  - ${entry.Employee.firstName} ${entry.Employee.lastName} clocked in at ${time}`);
    });
    
    // Check active employees
    const activeEmployees = await prisma.employee.count({ where: { status: 'active' } });
    console.log('\nActive employees:', activeEmployees);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkDashboardData();
