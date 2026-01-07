"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Get dashboard statistics
router.get('/stats', (0, auth_1.requirePermission)('attendance:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const [totalEmployees, activeEmployees, presentToday, onLeaveToday, lateToday, pendingLeaves, thisMonthEntries, lastMonthEntries, departments, recentClockIns, weeklyAttendance] = await Promise.all([
        // Total employees
        prisma_1.prisma.employee.count(),
        // Active employees
        prisma_1.prisma.employee.count({ where: { status: 'active' } }),
        // Present today
        prisma_1.prisma.timeEntry.count({
            where: { clockIn: { gte: today, lt: tomorrow } }
        }),
        // On leave today
        prisma_1.prisma.leaveRequest.count({
            where: {
                status: 'approved',
                startDate: { lte: today },
                endDate: { gte: today }
            }
        }),
        // Late arrivals today (simplified - after 9:15 AM)
        prisma_1.prisma.timeEntry.count({
            where: {
                clockIn: {
                    gte: new Date(today.getTime() + 9.25 * 60 * 60 * 1000), // 9:15 AM
                    lt: tomorrow
                }
            }
        }),
        // Pending leave requests
        prisma_1.prisma.leaveRequest.count({
            where: { status: 'pending' }
        }),
        // This month total hours
        prisma_1.prisma.timeEntry.aggregate({
            where: { clockIn: { gte: thisMonthStart } },
            _sum: { totalHours: true, overtimeHours: true }
        }),
        // Last month total hours
        prisma_1.prisma.timeEntry.aggregate({
            where: {
                clockIn: { gte: lastMonthStart, lte: lastMonthEnd }
            },
            _sum: { totalHours: true }
        }),
        // Departments count
        prisma_1.prisma.department.count({ where: { isActive: true } }),
        // Recent clock-ins
        prisma_1.prisma.timeEntry.findMany({
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
        }),
        // Weekly attendance (last 7 days)
        (async () => {
            const result = [];
            for (let i = 6; i >= 0; i--) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                const nextDate = new Date(date);
                nextDate.setDate(nextDate.getDate() + 1);
                const count = await prisma_1.prisma.timeEntry.count({
                    where: {
                        clockIn: { gte: date, lt: nextDate }
                    }
                });
                result.push({
                    date: date.toISOString().split('T')[0],
                    dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
                    count
                });
            }
            return result;
        })()
    ]);
    const absentToday = Math.max(0, activeEmployees - presentToday - onLeaveToday);
    const attendanceRate = activeEmployees > 0
        ? Math.round((presentToday / activeEmployees) * 100)
        : 0;
    // Calculate month-over-month change
    const thisMonthHours = thisMonthEntries._sum.totalHours || 0;
    const lastMonthHours = lastMonthEntries._sum.totalHours || 0;
    const hoursChange = lastMonthHours > 0
        ? Math.round(((thisMonthHours - lastMonthHours) / lastMonthHours) * 100)
        : 0;
    res.json({
        overview: {
            totalEmployees,
            activeEmployees,
            departments,
            presentToday,
            absentToday,
            onLeaveToday,
            lateToday,
            attendanceRate
        },
        workHours: {
            thisMonth: Math.round(thisMonthHours * 100) / 100,
            lastMonth: Math.round(lastMonthHours * 100) / 100,
            change: hoursChange,
            overtime: Math.round((thisMonthEntries._sum.overtimeHours || 0) * 100) / 100
        },
        pending: {
            leaveRequests: pendingLeaves
        },
        recentActivity: recentClockIns.map(entry => ({
            type: entry.clockOut ? 'clock_out' : 'clock_in',
            Employee: {
                name: `${entry.Employee.firstName} ${entry.Employee.lastName}`,
                photo: entry.Employee.photo,
                department: entry.Employee.department?.name
            },
            time: entry.clockOut || entry.clockIn,
            status: entry.status
        })),
        weeklyAttendance
    });
}));
// Get today's attendance with weekly trend
router.get('/today-attendance', (0, auth_1.requirePermission)('attendance:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Weekly attendance (last 7 days)
    const result = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + 1);
        const count = await prisma_1.prisma.timeEntry.count({
            where: {
                clockIn: { gte: date, lt: nextDate }
            }
        });
        result.push({
            date: date.toISOString().split('T')[0],
            dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
            count
        });
    }
    // Department distribution
    const departments = await prisma_1.prisma.department.findMany({
        where: { isActive: true },
        include: {
            _count: {
                select: {
                    employees: { where: { status: 'active' } }
                }
            }
        }
    });
    res.json({
        weeklyData: result,
        departmentData: departments.map(d => ({
            name: d.name,
            count: d._count.employees,
            color: d.color
        })),
        attendance: result,
        department: departments.map(d => ({
            name: d.name,
            count: d._count.employees,
            color: d.color
        }))
    });
}));
// Get attendance chart data
router.get('/charts/attendance', (0, auth_1.requirePermission)('attendance:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { period = '30' } = req.query;
    const days = parseInt(period);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - days);
    const activeEmployees = await prisma_1.prisma.employee.count({ where: { status: 'active' } });
    const data = [];
    for (let i = 0; i < days; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + 1);
        const [present, onLeave] = await Promise.all([
            prisma_1.prisma.timeEntry.count({
                where: {
                    clockIn: { gte: date, lt: nextDate }
                }
            }),
            prisma_1.prisma.leaveRequest.count({
                where: {
                    status: 'approved',
                    startDate: { lte: date },
                    endDate: { gte: date }
                }
            })
        ]);
        data.push({
            date: date.toISOString().split('T')[0],
            present,
            absent: Math.max(0, activeEmployees - present - onLeave),
            onLeave,
            rate: activeEmployees > 0 ? Math.round((present / activeEmployees) * 100) : 0
        });
    }
    res.json(data);
}));
// Get department distribution
router.get('/charts/departments', (0, auth_1.requirePermission)('departments:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const departments = await prisma_1.prisma.department.findMany({
        where: { isActive: true },
        include: {
            _count: {
                select: {
                    employees: { where: { status: 'active' } }
                }
            }
        }
    });
    res.json(departments.map(d => ({
        name: d.name,
        count: d._count.employees,
        color: d.color
    })));
}));
// Get work hours trend
router.get('/charts/hours', (0, auth_1.requirePermission)('attendance:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { period = '12' } = req.query;
    const months = parseInt(period);
    const today = new Date();
    const data = [];
    for (let i = months - 1; i >= 0; i--) {
        const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
        const result = await prisma_1.prisma.timeEntry.aggregate({
            where: {
                clockIn: { gte: monthStart, lte: monthEnd }
            },
            _sum: { totalHours: true, overtimeHours: true }
        });
        data.push({
            month: monthStart.toLocaleString('default', { month: 'short', year: 'numeric' }),
            regularHours: Math.round((result._sum.totalHours || 0) - (result._sum.overtimeHours || 0)),
            overtimeHours: Math.round(result._sum.overtimeHours || 0)
        });
    }
    res.json(data);
}));
// Get leave distribution
router.get('/charts/leaves', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const leavesByType = await prisma_1.prisma.leaveRequest.groupBy({
        by: ['leaveType'],
        where: {
            status: 'approved',
            startDate: { gte: startOfYear }
        },
        _count: true,
        _sum: { totalDays: true }
    });
    const colors = {
        sick: '#EF4444',
        vacation: '#3B82F6',
        personal: '#8B5CF6',
        maternity: '#EC4899',
        paternity: '#06B6D4',
        unpaid: '#6B7280'
    };
    res.json(leavesByType.map(l => ({
        type: l.leaveType,
        count: l._count,
        days: l._sum.totalDays,
        color: colors[l.leaveType] || '#6B7280'
    })));
}));
// Get notifications
router.get('/notifications', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const notifications = await prisma_1.prisma.notification.findMany({
        where: {
            OR: [
                { userId: req.user.id },
                { userId: null }
            ]
        },
        orderBy: { createdAt: 'desc' },
        take: 20
    });
    res.json(notifications);
}));
// Mark notification as read
router.post('/notifications/:id/read', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    await prisma_1.prisma.notification.update({
        where: { id: req.params.id },
        data: { isRead: true }
    });
    res.json({ success: true });
}));
// Mark all notifications as read
router.post('/notifications/read-all', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    await prisma_1.prisma.notification.updateMany({
        where: {
            OR: [
                { userId: req.user.id },
                { userId: null }
            ],
            isRead: false
        },
        data: { isRead: true }
    });
    res.json({ success: true });
}));
exports.default = router;
//# sourceMappingURL=dashboard.js.map