import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { prisma } from './prisma';
import { logger } from './logger';

export async function initializeDefaultData() {
  try {
    // Check if admin exists
    const adminExists = await prisma.user.findFirst({
      where: { role: 'super_admin' }
    });
    
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash(
        process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@123',
        12
      );
      
      await prisma.user.create({
        data: {
          email: process.env.DEFAULT_ADMIN_EMAIL || 'admin@company.com',
          password: hashedPassword,
          firstName: 'System',
          lastName: 'Administrator',
          role: 'super_admin',
          permissions: JSON.stringify([
            'employees:read', 'employees:write', 'employees:delete',
            'departments:read', 'departments:write', 'departments:delete',
            'shifts:read', 'shifts:write', 'shifts:delete',
            'attendance:read', 'attendance:write', 'attendance:delete',
            'leaves:read', 'leaves:write', 'leaves:approve',
            'reports:read', 'reports:export',
            'settings:read', 'settings:write',
            'terminals:read', 'terminals:write', 'terminals:delete',
            'users:read', 'users:write', 'users:delete'
          ]),
          isActive: true
        }
      });
      
      logger.info('Default admin user created');
    }
    
    // Create default settings
    const defaultSettings = [
      { key: 'company_name', value: 'My Company', category: 'general', description: 'Company name displayed in the application' },
      { key: 'timezone', value: 'UTC', category: 'general', description: 'Default timezone for attendance tracking' },
      { key: 'date_format', value: 'YYYY-MM-DD', category: 'general', description: 'Date format used across the application' },
      { key: 'time_format', value: 'HH:mm', category: 'general', description: 'Time format (24h or 12h)' },
      { key: 'work_hours_per_day', value: '8', category: 'attendance', description: 'Standard work hours per day' },
      { key: 'overtime_multiplier', value: '1.5', category: 'attendance', description: 'Overtime pay multiplier' },
      { key: 'late_grace_minutes', value: '15', category: 'attendance', description: 'Grace period for late check-ins' },
      { key: 'early_leave_minutes', value: '15', category: 'attendance', description: 'Minutes before shift end considered early leave' },
      { key: 'auto_clock_out_hours', value: '12', category: 'attendance', description: 'Auto clock-out after N hours if missed' },
      { key: 'annual_leave_days', value: '20', category: 'leaves', description: 'Default annual leave days per employee' },
      { key: 'sick_leave_days', value: '10', category: 'leaves', description: 'Default sick leave days per employee' },
      { key: 'personal_leave_days', value: '5', category: 'leaves', description: 'Default personal leave days per employee' },
      { key: 'duplicate_event_window', value: '300', category: 'terminal', description: 'Seconds to consider as duplicate event' },
      { key: 'terminal_sync_interval', value: '15000', category: 'terminal', description: 'Milliseconds between terminal syncs' },
      { key: 'poll_interval', value: '3000', category: 'terminal', description: 'Milliseconds between event polling' }
    ];
    
    for (const setting of defaultSettings) {
      await prisma.setting.upsert({
        where: { key: setting.key },
        update: {},
        create: {
          id: randomUUID(),
          ...setting,
          updatedAt: new Date()
        }
      });
    }
    
    // Create default department if none exists
    const deptExists = await prisma.department.findFirst();
    if (!deptExists) {
      await prisma.department.create({
        data: {
          name: 'General',
          description: 'Default department',
          color: 'bg-blue-500',
          isActive: true
        }
      });
      logger.info('Default department created');
    }
    
    // Create default shift if none exists
    const shiftExists = await prisma.shift.findFirst();
    if (!shiftExists) {
      await prisma.shift.create({
        data: {
          name: 'Standard Shift',
          description: 'Regular 9 AM to 6 PM shift',
          startTime: '09:00',
          endTime: '18:00',
          breakDuration: 60,
          graceMinutes: 15,
          overtimeAfter: 8,
          workingDays: JSON.stringify([1, 2, 3, 4, 5]),
          color: '#3B82F6',
          isActive: true
        }
      });
      logger.info('Default shift created');
    }
    
    logger.info('Default data initialization complete');
    
  } catch (error) {
    logger.error('Error initializing default data:', error);
    throw error;
  }
}
