import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';

const router = Router();

const departmentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  budget: z.number().optional().nullable(),
  isActive: z.boolean().optional(),
});

// Get all departments
router.get(
  '/',
  requirePermission('departments:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const departments = await prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            employees: true,
          },
        },
      },
    });

    // Manually count active employees per department
    const activeEmployeeCounts = await prisma.employee.groupBy({
      by: ['departmentId'],
      where: { status: 'active' },
      _count: { id: true },
    });

    const activeCountMap = new Map(
      activeEmployeeCounts
        .filter((g) => g.departmentId !== null)
        .map((g) => [g.departmentId, g._count.id])
    );

    // Get manager names
    const managerIds = departments.filter((d) => d.managerId).map((d) => d.managerId!);

    const managers = managerIds.length
      ? await prisma.employee.findMany({
          where: { id: { in: managerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];

    const managerMap = new Map(managers.map((m) => [m.id, `${m.firstName} ${m.lastName}`]));

    const result = departments.map((dept) => ({
      ...dept,
      employeeCount: activeCountMap.get(dept.id) ?? 0,
      managerName: dept.managerId ? managerMap.get(dept.managerId) ?? null : null,
    }));

    res.json(result);
  })
);

// Get department by ID
router.get(
  '/:id',
  requirePermission('departments:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const department = await prisma.department.findUnique({
      where: { id: req.params.id },
      include: {
        employees: {
          where: { status: 'active' },
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            designation: true,
            photo: true,
          },
        },
      },
    });

    if (!department) {
      throw new AppError('Department not found', 404);
    }

    res.json(department);
  })
);

// Create department
router.post(
  '/',
  requirePermission('departments:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = departmentSchema.parse(req.body);

    const existing = await prisma.department.findUnique({
      where: { name: data.name },
    });

    if (existing) {
      throw new AppError('Department with this name already exists', 409);
    }

    const department = await prisma.department.create({
      data: {
        ...data,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'create',
        entityType: 'department',
        entityId: department.id,
        newValue: JSON.stringify(department),
      },
    });

    res.status(201).json(department);
  })
);

// Update department
router.put(
  '/:id',
  requirePermission('departments:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const existing = await prisma.department.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('Department not found', 404);
    }

    const data = departmentSchema.partial().parse(req.body);

    // Check for duplicate name
    if (data.name && data.name !== existing.name) {
      const duplicate = await prisma.department.findUnique({
        where: { name: data.name },
      });
      if (duplicate) {
        throw new AppError('Department with this name already exists', 409);
      }
    }

    const department = await prisma.department.update({
      where: { id: req.params.id },
      data,
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'update',
        entityType: 'department',
        entityId: department.id,
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify(department),
      },
    });

    res.json(department);
  })
);

// Delete department
router.delete(
  '/:id',
  requirePermission('departments:delete'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const department = await prisma.department.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { employees: true } },
      },
    });

    if (!department) {
      throw new AppError('Department not found', 404);
    }

    // Move employees to no department
    if (department._count.employees > 0) {
      await prisma.employee.updateMany({
        where: { departmentId: req.params.id },
        data: { departmentId: null },
      });
    }

    await prisma.department.delete({
      where: { id: req.params.id },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'delete',
        entityType: 'department',
        entityId: req.params.id,
        oldValue: JSON.stringify(department),
      },
    });

    res.json({ message: 'Department deleted successfully' });
  })
);

// Get department statistics
router.get(
  '/:id/stats',
  requirePermission('departments:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const department = await prisma.department.findUnique({
      where: { id: req.params.id },
    });

    if (!department) {
      throw new AppError('Department not found', 404);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [employeeCount, presentToday, onLeaveToday] = await Promise.all([
      prisma.employee.count({
        where: { departmentId: req.params.id, status: 'active' },
      }),
      prisma.timeEntry.count({
        where: {
          Employee: { departmentId: req.params.id },
          clockIn: { gte: today },
        },
      }),
      prisma.leaveRequest.count({
        where: {
          Employee: { departmentId: req.params.id },
          status: 'approved',
          startDate: { lte: today },
          endDate: { gte: today },
        },
      }),
    ]);

    res.json({
      employeeCount,
      presentToday,
      onLeaveToday,
      absentToday: employeeCount - presentToday - onLeaveToday,
    });
  })
);

export default router;