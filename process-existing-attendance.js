const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

async function processExistingAttendance() {
  try {
    console.log('=== Processing Existing Attendance Logs ===\n');
    
    // Get all attendance logs
    const logs = await prisma.attendanceLog.findMany({
      orderBy: { timestamp: 'asc' },
      include: { Employee: true }
    });
    
    console.log(`Found ${logs.length} attendance logs to process\n`);
    
    // Group by employee and date
    const grouped = {};
    logs.forEach(log => {
      const date = new Date(log.timestamp);
      date.setHours(0, 0, 0, 0);
      const dateKey = date.toISOString();
      const empKey = `${log.employeeId}-${dateKey}`;
      
      if (!grouped[empKey]) {
        grouped[empKey] = [];
      }
      grouped[empKey].push(log);
    });
    
    let processed = 0;
    
    // Process each group
    for (const key in grouped) {
      const events = grouped[key].sort((a, b) => a.timestamp - b.timestamp);
      const [empId, dateStr] = key.split('-');
      const date = new Date(dateStr);
      
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        
        if (event.eventType === 'CLOCK_IN') {
          // Check if TimeEntry already exists
          const existing = await prisma.timeEntry.findFirst({
            where: {
              employeeId: empId,
              clockIn: { 
                gte: date,
                lt: new Date(date.getTime() + 24 * 60 * 60 * 1000)
              }
            }
          });
          
          if (!existing) {
            await prisma.timeEntry.create({
              data: {
                id: randomUUID(),
                employeeId: empId,
                clockIn: event.timestamp,
                status: 'clocked_in',
                location: event.Employee?.location || 'Kiosk',
                terminalId: event.terminalId,
                verifyMethod: event.verifyMethod || 'FINGERPRINT',
                updatedAt: new Date()
              }
            });
            processed++;
            console.log(`✓ Created TimeEntry for ${event.Employee.employeeId} CLOCK_IN at ${event.timestamp}`);
          }
        } else if (event.eventType === 'CLOCK_OUT') {
          // Find corresponding clock in
          const clockInEvent = events.find(e => e.eventType === 'CLOCK_IN');
          
          if (clockInEvent) {
            const timeEntry = await prisma.timeEntry.findFirst({
              where: {
                employeeId: empId,
                clockIn: { 
                  gte: date,
                  lt: new Date(date.getTime() + 24 * 60 * 60 * 1000)
                },
                clockOut: null
              }
            });
            
            if (timeEntry) {
              const clockInTime = new Date(timeEntry.clockIn);
              const clockOutTime = event.timestamp;
              const totalHours = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
              const regularHours = Math.min(totalHours, 8);
              const overtimeHours = Math.max(0, totalHours - 8);
              
              await prisma.timeEntry.update({
                where: { id: timeEntry.id },
                data: {
                  clockOut: clockOutTime,
                  totalHours: Math.round(totalHours * 100) / 100,
                  regularHours: Math.round(regularHours * 100) / 100,
                  overtimeHours: Math.round(overtimeHours * 100) / 100,
                  status: 'clocked_out',
                  updatedAt: new Date()
                }
              });
              processed++;
              console.log(`✓ Updated TimeEntry for ${event.Employee.employeeId} CLOCK_OUT (${regularHours.toFixed(2)} hours)`);
            }
          }
        }
      }
    }
    
    console.log(`\n✓ Processed ${processed} records`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

processExistingAttendance();
