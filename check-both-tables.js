const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkBothTables() {
  try {
    console.log('=== Checking Both Tables ===\n');
    
    // Check AttendanceLog
    const attendanceLogs = await prisma.attendanceLog.findMany({
      include: { Employee: { select: { employeeId: true, firstName: true } } }
    });
    console.log('AttendanceLog records:', attendanceLogs.length);
    attendanceLogs.forEach(a => {
      console.log(`  - ${a.Employee.employeeId}: ${a.eventType} at ${a.timestamp}`);
    });
    
    // Check TimeEntry
    console.log('\nTimeEntry records:', );
    const timeEntries = await prisma.timeEntry.findMany({
      include: { Employee: { select: { employeeId: true, firstName: true } } },
      orderBy: { clockIn: 'desc' }
    });
    console.log('Total:', timeEntries.length);
    timeEntries.forEach(t => {
      const hours = t.totalHours ? ` (${t.totalHours} hours)` : ' (clocked in)';
      console.log(`  - ${t.Employee.employeeId}: ${t.clockIn}${hours}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkBothTables();
