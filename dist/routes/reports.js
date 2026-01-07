"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Get attendance report
router.get('/attendance', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, departmentId, employeeId, groupBy = 'day' } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const where = {
        clockIn: { gte: start, lte: end }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    if (employeeId) {
        where.employeeId = employeeId;
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    department: { select: { id: true, name: true } },
                    shift: true
                }
            }
        },
        orderBy: { clockIn: 'asc' }
    });
    // Get all employees for calculating absent days
    const employeeWhere = { status: 'active' };
    if (departmentId) {
        employeeWhere.departmentId = departmentId;
    }
    if (employeeId) {
        employeeWhere.id = employeeId;
    }
    const allEmployees = await prisma_1.prisma.employee.findMany({
        where: employeeWhere,
        include: { shift: true, department: true }
    });
    // Get approved leaves in the period
    const leaves = await prisma_1.prisma.leaveRequest.findMany({
        where: {
            status: 'approved',
            startDate: { lte: end },
            endDate: { gte: start },
            ...(departmentId && { Employee: { departmentId: departmentId } }),
            ...(employeeId && { employeeId: employeeId })
        }
    });
    // Group data based on groupBy parameter
    const report = {
        period: { start: startDate, end: endDate },
        summary: {
            totalEmployees: allEmployees.length,
            totalEntries: entries.length,
            totalHours: 0,
            totalRegularHours: 0,
            totalOvertimeHours: 0,
            averageHoursPerDay: 0,
            attendanceRate: 0
        },
        data: []
    };
    if (groupBy === 'employee') {
        // Group by employee
        const employeeData = new Map();
        for (const emp of allEmployees) {
            employeeData.set(emp.id, {
                Employee: {
                    id: emp.id,
                    employeeId: emp.employeeId,
                    name: `${emp.firstName} ${emp.lastName}`,
                    department: emp.department?.name
                },
                daysWorked: 0,
                totalHours: 0,
                regularHours: 0,
                overtimeHours: 0,
                lateDays: 0,
                absentDays: 0,
                leaveDays: 0
            });
        }
        for (const entry of entries) {
            const empData = employeeData.get(entry.employeeId);
            if (empData) {
                empData.daysWorked++;
                empData.totalHours += entry.totalHours || 0;
                empData.regularHours += entry.regularHours || 0;
                empData.overtimeHours += entry.overtimeHours || 0;
                // Check if late
                const emp = allEmployees.find(e => e.id === entry.employeeId);
                if (emp?.shift) {
                    const [h, m] = emp.shift.startTime.split(':').map(Number);
                    const shiftStart = new Date(entry.clockIn);
                    shiftStart.setHours(h, m + (emp.shift.graceMinutes || 15), 0, 0);
                    if (new Date(entry.clockIn) > shiftStart) {
                        empData.lateDays++;
                    }
                }
            }
        }
        // Calculate absent days and leave days
        const daysInPeriod = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        for (const [empId, data] of employeeData) {
            const emp = allEmployees.find(e => e.id === empId);
            const workingDays = emp?.shift
                ? JSON.parse(emp.shift.workingDays)
                : [1, 2, 3, 4, 5];
            let expectedDays = 0;
            const current = new Date(start);
            while (current <= end) {
                if (workingDays.includes(current.getDay())) {
                    expectedDays++;
                }
                current.setDate(current.getDate() + 1);
            }
            // Count leave days
            const empLeaves = leaves.filter(l => l.employeeId === empId);
            data.leaveDays = empLeaves.reduce((sum, l) => sum + l.totalDays, 0);
            data.absentDays = Math.max(0, expectedDays - data.daysWorked - data.leaveDays);
        }
        report.data = Array.from(employeeData.values());
    }
    else if (groupBy === 'department') {
        // Group by department
        const deptData = new Map();
        for (const emp of allEmployees) {
            const deptId = emp.department?.id || 'unassigned';
            if (!deptData.has(deptId)) {
                deptData.set(deptId, {
                    department: {
                        id: deptId,
                        name: emp.department?.name || 'Unassigned'
                    },
                    employeeCount: 0,
                    totalHours: 0,
                    regularHours: 0,
                    overtimeHours: 0,
                    averageHours: 0,
                    attendanceRate: 0
                });
            }
            deptData.get(deptId).employeeCount++;
        }
        for (const entry of entries) {
            const emp = allEmployees.find(e => e.id === entry.employeeId);
            const deptId = emp?.department?.id || 'unassigned';
            const data = deptData.get(deptId);
            if (data) {
                data.totalHours += entry.totalHours || 0;
                data.regularHours += entry.regularHours || 0;
                data.overtimeHours += entry.overtimeHours || 0;
            }
        }
        for (const [, data] of deptData) {
            data.averageHours = data.EmployeeCount > 0
                ? Math.round((data.totalHours / data.EmployeeCount) * 100) / 100
                : 0;
        }
        report.data = Array.from(deptData.values());
    }
    else {
        // Group by day (default)
        const dailyData = new Map();
        const current = new Date(start);
        while (current <= end) {
            const dateStr = current.toISOString().split('T')[0];
            dailyData.set(dateStr, {
                date: dateStr,
                dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][current.getDay()],
                present: 0,
                absent: 0,
                onLeave: 0,
                late: 0,
                totalHours: 0,
                overtimeHours: 0
            });
            current.setDate(current.getDate() + 1);
        }
        for (const entry of entries) {
            const dateStr = new Date(entry.clockIn).toISOString().split('T')[0];
            const data = dailyData.get(dateStr);
            if (data) {
                data.present++;
                data.totalHours += entry.totalHours || 0;
                data.overtimeHours += entry.overtimeHours || 0;
                // Check if late
                const emp = allEmployees.find(e => e.id === entry.employeeId);
                if (emp?.shift) {
                    const entryDate = new Date(entry.clockIn);
                    const [h, m] = emp.shift.startTime.split(':').map(Number);
                    const shiftStart = new Date(entryDate);
                    shiftStart.setHours(h, m + (emp.shift.graceMinutes || 15), 0, 0);
                    if (entryDate > shiftStart) {
                        data.late++;
                    }
                }
            }
        }
        // Calculate absent for each day
        for (const [dateStr, data] of dailyData) {
            const date = new Date(dateStr);
            const dayOfWeek = date.getDay();
            // Count employees who should work this day
            let expectedEmployees = 0;
            for (const emp of allEmployees) {
                const workingDays = emp.shift
                    ? JSON.parse(emp.shift.workingDays)
                    : [1, 2, 3, 4, 5];
                if (workingDays.includes(dayOfWeek)) {
                    expectedEmployees++;
                }
            }
            // Count employees on leave
            const onLeave = leaves.filter(l => {
                const leaveStart = new Date(l.startDate);
                const leaveEnd = new Date(l.endDate);
                return date >= leaveStart && date <= leaveEnd;
            }).length;
            data.onLeave = onLeave;
            data.absent = Math.max(0, expectedEmployees - data.present - onLeave);
        }
        report.data = Array.from(dailyData.values());
    }
    // Calculate summary
    report.summary.totalHours = Math.round(entries.reduce((sum, e) => sum + (e.totalHours || 0), 0) * 100) / 100;
    report.summary.totalRegularHours = Math.round(entries.reduce((sum, e) => sum + (e.regularHours || 0), 0) * 100) / 100;
    report.summary.totalOvertimeHours = Math.round(entries.reduce((sum, e) => sum + (e.overtimeHours || 0), 0) * 100) / 100;
    const daysInPeriod = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    report.summary.averageHoursPerDay = daysInPeriod > 0
        ? Math.round((report.summary.totalHours / daysInPeriod) * 100) / 100
        : 0;
    res.json(report);
}));
// Get overtime report
router.get('/overtime', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, departmentId, threshold = '8' } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const where = {
        clockIn: { gte: start, lte: end },
        overtimeHours: { gt: 0 }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    hourlyRate: true,
                    department: { select: { name: true } }
                }
            }
        },
        orderBy: { clockIn: 'desc' }
    });
    // Group by employee
    const employeeOvertime = new Map();
    for (const entry of entries) {
        const empId = entry.employeeId;
        if (!employeeOvertime.has(empId)) {
            employeeOvertime.set(empId, {
                Employee: entry.Employee,
                totalOvertimeHours: 0,
                overtimeDays: 0,
                estimatedCost: 0,
                entries: []
            });
        }
        const data = employeeOvertime.get(empId);
        data.totalOvertimeHours += entry.overtimeHours || 0;
        data.overtimeDays++;
        // Calculate overtime cost (1.5x hourly rate)
        const hourlyRate = entry.Employee.hourlyRate || 0;
        data.estimatedCost += (entry.overtimeHours || 0) * hourlyRate * 1.5;
        data.entries.push({
            date: entry.clockIn,
            regularHours: entry.regularHours,
            overtimeHours: entry.overtimeHours,
            totalHours: entry.totalHours
        });
    }
    const overtimeData = Array.from(employeeOvertime.values())
        .sort((a, b) => b.totalOvertimeHours - a.totalOvertimeHours);
    const summary = {
        totalOvertimeHours: Math.round(overtimeData.reduce((sum, d) => sum + d.totalOvertimeHours, 0) * 100) / 100,
        totalEstimatedCost: Math.round(overtimeData.reduce((sum, d) => sum + d.estimatedCost, 0) * 100) / 100,
        employeesWithOvertime: overtimeData.length,
        averageOvertimePerEmployee: overtimeData.length > 0
            ? Math.round((overtimeData.reduce((sum, d) => sum + d.totalOvertimeHours, 0) / overtimeData.length) * 100) / 100
            : 0
    };
    // Daily overtime trend
    const dailyOvertime = new Map();
    for (const entry of entries) {
        const dateStr = new Date(entry.clockIn).toISOString().split('T')[0];
        if (!dailyOvertime.has(dateStr)) {
            dailyOvertime.set(dateStr, { date: dateStr, hours: 0, employees: 0 });
        }
        const data = dailyOvertime.get(dateStr);
        data.hours += entry.overtimeHours || 0;
        data.Employees++;
    }
    res.json({
        period: { start: startDate, end: endDate },
        summary,
        byEmployee: overtimeData,
        dailyTrend: Array.from(dailyOvertime.values()).sort((a, b) => a.date.localeCompare(b.date))
    });
}));
// Get lateness analysis
router.get('/lateness', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, departmentId } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const where = {
        clockIn: { gte: start, lte: end }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    department: { select: { name: true } },
                    shift: true
                }
            }
        }
    });
    const lateEntries = [];
    const employeeLateData = new Map();
    const dailyLateData = new Map();
    for (const entry of entries) {
        const emp = entry.Employee;
        if (!emp?.shift)
            continue;
        const [h, m] = emp.shift.startTime.split(':').map(Number);
        const entryDate = new Date(entry.clockIn);
        const shiftStart = new Date(entryDate);
        shiftStart.setHours(h, m, 0, 0);
        const graceEnd = new Date(shiftStart);
        graceEnd.setMinutes(graceEnd.getMinutes() + (emp.shift.graceMinutes || 15));
        if (entryDate > graceEnd) {
            const minutesLate = Math.round((entryDate.getTime() - shiftStart.getTime()) / (1000 * 60));
            lateEntries.push({
                Employee: {
                    id: emp.id,
                    employeeId: emp.employeeId,
                    name: `${emp.firstName} ${emp.lastName}`,
                    department: emp.department?.name
                },
                date: entry.clockIn,
                shiftStart: emp.shift.startTime,
                actualClockIn: entryDate.toTimeString().slice(0, 5),
                minutesLate
            });
            // Aggregate by employee
            if (!employeeLateData.has(emp.id)) {
                employeeLateData.set(emp.id, {
                    Employee: {
                        id: emp.id,
                        employeeId: emp.employeeId,
                        name: `${emp.firstName} ${emp.lastName}`,
                        department: emp.department?.name
                    },
                    totalLateDays: 0,
                    totalMinutesLate: 0,
                    averageMinutesLate: 0
                });
            }
            const empData = employeeLateData.get(emp.id);
            empData.totalLateDays++;
            empData.totalMinutesLate += minutesLate;
            empData.averageMinutesLate = Math.round(empData.totalMinutesLate / empData.totalLateDays);
            // Aggregate by day
            const dateStr = entryDate.toISOString().split('T')[0];
            if (!dailyLateData.has(dateStr)) {
                dailyLateData.set(dateStr, { date: dateStr, count: 0, totalMinutes: 0 });
            }
            const dayData = dailyLateData.get(dateStr);
            dayData.count++;
            dayData.totalMinutes += minutesLate;
        }
    }
    // Sort employees by total late days
    const byEmployee = Array.from(employeeLateData.values())
        .sort((a, b) => b.totalLateDays - a.totalLateDays);
    // Calculate summary
    const totalLateInstances = lateEntries.length;
    const totalMinutesLate = lateEntries.reduce((sum, e) => sum + e.minutesLate, 0);
    res.json({
        period: { start: startDate, end: endDate },
        summary: {
            totalLateInstances,
            totalMinutesLate,
            averageMinutesLate: totalLateInstances > 0
                ? Math.round(totalMinutesLate / totalLateInstances)
                : 0,
            employeesWithLateArrivals: byEmployee.length,
            latenessRate: entries.length > 0
                ? Math.round((totalLateInstances / entries.length) * 100)
                : 0
        },
        byEmployee,
        dailyTrend: Array.from(dailyLateData.values()).sort((a, b) => a.date.localeCompare(b.date)),
        recentLateArrivals: lateEntries.slice(0, 50)
    });
}));
// Get payroll summary (for future version - basic structure)
router.get('/payroll', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, departmentId } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const where = {
        clockIn: { gte: start, lte: end },
        status: { in: ['clocked_out', 'approved'] }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    salary: true,
                    hourlyRate: true,
                    employmentType: true,
                    department: { select: { name: true } }
                }
            }
        }
    });
    // Group by employee
    const employeePayroll = new Map();
    for (const entry of entries) {
        const emp = entry.Employee;
        if (!employeePayroll.has(emp.id)) {
            employeePayroll.set(emp.id, {
                Employee: {
                    id: emp.id,
                    employeeId: emp.employeeId,
                    name: `${emp.firstName} ${emp.lastName}`,
                    department: emp.department?.name,
                    employmentType: emp.employmentType
                },
                regularHours: 0,
                overtimeHours: 0,
                totalHours: 0,
                hourlyRate: emp.hourlyRate || 0,
                regularPay: 0,
                overtimePay: 0,
                grossPay: 0
            });
        }
        const data = employeePayroll.get(emp.id);
        data.regularHours += entry.regularHours || 0;
        data.overtimeHours += entry.overtimeHours || 0;
        data.totalHours += entry.totalHours || 0;
    }
    // Calculate pay
    for (const [, data] of employeePayroll) {
        data.regularPay = Math.round(data.regularHours * data.hourlyRate * 100) / 100;
        data.overtimePay = Math.round(data.overtimeHours * data.hourlyRate * 1.5 * 100) / 100;
        data.grossPay = Math.round((data.regularPay + data.overtimePay) * 100) / 100;
    }
    const payrollData = Array.from(employeePayroll.values())
        .sort((a, b) => b.grossPay - a.grossPay);
    const summary = {
        totalRegularHours: Math.round(payrollData.reduce((sum, d) => sum + d.regularHours, 0) * 100) / 100,
        totalOvertimeHours: Math.round(payrollData.reduce((sum, d) => sum + d.overtimeHours, 0) * 100) / 100,
        totalRegularPay: Math.round(payrollData.reduce((sum, d) => sum + d.regularPay, 0) * 100) / 100,
        totalOvertimePay: Math.round(payrollData.reduce((sum, d) => sum + d.overtimePay, 0) * 100) / 100,
        totalGrossPay: Math.round(payrollData.reduce((sum, d) => sum + d.grossPay, 0) * 100) / 100,
        employeeCount: payrollData.length
    };
    res.json({
        period: { start: startDate, end: endDate },
        summary,
        employees: payrollData,
        note: 'This is a basic payroll summary. Full payroll features coming in future version.'
    });
}));
// Export report data
router.get('/export/:type', (0, auth_1.requirePermission)('reports:export'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { type } = req.params;
    const { startDate, endDate, departmentId, format = 'csv' } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    let data = [];
    let headers = [];
    switch (type) {
        case 'attendance':
            const entries = await prisma_1.prisma.timeEntry.findMany({
                where: {
                    clockIn: { gte: start, lte: end },
                    ...(departmentId && { Employee: { departmentId: departmentId } })
                },
                include: {
                    Employee: {
                        select: {
                            employeeId: true,
                            firstName: true,
                            lastName: true,
                            department: { select: { name: true } }
                        }
                    }
                },
                orderBy: { clockIn: 'asc' }
            });
            headers = ['Employee ID', 'Name', 'Department', 'Date', 'Clock In', 'Clock Out', 'Total Hours', 'Regular Hours', 'Overtime', 'Status'];
            data = entries.map(e => ({
                'Employee ID': e.Employee.employeeId,
                'Name': `${e.Employee.firstName} ${e.Employee.lastName}`,
                'Department': e.Employee.department?.name || 'N/A',
                'Date': new Date(e.clockIn).toLocaleDateString(),
                'Clock In': new Date(e.clockIn).toLocaleTimeString(),
                'Clock Out': e.clockOut ? new Date(e.clockOut).toLocaleTimeString() : 'N/A',
                'Total Hours': e.totalHours?.toFixed(2) || '0.00',
                'Regular Hours': e.regularHours?.toFixed(2) || '0.00',
                'Overtime': e.overtimeHours?.toFixed(2) || '0.00',
                'Status': e.status
            }));
            break;
        case 'overtime':
            const overtimeEntries = await prisma_1.prisma.timeEntry.findMany({
                where: {
                    clockIn: { gte: start, lte: end },
                    overtimeHours: { gt: 0 },
                    ...(departmentId && { Employee: { departmentId: departmentId } })
                },
                include: {
                    Employee: {
                        select: {
                            employeeId: true,
                            firstName: true,
                            lastName: true,
                            department: { select: { name: true } }
                        }
                    }
                },
                orderBy: { clockIn: 'asc' }
            });
            headers = ['Employee ID', 'Name', 'Department', 'Date', 'Regular Hours', 'Overtime Hours', 'Total Hours'];
            data = overtimeEntries.map(e => ({
                'Employee ID': e.Employee.employeeId,
                'Name': `${e.Employee.firstName} ${e.Employee.lastName}`,
                'Department': e.Employee.department?.name || 'N/A',
                'Date': new Date(e.clockIn).toLocaleDateString(),
                'Regular Hours': e.regularHours?.toFixed(2) || '0.00',
                'Overtime Hours': e.overtimeHours?.toFixed(2) || '0.00',
                'Total Hours': e.totalHours?.toFixed(2) || '0.00'
            }));
            break;
        default:
            throw new errorHandler_1.AppError('Invalid report type', 400);
    }
    if (format === 'csv') {
        const csv = [
            headers.join(','),
            ...data.map(row => headers.map(h => `"${row[h]}"`).join(','))
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${type}-report-${startDate}-${endDate}.csv"`);
        return res.send(csv);
    }
    res.json({ headers, data });
}));
// Get dashboard analytics
router.get('/dashboard', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const [totalEmployees, presentToday, onLeaveToday, pendingLeaves, thisMonthHours, lastMonthHours, thisMonthOvertime, recentActivity] = await Promise.all([
        prisma_1.prisma.employee.count({ where: { status: 'active' } }),
        prisma_1.prisma.timeEntry.count({
            where: { clockIn: { gte: today } }
        }),
        prisma_1.prisma.leaveRequest.count({
            where: {
                status: 'approved',
                startDate: { lte: today },
                endDate: { gte: today }
            }
        }),
        prisma_1.prisma.leaveRequest.count({
            where: { status: 'pending' }
        }),
        prisma_1.prisma.timeEntry.aggregate({
            where: { clockIn: { gte: thisMonthStart } },
            _sum: { totalHours: true }
        }),
        prisma_1.prisma.timeEntry.aggregate({
            where: {
                clockIn: { gte: lastMonthStart, lte: lastMonthEnd }
            },
            _sum: { totalHours: true }
        }),
        prisma_1.prisma.timeEntry.aggregate({
            where: { clockIn: { gte: thisMonthStart } },
            _sum: { overtimeHours: true }
        }),
        prisma_1.prisma.timeEntry.findMany({
            take: 10,
            orderBy: { updatedAt: 'desc' },
            include: {
                Employee: {
                    select: {
                        firstName: true,
                        lastName: true,
                        photo: true
                    }
                }
            }
        })
    ]);
    const hoursChange = lastMonthHours._sum.totalHours && thisMonthHours._sum.totalHours
        ? Math.round(((thisMonthHours._sum.totalHours - lastMonthHours._sum.totalHours) / lastMonthHours._sum.totalHours) * 100)
        : 0;
    res.json({
        overview: {
            totalEmployees,
            presentToday,
            absentToday: Math.max(0, totalEmployees - presentToday - onLeaveToday),
            onLeaveToday,
            attendanceRate: totalEmployees > 0
                ? Math.round((presentToday / totalEmployees) * 100)
                : 0
        },
        workHours: {
            thisMonth: Math.round((thisMonthHours._sum.totalHours || 0) * 100) / 100,
            lastMonth: Math.round((lastMonthHours._sum.totalHours || 0) * 100) / 100,
            change: hoursChange,
            overtime: Math.round((thisMonthOvertime._sum.overtimeHours || 0) * 100) / 100
        },
        pendingActions: {
            leaveRequests: pendingLeaves
        },
        recentActivity: recentActivity.map(a => ({
            type: a.clockOut ? 'clock_out' : 'clock_in',
            Employee: `${a.Employee.firstName} ${a.Employee.lastName}`,
            photo: a.Employee.photo,
            timestamp: a.clockOut || a.clockIn
        }))
    });
}));
// ============================================
// ALIAS ENDPOINTS - For API compatibility
// ============================================
// Alias: /attendance-summary -> /attendance
router.get('/attendance-summary', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, departmentId, employeeId, groupBy = 'day' } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const where = {
        clockIn: { gte: start, lte: end }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    if (employeeId) {
        where.employeeId = employeeId;
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    department: { select: { id: true, name: true } },
                    shift: true
                }
            }
        },
        orderBy: { clockIn: 'asc' }
    });
    const allEmployees = await prisma_1.prisma.employee.findMany({
        where: { status: 'active', ...(departmentId && { departmentId: departmentId }), ...(employeeId && { id: employeeId }) },
        include: { shift: true, department: true }
    });
    const leaves = await prisma_1.prisma.leaveRequest.findMany({
        where: {
            status: 'approved',
            startDate: { lte: end },
            endDate: { gte: start },
            ...(departmentId && { Employee: { departmentId: departmentId } }),
            ...(employeeId && { employeeId: employeeId })
        }
    });
    // Group data by day
    const dayMap = new Map();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        dayMap.set(dateStr, { present: 0, absent: 0, onLeave: 0, late: 0 });
    }
    entries.forEach(entry => {
        const dateStr = entry.clockIn.toISOString().split('T')[0];
        const day = dayMap.get(dateStr) || { present: 0, absent: 0, onLeave: 0, late: 0 };
        day.present++;
        dayMap.set(dateStr, day);
    });
    const summary = {
        totalEmployees: allEmployees.length,
        totalEntries: entries.length,
        totalHours: entries.reduce((sum, e) => sum + (e.totalHours || 0), 0),
        totalRegularHours: entries.reduce((sum, e) => sum + (e.regularHours || 0), 0),
        totalOvertimeHours: entries.reduce((sum, e) => sum + (e.overtimeHours || 0), 0),
        averageHoursPerDay: entries.length > 0 ? entries.reduce((sum, e) => sum + (e.totalHours || 0), 0) / entries.length : 0,
        attendanceRate: allEmployees.length > 0 ? Math.round((entries.length / (allEmployees.length * Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))) * 100) : 0
    };
    const data = Array.from(dayMap.entries()).map(([date, counts]) => ({
        date,
        ...counts
    }));
    res.json({ summary, data });
}));
// Alias: /employee/:id -> employee report
router.get('/employee/:employeeId', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { shift: true, department: true }
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    const where = { employeeId };
    if (startDate || endDate) {
        where.clockIn = {};
        if (startDate) {
            where.clockIn.gte = new Date(startDate);
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            where.clockIn.lte = end;
        }
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        orderBy: { clockIn: 'asc' }
    });
    res.json({
        employee: {
            id: employee.id,
            employeeId: employee.employeeId,
            name: `${employee.firstName} ${employee.lastName}`,
            department: employee.department?.name,
            shift: employee.shift?.name
        },
        entries,
        summary: {
            totalEntries: entries.length,
            totalHours: entries.reduce((sum, e) => sum + (e.totalHours || 0), 0),
            regularHours: entries.reduce((sum, e) => sum + (e.regularHours || 0), 0),
            overtimeHours: entries.reduce((sum, e) => sum + (e.overtimeHours || 0), 0)
        }
    });
}));
// Alias: /department/:id -> department report
router.get('/department/:departmentId', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { departmentId } = req.params;
    const { startDate, endDate } = req.query;
    const department = await prisma_1.prisma.department.findUnique({
        where: { id: departmentId },
        include: { employees: { where: { status: 'active' } } }
    });
    if (!department) {
        throw new errorHandler_1.AppError('Department not found', 404);
    }
    const where = { Employee: { departmentId } };
    if (startDate || endDate) {
        where.clockIn = {};
        if (startDate) {
            where.clockIn.gte = new Date(startDate);
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            where.clockIn.lte = end;
        }
    }
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where,
        include: { Employee: { select: { id: true, firstName: true, lastName: true } } }
    });
    res.json({
        department: { id: department.id, name: department.name },
        employeeCount: department.employees.length,
        entries,
        summary: {
            totalEntries: entries.length,
            totalHours: entries.reduce((sum, e) => sum + (e.totalHours || 0), 0),
            regularHours: entries.reduce((sum, e) => sum + (e.regularHours || 0), 0),
            overtimeHours: entries.reduce((sum, e) => sum + (e.overtimeHours || 0), 0)
        }
    });
}));
// Alias: /monthly -> use existing endpoints or create summary
router.get('/monthly', (0, auth_1.requirePermission)('reports:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { startDate, endDate, type = 'overtime' } = req.query;
    if (!startDate || !endDate) {
        throw new errorHandler_1.AppError('Start date and end date are required', 400);
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const entries = await prisma_1.prisma.timeEntry.findMany({
        where: { clockIn: { gte: start, lte: end } },
        include: { Employee: { select: { id: true, firstName: true, lastName: true, department: true } } }
    });
    if (type === 'overtime') {
        const data = entries
            .filter(e => (e.overtimeHours || 0) > 0)
            .map(e => ({
            employee: `${e.Employee.firstName} ${e.Employee.lastName}`,
            department: e.Employee.department?.name,
            overtime: e.overtimeHours || 0,
            regular: e.regularHours || 0,
            date: e.clockIn
        }))
            .sort((a, b) => (b.overtime || 0) - (a.overtime || 0));
        res.json(data);
    }
    else if (type === 'lateness') {
        // Assuming lateness is when clock-in is after expected time
        const data = entries.map(e => ({
            employee: `${e.Employee.firstName} ${e.Employee.lastName}`,
            date: e.clockIn,
            time: e.clockIn
        }));
        res.json(data);
    }
    else if (type === 'payroll') {
        const summary = {};
        entries.forEach(e => {
            if (!summary[e.employeeId]) {
                summary[e.employeeId] = {
                    employee: `${e.Employee.firstName} ${e.Employee.lastName}`,
                    totalHours: 0,
                    regularHours: 0,
                    overtimeHours: 0
                };
            }
            summary[e.employeeId].totalHours += e.totalHours || 0;
            summary[e.employeeId].regularHours += e.regularHours || 0;
            summary[e.employeeId].overtimeHours += e.overtimeHours || 0;
        });
        res.json(Object.values(summary));
    }
    else {
        res.json(entries);
    }
}));
exports.default = router;
//# sourceMappingURL=reports.js.map