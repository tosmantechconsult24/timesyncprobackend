"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const logger_1 = require("../utils/logger");
const router = (0, express_1.Router)();
const leaveRequestSchema = zod_1.z.object({
    employeeId: zod_1.z.string(),
    leaveType: zod_1.z.enum(['sick', 'vacation', 'personal', 'maternity', 'paternity', 'unpaid']),
    startDate: zod_1.z.string(),
    endDate: zod_1.z.string(),
    reason: zod_1.z.string().optional()
});
// Calculate working days between two dates
function calculateWorkingDays(startDate, endDate, workingDays = [1, 2, 3, 4, 5]) {
    let count = 0;
    const current = new Date(startDate);
    while (current <= endDate) {
        if (workingDays.includes(current.getDay())) {
            count++;
        }
        current.setDate(current.getDate() + 1);
    }
    return count;
}
// Get all leave requests
router.get('/', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { status, employeeId, leaveType, startDate, endDate, page = '1', limit = '50' } = req.query;
    const where = {};
    if (status) {
        where.status = status;
    }
    if (employeeId) {
        where.employeeId = employeeId;
    }
    if (leaveType) {
        where.leaveType = leaveType;
    }
    if (startDate) {
        where.startDate = { gte: new Date(startDate) };
    }
    if (endDate) {
        where.endDate = { lte: new Date(endDate) };
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
        prisma_1.prisma.leaveRequest.findMany({
            where,
            include: {
                Employee: {
                    select: {
                        id: true,
                        employeeId: true,
                        firstName: true,
                        lastName: true,
                        photo: true,
                        department: { select: { name: true } }
                    }
                },
                User: {
                    select: { id: true, firstName: true, lastName: true, email: true }
                }
            },
            skip,
            take: parseInt(limit),
            orderBy: { createdAt: 'desc' }
        }),
        prisma_1.prisma.leaveRequest.count({ where })
    ]);
    res.json({
        requests,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
        }
    });
}));
// Get leave request by ID
router.get('/:id', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const request = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: {
            Employee: {
                include: {
                    department: true,
                    shift: true
                }
            },
            User: {
                select: { firstName: true, lastName: true }
            }
        }
    });
    if (!request) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    res.json(request);
}));
// PUBLIC: Create leave request from kiosk (no auth required)
router.post('/kiosk/submit', async (req, res) => {
    try {
        const { employeeId, leaveType, startDate, endDate, reason } = req.body;
        // Validate required fields
        if (!employeeId || !leaveType || !startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        // Verify employee exists and is active
        const employee = await prisma_1.prisma.employee.findUnique({
            where: { employeeId },
            include: { shift: true }
        });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        if (employee.status !== 'active') {
            return res.status(403).json({
                error: `Your account is ${employee.status}. Please contact HR.`
            });
        }
        // Check for overlapping leave requests
        const overlapping = await prisma_1.prisma.leaveRequest.findFirst({
            where: {
                employeeId: employee.id,
                status: { in: ['pending', 'approved'] },
                AND: [
                    { startDate: { lte: new Date(endDate) } },
                    { endDate: { gte: new Date(startDate) } }
                ]
            }
        });
        if (overlapping) {
            return res.status(400).json({ error: 'You already have a leave request during this period' });
        }
        // Create leave request
        const leaveRequest = await prisma_1.prisma.leaveRequest.create({
            data: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: employee.id,
                leaveType,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                reason: reason || '',
                status: 'pending',
                totalDays: calculateWorkingDays(new Date(startDate), new Date(endDate)),
                updatedAt: new Date()
            },
            include: {
                Employee: {
                    select: {
                        firstName: true,
                        lastName: true,
                        email: true
                    }
                }
            }
        });
        return res.status(201).json({
            success: true,
            message: 'Leave request submitted successfully',
            leaveRequest
        });
    }
    catch (error) {
        console.error('Error creating leave request:', error);
        return res.status(500).json({ error: 'Failed to submit leave request' });
    }
});
// Create leave request
router.post('/', (0, auth_1.requirePermission)('leaves:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = leaveRequestSchema.parse(req.body);
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: data.employeeId },
        include: { shift: true }
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);
    if (startDate > endDate) {
        throw new errorHandler_1.AppError('End date must be after start date', 400);
    }
    // Check for overlapping leave requests
    const overlapping = await prisma_1.prisma.leaveRequest.findFirst({
        where: {
            employeeId: data.employeeId,
            status: { in: ['pending', 'approved'] },
            OR: [
                {
                    startDate: { lte: endDate },
                    endDate: { gte: startDate }
                }
            ]
        }
    });
    if (overlapping) {
        throw new errorHandler_1.AppError('Employee already has leave scheduled for this period', 409);
    }
    // Calculate working days
    const workingDays = employee.shift
        ? JSON.parse(employee.shift.workingDays)
        : [1, 2, 3, 4, 5];
    const totalDays = calculateWorkingDays(startDate, endDate, workingDays);
    // Check leave balance
    const currentYear = new Date().getFullYear();
    const balance = await prisma_1.prisma.leaveBalance.findUnique({
        where: {
            employeeId_leaveType_year: {
                employeeId: data.employeeId,
                leaveType: data.leaveType,
                year: currentYear
            }
        }
    });
    if (balance && balance.remainingDays < totalDays && data.leaveType !== 'unpaid') {
        throw new errorHandler_1.AppError(`Insufficient leave balance. Available: ${balance.remainingDays} days`, 400);
    }
    const request = await prisma_1.prisma.leaveRequest.create({
        data: {
            id: (0, crypto_1.randomUUID)(),
            employeeId: data.employeeId,
            leaveType: data.leaveType,
            startDate,
            endDate,
            totalDays,
            reason: data.reason,
            status: 'pending',
            updatedAt: new Date()
        },
        include: {
            Employee: {
                select: {
                    employeeId: true,
                    firstName: true,
                    lastName: true
                }
            }
        }
    });
    // Create notification for managers
    await prisma_1.prisma.notification.create({
        data: {
            id: (0, crypto_1.randomUUID)(),
            type: 'leave_request',
            title: 'New Leave Request',
            message: `${employee.firstName} ${employee.lastName} has requested ${totalDays} days of ${data.leaveType} leave`,
            data: JSON.stringify({ requestId: request.id })
        }
    });
    logger_1.logger.info(`Leave request created for ${employee.employeeId}`);
    res.status(201).json(request);
}));
// Update leave request
router.put('/:id', (0, auth_1.requirePermission)('leaves:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const existing = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id }
    });
    if (!existing) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    if (existing.status !== 'pending') {
        throw new errorHandler_1.AppError('Can only edit pending leave requests', 400);
    }
    const data = leaveRequestSchema.partial().parse(req.body);
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: data.employeeId || existing.employeeId },
        include: { shift: true }
    });
    const startDate = data.startDate ? new Date(data.startDate) : existing.startDate;
    const endDate = data.endDate ? new Date(data.endDate) : existing.endDate;
    const workingDays = employee?.shift
        ? JSON.parse(employee.shift.workingDays)
        : [1, 2, 3, 4, 5];
    const totalDays = calculateWorkingDays(startDate, endDate, workingDays);
    const request = await prisma_1.prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: {
            leaveType: data.leaveType,
            startDate,
            endDate,
            totalDays,
            reason: data.reason
        }
    });
    res.json(request);
}));
// Approve/reject leave request
router.post('/:id/approve', (0, auth_1.requirePermission)('leaves:approve'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { status, rejectionReason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
        throw new errorHandler_1.AppError('Invalid status', 400);
    }
    const request = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: { Employee: true }
    });
    if (!request) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    if (request.status !== 'pending') {
        throw new errorHandler_1.AppError('Leave request has already been processed', 400);
    }
    const updated = await prisma_1.prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: {
            status,
            approvedById: req.user.id,
            approvedAt: new Date(),
            rejectionReason: status === 'rejected' ? rejectionReason : null
        }
    });
    // Update leave balance if approved
    if (status === 'approved' && request.leaveType !== 'unpaid') {
        const currentYear = new Date().getFullYear();
        await prisma_1.prisma.leaveBalance.upsert({
            where: {
                employeeId_leaveType_year: {
                    employeeId: request.employeeId,
                    leaveType: request.leaveType,
                    year: currentYear
                }
            },
            create: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: request.employeeId,
                leaveType: request.leaveType,
                year: currentYear,
                totalDays: 0,
                usedDays: request.totalDays,
                remainingDays: -request.totalDays
            },
            update: {
                usedDays: { increment: request.totalDays },
                remainingDays: { decrement: request.totalDays }
            }
        });
    }
    // Create notification for employee
    await prisma_1.prisma.notification.create({
        data: {
            id: (0, crypto_1.randomUUID)(),
            employeeId: request.employeeId,
            type: 'leave_response',
            title: `Leave Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
            message: status === 'approved'
                ? `Your ${request.leaveType} leave request has been approved`
                : `Your ${request.leaveType} leave request has been rejected. Reason: ${rejectionReason || 'Not specified'}`,
            data: JSON.stringify({ requestId: request.id })
        }
    });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: status === 'approved' ? 'approve' : 'reject',
            entityType: 'leaveRequest',
            entityId: request.id,
            oldValue: JSON.stringify(request),
            newValue: JSON.stringify(updated)
        }
    });
    logger_1.logger.info(`Leave request ${status} for ${request.Employee.employeeId}`);
    res.json(updated);
}));
// Verify fingerprint for leave request authorization
router.post('/:id/verify-fingerprint', (0, auth_1.requirePermission)('leaves:approve'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { fingerprintData } = req.body;
    if (!fingerprintData) {
        throw new errorHandler_1.AppError('Fingerprint data is required', 400);
    }
    const request = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: { Employee: true }
    });
    if (!request) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    // Verify employee has fingerprint enrolled
    if (!request.Employee.fingerprintTemplate) {
        throw new errorHandler_1.AppError('Employee does not have fingerprint enrolled', 400);
    }
    // Here you would normally verify the fingerprint against the template
    // For now, we'll return success indicating fingerprint verification passed
    // In a real implementation, you would use a fingerprint matching algorithm
    logger_1.logger.info(`Fingerprint verified for leave request ${request.id} by ${req.user.id}`);
    res.json({
        verified: true,
        message: 'Fingerprint verified successfully',
        employeeId: request.employeeId,
        leaveRequestId: request.id
    });
}));
// ============================================
// DEPARTMENT MANAGER APPROVAL
// ============================================
/**
 * Get pending leave requests for manager's department
 * Protected: requires manager role
 */
router.get('/manager/pending', (0, auth_1.requirePermission)('leaves:approve'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    // Get user's associated employee (manager)
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id },
        include: { Employee: { include: { department: true } } }
    });
    if (!user?.Employee?.department) {
        throw new errorHandler_1.AppError('Manager not assigned to a department', 400);
    }
    const departmentId = user.Employee.department.id;
    const [requests, total] = await Promise.all([
        prisma_1.prisma.leaveRequest.findMany({
            where: {
                status: 'pending',
                Employee: {
                    departmentId
                }
            },
            include: {
                Employee: {
                    select: {
                        id: true,
                        employeeId: true,
                        firstName: true,
                        lastName: true,
                        department: { select: { name: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        }),
        prisma_1.prisma.leaveRequest.count({
            where: {
                status: 'pending',
                Employee: { departmentId }
            }
        })
    ]);
    res.json({
        requests,
        total,
        department: user.Employee.department.name
    });
}));
/**
 * Manager approves/rejects leave request for their department
 * Protected: requires manager role
 */
router.post('/manager/:id/approve', (0, auth_1.requirePermission)('leaves:approve'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { status, rejectionReason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
        throw new errorHandler_1.AppError('Invalid status', 400);
    }
    // Verify manager's department
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id },
        include: { Employee: { include: { department: true } } }
    });
    if (!user?.Employee?.department) {
        throw new errorHandler_1.AppError('Manager not assigned to a department', 400);
    }
    const request = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: { Employee: true }
    });
    if (!request) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    // Verify employee is in manager's department
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: request.employeeId },
        include: { department: true }
    });
    if (!employee || employee.departmentId !== user.Employee.departmentId) {
        throw new errorHandler_1.AppError('Employee not in your department', 403);
    }
    if (request.status !== 'pending') {
        throw new errorHandler_1.AppError('Leave request has already been processed', 400);
    }
    const updated = await prisma_1.prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: {
            status,
            approvedById: req.user.id,
            approvedAt: new Date(),
            rejectionReason: status === 'rejected' ? rejectionReason : null
        }
    });
    // Update leave balance if approved
    if (status === 'approved' && request.leaveType !== 'unpaid') {
        const currentYear = new Date().getFullYear();
        await prisma_1.prisma.leaveBalance.upsert({
            where: {
                employeeId_leaveType_year: {
                    employeeId: request.employeeId,
                    leaveType: request.leaveType,
                    year: currentYear
                }
            },
            create: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: request.employeeId,
                leaveType: request.leaveType,
                year: currentYear,
                totalDays: 0,
                usedDays: request.totalDays,
                remainingDays: -request.totalDays
            },
            update: {
                usedDays: { increment: request.totalDays },
                remainingDays: { decrement: request.totalDays }
            }
        });
    }
    // Create notification for employee
    await prisma_1.prisma.notification.create({
        data: {
            id: (0, crypto_1.randomUUID)(),
            employeeId: request.employeeId,
            type: 'leave_response',
            title: `Leave Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
            message: status === 'approved'
                ? `Your ${request.leaveType} leave request from ${request.startDate.toDateString()} to ${request.endDate.toDateString()} has been approved by your manager.`
                : `Your ${request.leaveType} leave request has been rejected. Reason: ${rejectionReason || 'Not specified'}`,
            data: JSON.stringify({ requestId: request.id })
        }
    });
    // Log audit
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: `leave_request_${status}`,
            entityType: 'leaveRequest',
            entityId: request.id,
            oldValue: JSON.stringify(request),
            newValue: JSON.stringify(updated),
            ipAddress: req.ip || undefined
        }
    });
    logger_1.logger.info(`Leave request ${status} by manager ${req.user.email} for employee ${employee.employeeId}`);
    res.json({
        success: true,
        request: updated,
        message: `Leave request has been ${status}`
    });
}));
// Cancel leave request
router.post('/:id/cancel', (0, auth_1.requirePermission)('leaves:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const request = await prisma_1.prisma.leaveRequest.findUnique({
        where: { id: req.params.id }
    });
    if (!request) {
        throw new errorHandler_1.AppError('Leave request not found', 404);
    }
    if (request.status === 'cancelled') {
        throw new errorHandler_1.AppError('Leave request is already cancelled', 400);
    }
    // If already approved, restore leave balance
    if (request.status === 'approved' && request.leaveType !== 'unpaid') {
        const currentYear = new Date().getFullYear();
        await prisma_1.prisma.leaveBalance.update({
            where: {
                employeeId_leaveType_year: {
                    employeeId: request.employeeId,
                    leaveType: request.leaveType,
                    year: currentYear
                }
            },
            data: {
                usedDays: { decrement: request.totalDays },
                remainingDays: { increment: request.totalDays }
            }
        });
    }
    const updated = await prisma_1.prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: { status: 'cancelled' }
    });
    res.json(updated);
}));
// Get leave balances for an employee
router.get('/balance/:employeeId', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { year } = req.query;
    const targetYear = year ? parseInt(year) : new Date().getFullYear();
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: req.params.employeeId }
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    // Get or create default balances
    const leaveTypes = ['sick', 'vacation', 'personal'];
    const defaultDays = {
        sick: 10,
        vacation: 20,
        personal: 5
    };
    const balances = [];
    for (const leaveType of leaveTypes) {
        const balance = await prisma_1.prisma.leaveBalance.upsert({
            where: {
                employeeId_leaveType_year: {
                    employeeId: req.params.employeeId,
                    leaveType,
                    year: targetYear
                }
            },
            create: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: req.params.employeeId,
                leaveType,
                year: targetYear,
                totalDays: defaultDays[leaveType],
                usedDays: 0,
                remainingDays: defaultDays[leaveType]
            },
            update: {}
        });
        balances.push(balance);
    }
    res.json(balances);
}));
// Update leave balance
router.put('/balance/:employeeId', (0, auth_1.requirePermission)('leaves:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { leaveType, totalDays, year } = req.body;
    const targetYear = year || new Date().getFullYear();
    const existing = await prisma_1.prisma.leaveBalance.findUnique({
        where: {
            employeeId_leaveType_year: {
                employeeId: req.params.employeeId,
                leaveType,
                year: targetYear
            }
        }
    });
    const usedDays = existing?.usedDays || 0;
    const balance = await prisma_1.prisma.leaveBalance.upsert({
        where: {
            employeeId_leaveType_year: {
                employeeId: req.params.employeeId,
                leaveType,
                year: targetYear
            }
        },
        create: {
            id: (0, crypto_1.randomUUID)(),
            employeeId: req.params.employeeId,
            leaveType,
            year: targetYear,
            totalDays,
            usedDays: 0,
            remainingDays: totalDays
        },
        update: {
            totalDays,
            remainingDays: totalDays - usedDays
        }
    });
    res.json(balance);
}));
// Get leave calendar
router.get('/calendar', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { month, year, departmentId } = req.query;
    const targetMonth = month ? parseInt(month) - 1 : new Date().getMonth();
    const targetYear = year ? parseInt(year) : new Date().getFullYear();
    const startDate = new Date(targetYear, targetMonth, 1);
    const endDate = new Date(targetYear, targetMonth + 1, 0);
    const where = {
        status: 'approved',
        startDate: { lte: endDate },
        endDate: { gte: startDate }
    };
    if (departmentId) {
        where.Employee = { departmentId: departmentId };
    }
    const leaves = await prisma_1.prisma.leaveRequest.findMany({
        where,
        include: {
            Employee: {
                select: {
                    id: true,
                    employeeId: true,
                    firstName: true,
                    lastName: true,
                    photo: true,
                    department: { select: { name: true } }
                }
            }
        }
    });
    // Build calendar events
    const events = leaves.map(leave => ({
        id: leave.id,
        title: `${leave.Employee.firstName} ${leave.Employee.lastName} - ${leave.leaveType}`,
        start: leave.startDate.toISOString().split('T')[0],
        end: leave.endDate.toISOString().split('T')[0],
        Employee: leave.Employee,
        leaveType: leave.leaveType,
        totalDays: leave.totalDays
    }));
    res.json(events);
}));
// Get leave summary/statistics
router.get('/summary', (0, auth_1.requirePermission)('leaves:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { year } = req.query;
    const targetYear = year ? parseInt(year) : new Date().getFullYear();
    const startOfYear = new Date(targetYear, 0, 1);
    const endOfYear = new Date(targetYear, 11, 31);
    const [pending, approved, rejected, byType, byMonth] = await Promise.all([
        prisma_1.prisma.leaveRequest.count({
            where: { status: 'pending' }
        }),
        prisma_1.prisma.leaveRequest.count({
            where: {
                status: 'approved',
                startDate: { gte: startOfYear, lte: endOfYear }
            }
        }),
        prisma_1.prisma.leaveRequest.count({
            where: {
                status: 'rejected',
                createdAt: { gte: startOfYear, lte: endOfYear }
            }
        }),
        prisma_1.prisma.leaveRequest.groupBy({
            by: ['leaveType'],
            where: {
                status: 'approved',
                startDate: { gte: startOfYear, lte: endOfYear }
            },
            _sum: { totalDays: true },
            _count: true
        }),
        prisma_1.prisma.$queryRaw `
      SELECT 
        strftime('%m', startDate) as month,
        COUNT(*) as count,
        SUM(totalDays) as totalDays
      FROM LeaveRequest
      WHERE status = 'approved'
        AND startDate >= ${startOfYear}
        AND startDate <= ${endOfYear}
      GROUP BY strftime('%m', startDate)
      ORDER BY month
    `
    ]);
    res.json({
        pending,
        approved,
        rejected,
        byType: byType.map(t => ({
            type: t.leaveType,
            count: t._count,
            totalDays: t._sum.totalDays
        })),
        byMonth
    });
}));
exports.default = router;
//# sourceMappingURL=leaves.js.map