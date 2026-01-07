const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkAttendance() {
  try {
    console.log('=== Checking Database ===\n');
    
    // Check employees
    const employees = await prisma.employee.findMany({
      select: { id: true, employeeId: true, firstName: true, lastName: true }
    });
    console.log('Employees in DB:', employees.length);
    employees.forEach(e => console.log(`  - ${e.employeeId}: ${e.firstName} ${e.lastName} (ID: ${e.id})`));
    
    // Check attendance logs
    console.log('\nAttendance Logs in DB:');
    const attendance = await prisma.attendanceLog.findMany({
      include: { Employee: { select: { employeeId: true, firstName: true } } }
    });
    console.log('Total records:', attendance.length);
    attendance.forEach(a => {
      console.log(`  - ${a.Employee.employeeId}: ${a.eventType} at ${a.timestamp}`);
    });
    
    // Check today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayAttendance = await prisma.attendanceLog.findMany({
      where: { timestamp: { gte: today } },
      include: { Employee: { select: { employeeId: true, firstName: true } } }
    });
    console.log(`\nToday's attendance (${today.toISOString().split('T')[0]}):`, todayAttendance.length);
    todayAttendance.forEach(a => {
      console.log(`  - ${a.Employee.employeeId}: ${a.eventType} at ${a.timestamp}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAttendance();
