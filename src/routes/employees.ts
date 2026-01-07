// ============================================
// routes/employees.ts - Complete with USB Fingerprint Support
// ============================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, requirePermission } from '../middleware/auth';
import { randomUUID } from 'crypto';

const router = Router();

// Configure multer for file uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG and PNG are allowed.'));
    }
  }
});

const employeeSchema = z.object({
  employeeId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  joinDate: z.string().optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contract']).optional(),
  status: z.enum(['active', 'inactive', 'on_leave', 'terminated']).optional(),
  shiftId: z.string().optional().nullable(),
  salary: z.number().optional().nullable(),
  hourlyRate: z.number().optional().nullable(),
  cardNumber: z.string().optional().nullable()
});

// ============================================
// KIOSK ENDPOINTS (No Auth Required)
// ============================================

// Lookup employee for kiosk (PUBLIC - no auth)
router.get('/lookup/:employeeId', async (req: Request, res: Response) => {
  try {
    const searchId = req.params.employeeId;
    
    const employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { id: searchId },
          { employeeId: searchId },
        ],
      },
      include: {
        department: { select: { id: true, name: true } },
        shift: { select: { id: true, name: true, startTime: true, endTime: true } },
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Check if fingerprint enrolled
    const fingerprint = await prisma.biometricData.findFirst({
      where: { 
        employeeId: employee.id,
        type: 'FINGERPRINT' 
      },
    });

    // Get today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayAttendance = await prisma.attendanceLog.findMany({
      where: {
        employeeId: employee.id,
        timestamp: { gte: today },
      },
      orderBy: { timestamp: 'desc' },
    });

    res.json({
      id: employee.id,
      employeeId: employee.employeeId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      phone: employee.phone,
      photo: employee.photo,
      status: employee.status,
      department: employee.department,
      shift: employee.shift,
      fingerprintEnrolled: !!fingerprint?.data,
      todayAttendance,
    });
  } catch (error: any) {
    console.error('Employee lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup employee' });
  }
});

// Get fingerprint template for kiosk verification (PUBLIC - no auth)
router.get('/fingerprint-template/:employeeId', async (req: Request, res: Response) => {
  try {
    const searchId = req.params.employeeId;
    
    // Find employee by UUID or employeeId
    const employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { id: searchId },
          { employeeId: searchId },
        ],
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found', enrolled: false });
    }

    // Get fingerprint template
    const biometric = await prisma.biometricData.findFirst({
      where: {
        employeeId: employee.id,
        type: 'FINGERPRINT',
      },
      orderBy: { enrolledAt: 'desc' },
    });

    if (!biometric || !biometric.data) {
      return res.status(404).json({ 
        error: 'No fingerprint registered. Please enroll fingerprint first.',
        enrolled: false
      });
    }

    res.json({ 
      template: biometric.data,
      enrolled: true,
      fingerNo: biometric.fingerNo || 0,
      employeeId: employee.employeeId
    });
  } catch (error: any) {
    console.error('Get fingerprint template error:', error);
    res.status(500).json({ error: 'Failed to get fingerprint template' });
  }
});

// Enroll fingerprint from USB scanner (PUBLIC for kiosk use)
router.post('/fingerprint-enroll/:employeeId', async (req: Request, res: Response) => {
  try {
    const { template, fingerNo = 0, quality = 100 } = req.body;
    const searchId = req.params.employeeId;

    if (!template) {
      return res.status(400).json({ error: 'Fingerprint template is required' });
    }

    // Find employee
    const employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { id: searchId },
          { employeeId: searchId },
        ],
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Check for existing fingerprint
    const existingBiometric = await prisma.biometricData.findFirst({
      where: {
        employeeId: employee.id,
        type: 'FINGERPRINT',
        fingerNo: fingerNo,
      },
    });

    let biometric;
    if (existingBiometric) {
      // Update existing fingerprint
      biometric = await prisma.biometricData.update({
        where: { id: existingBiometric.id },
        data: {
          data: template,
          enrolledAt: new Date(),
        },
      });
      logger.info(`Fingerprint updated for employee ${employee.employeeId}`);
    } else {
      // Create new fingerprint record
      biometric = await prisma.biometricData.create({
        data: {
          id: randomUUID(),
          employeeId: employee.id,
          type: 'FINGERPRINT',
          data: template,
          fingerNo,
          enrolledAt: new Date(),
        },
      });
      logger.info(`Fingerprint enrolled for employee ${employee.employeeId}`);
    }

    // Update employee fingerprint status
    await prisma.employee.update({
      where: { id: employee.id },
      data: { fingerprintEnrolled: true },
    });

    res.json({
      success: true,
      message: 'Fingerprint enrolled successfully',
      biometricId: biometric.id,
      employeeId: employee.employeeId,
    });
  } catch (error: any) {
    console.error('Fingerprint enrollment error:', error);
    res.status(500).json({ error: 'Failed to enroll fingerprint: ' + error.message });
  }
});

// Check fingerprint enrollment status (PUBLIC)
router.get('/fingerprint-status/:employeeId', async (req: Request, res: Response) => {
  try {
    const searchId = req.params.employeeId;
    
    const employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { id: searchId },
          { employeeId: searchId },
        ],
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const biometric = await prisma.biometricData.findFirst({
      where: {
        employeeId: employee.id,
        type: 'FINGERPRINT',
      },
    });

    res.json({
      enrolled: !!biometric?.data,
      employeeId: employee.employeeId,
      enrolledAt: biometric?.enrolledAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to check fingerprint status' });
  }
});

// ============================================
// AUTHENTICATED ENDPOINTS (Require Auth)
// ============================================

// Get all employees
router.get('/', requirePermission('employees:read'), asyncHandler(async (req: AuthRequest, res: any) => {
  const { department, status, search, page = '1', limit = '50' } = req.query;
  
  const where: any = {};
  
  if (department) {
    where.departmentId = department as string;
  }
  
  if (status) {
    where.status = status as string;
  }
  
  if (search) {
    where.OR = [
      { firstName: { contains: search as string } },
      { lastName: { contains: search as string } },
      { employeeId: { contains: search as string } },
      { email: { contains: search as string } }
    ];
  }
  
  const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
  
  const [employees, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        department: true,
        shift: true,
        BiometricData: {
          select: { id: true, type: true, enrolledAt: true }
        }
      },
      skip,
      take: parseInt(limit as string),
      orderBy: { createdAt: 'desc' }
    }),
    prisma.employee.count({ where })
  ]);

  // Add fingerprintEnrolled flag
  const employeesWithStatus = employees.map((emp: any) => ({
    ...emp,
    fingerprintEnrolled: emp.BiometricData?.some((b: any) => b.type === 'FINGERPRINT') || false
  }));
  
  res.json({
    employees: employeesWithStatus,
    total,
    pagination: {
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      total,
      pages: Math.ceil(total / parseInt(limit as string))
    }
  });
}));

// Get employee by ID
router.get('/:id', requirePermission('employees:read'), asyncHandler(async (req: AuthRequest, res: any) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: {
      department: true,
      shift: true,
      BiometricData: {
        select: { id: true, type: true, enrolledAt: true, fingerNo: true }
      },
      User: {
        select: { id: true, email: true, role: true }
      }
    }
  });
  
  if (!employee) {
    throw new AppError('Employee not found', 404);
  }

  // Add fingerprint status - cast as any since BiometricData is included in the object
  const result = {
    ...employee,
    fingerprintEnrolled: (employee as any).BiometricData?.some((b: any) => b.type === 'FINGERPRINT') || false
  };
  
  res.json(result);
}));

// Create employee with optional photo
router.post('/', requirePermission('employees:write'), upload.single('photo'), asyncHandler(async (req: AuthRequest, res: any) => {
  let data;
  
  if (req.body.data) {
    data = employeeSchema.parse(JSON.parse(req.body.data));
  } else {
    data = employeeSchema.parse(req.body);
  }
  
  const existing = await prisma.employee.findUnique({
    where: { employeeId: data.employeeId }
  });
  
  if (existing) {
    throw new AppError('Employee ID already exists', 409);
  }
  
  let photoPath: string | undefined;
  if (req.file) {
    try {
      const filename = `employee-${data.employeeId}-${Date.now()}.jpg`;
      const filepath = path.join(uploadDir, 'photos', filename);
      
      const photoDir = path.join(uploadDir, 'photos');
      if (!fs.existsSync(photoDir)) {
        fs.mkdirSync(photoDir, { recursive: true });
      }
      
      await sharp(req.file.buffer)
        .resize(640, 480, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toFile(filepath);
      
      photoPath = `/uploads/photos/${filename}`;
      logger.info(`Photo saved: ${photoPath}`);
    } catch (error) {
      logger.error('Error processing photo:', error);
    }
  }
  
  const employee = await prisma.employee.create({
    data: {
      ...data,
      photo: photoPath,
      joinDate: data.joinDate ? new Date(data.joinDate) : new Date(),
      fingerprintEnrolled: false,
    },
    include: {
      department: true,
      shift: true
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'create',
      entityType: 'employee',
      entityId: employee.id,
      newValue: JSON.stringify(employee)
    }
  });
  
  res.status(201).json(employee);
}));

// Update employee
router.put('/:id', requirePermission('employees:write'), upload.single('photo'), asyncHandler(async (req: AuthRequest, res: any) => {
  const existing = await prisma.employee.findUnique({
    where: { id: req.params.id }
  });
  
  if (!existing) {
    throw new AppError('Employee not found', 404);
  }
  
  let data;
  if (req.body.data) {
    data = employeeSchema.partial().parse(JSON.parse(req.body.data));
  } else {
    data = employeeSchema.partial().parse(req.body);
  }
  
  if (data.employeeId && data.employeeId !== existing.employeeId) {
    const duplicate = await prisma.employee.findUnique({
      where: { employeeId: data.employeeId }
    });
    if (duplicate) {
      throw new AppError('Employee ID already exists', 409);
    }
  }
  
  let photoPath = existing.photo;
  if (req.file) {
    try {
      const filename = `employee-${data.employeeId || existing.employeeId}-${Date.now()}.jpg`;
      const filepath = path.join(uploadDir, 'photos', filename);
      
      const photoDir = path.join(uploadDir, 'photos');
      if (!fs.existsSync(photoDir)) {
        fs.mkdirSync(photoDir, { recursive: true });
      }
      
      await sharp(req.file.buffer)
        .resize(640, 480, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toFile(filepath);
      
      photoPath = `/uploads/photos/${filename}`;
      
      if (existing.photo) {
        const oldPath = path.join(uploadDir, existing.photo.replace('/uploads/', ''));
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    } catch (error) {
      logger.error('Error processing photo:', error);
    }
  }
  
  const employee = await prisma.employee.update({
    where: { id: req.params.id },
    data: {
      ...data,
      photo: photoPath,
      joinDate: data.joinDate ? new Date(data.joinDate) : undefined
    },
    include: {
      department: true,
      shift: true
    }
  });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'update',
      entityType: 'employee',
      entityId: employee.id,
      oldValue: JSON.stringify(existing),
      newValue: JSON.stringify(employee)
    }
  });
  
  res.json(employee);
}));

// Delete employee
router.delete('/:id', requirePermission('employees:delete'), asyncHandler(async (req: AuthRequest, res: any) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id }
  });
  
  if (!employee) {
    throw new AppError('Employee not found', 404);
  }
  
  // Delete related data
  await prisma.biometricData.deleteMany({ where: { employeeId: req.params.id } });
  await prisma.attendanceLog.deleteMany({ where: { employeeId: req.params.id } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: req.params.id } });
  
  if (employee.photo) {
    const photoPath = path.join(uploadDir, employee.photo.replace('/uploads/', ''));
    if (fs.existsSync(photoPath)) {
      fs.unlinkSync(photoPath);
    }
  }
  
  await prisma.employee.delete({ where: { id: req.params.id } });
  
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'delete',
      entityType: 'employee',
      entityId: req.params.id,
      oldValue: JSON.stringify(employee)
    }
  });
  
  res.json({ message: 'Employee deleted successfully' });
}));

// Delete fingerprint (admin only)
router.delete('/:id/fingerprint', requirePermission('employees:write'), asyncHandler(async (req: AuthRequest, res: any) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id }
  });
  
  if (!employee) {
    throw new AppError('Employee not found', 404);
  }
  
  await prisma.biometricData.deleteMany({
    where: {
      employeeId: employee.id,
      type: 'FINGERPRINT',
    },
  });
  
  await prisma.employee.update({
    where: { id: employee.id },
    data: { fingerprintEnrolled: false },
  });
  
  res.json({ success: true, message: 'Fingerprint deleted' });
}));

// Bulk import employees
router.post('/import', requirePermission('employees:write'), asyncHandler(async (req: AuthRequest, res: any) => {
  const { employees } = req.body;
  
  if (!Array.isArray(employees)) {
    throw new AppError('Invalid data format', 400);
  }
  
  const results = {
    success: 0,
    failed: 0,
    errors: [] as any[]
  };
  
  for (const emp of employees) {
    try {
      const data = employeeSchema.parse(emp);
      
      await prisma.employee.upsert({
        where: { employeeId: data.employeeId },
        create: {
          ...data,
          joinDate: data.joinDate ? new Date(data.joinDate) : new Date()
        },
        update: {
          ...data,
          joinDate: data.joinDate ? new Date(data.joinDate) : undefined
        }
      });
      
      results.success++;
    } catch (error: any) {
      results.failed++;
      results.errors.push({
        employeeId: emp.employeeId,
        error: error.message
      });
    }
  }
  
  res.json(results);
}));

export default router;