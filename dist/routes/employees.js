"use strict";
// ============================================
// routes/employees.ts - Complete with USB Fingerprint Support
// ============================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const sharp_1 = __importDefault(require("sharp"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const prisma_1 = require("../utils/prisma");
const logger_1 = require("../utils/logger");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const crypto_1 = require("crypto");
const router = (0, express_1.Router)();
// Configure multer for file uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer_1.default.memoryStorage();
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error('Invalid file type. Only JPEG and PNG are allowed.'));
        }
    }
});
const employeeSchema = zod_1.z.object({
    employeeId: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    email: zod_1.z.string().email().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
    departmentId: zod_1.z.string().optional().nullable(),
    designation: zod_1.z.string().optional().nullable(),
    managerId: zod_1.z.string().optional().nullable(),
    joinDate: zod_1.z.string().optional(),
    employmentType: zod_1.z.enum(['full_time', 'part_time', 'contract']).optional(),
    status: zod_1.z.enum(['active', 'inactive', 'on_leave', 'terminated']).optional(),
    shiftId: zod_1.z.string().optional().nullable(),
    salary: zod_1.z.number().optional().nullable(),
    hourlyRate: zod_1.z.number().optional().nullable(),
    cardNumber: zod_1.z.string().optional().nullable()
});
// ============================================
// KIOSK ENDPOINTS (No Auth Required)
// ============================================
// Lookup employee for kiosk (PUBLIC - no auth)
router.get('/lookup/:employeeId', async (req, res) => {
    try {
        const searchId = req.params.employeeId;
        const employee = await prisma_1.prisma.employee.findFirst({
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
        const fingerprint = await prisma_1.prisma.biometricData.findFirst({
            where: {
                employeeId: employee.id,
                type: 'FINGERPRINT'
            },
        });
        // Get today's attendance
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayAttendance = await prisma_1.prisma.attendanceLog.findMany({
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
    }
    catch (error) {
        console.error('Employee lookup error:', error);
        res.status(500).json({ error: 'Failed to lookup employee' });
    }
});
// Get fingerprint template for kiosk verification (PUBLIC - no auth)
router.get('/fingerprint-template/:employeeId', async (req, res) => {
    try {
        const searchId = req.params.employeeId;
        // Find employee by UUID or employeeId
        const employee = await prisma_1.prisma.employee.findFirst({
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
        const biometric = await prisma_1.prisma.biometricData.findFirst({
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
    }
    catch (error) {
        console.error('Get fingerprint template error:', error);
        res.status(500).json({ error: 'Failed to get fingerprint template' });
    }
});
// Enroll fingerprint from USB scanner (PUBLIC for kiosk use)
router.post('/fingerprint-enroll/:employeeId', async (req, res) => {
    try {
        const { template, fingerNo = 0, quality = 100 } = req.body;
        const searchId = req.params.employeeId;
        if (!template) {
            return res.status(400).json({ error: 'Fingerprint template is required' });
        }
        // Find employee
        const employee = await prisma_1.prisma.employee.findFirst({
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
        const existingBiometric = await prisma_1.prisma.biometricData.findFirst({
            where: {
                employeeId: employee.id,
                type: 'FINGERPRINT',
                fingerNo: fingerNo,
            },
        });
        let biometric;
        if (existingBiometric) {
            // Update existing fingerprint
            biometric = await prisma_1.prisma.biometricData.update({
                where: { id: existingBiometric.id },
                data: {
                    data: template,
                    enrolledAt: new Date(),
                },
            });
            logger_1.logger.info(`Fingerprint updated for employee ${employee.employeeId}`);
        }
        else {
            // Create new fingerprint record
            biometric = await prisma_1.prisma.biometricData.create({
                data: {
                    id: (0, crypto_1.randomUUID)(),
                    employeeId: employee.id,
                    type: 'FINGERPRINT',
                    data: template,
                    fingerNo,
                    enrolledAt: new Date(),
                },
            });
            logger_1.logger.info(`Fingerprint enrolled for employee ${employee.employeeId}`);
        }
        // Update employee fingerprint status
        await prisma_1.prisma.employee.update({
            where: { id: employee.id },
            data: { fingerprintEnrolled: true },
        });
        res.json({
            success: true,
            message: 'Fingerprint enrolled successfully',
            biometricId: biometric.id,
            employeeId: employee.employeeId,
        });
    }
    catch (error) {
        console.error('Fingerprint enrollment error:', error);
        res.status(500).json({ error: 'Failed to enroll fingerprint: ' + error.message });
    }
});
// Check fingerprint enrollment status (PUBLIC)
router.get('/fingerprint-status/:employeeId', async (req, res) => {
    try {
        const searchId = req.params.employeeId;
        const employee = await prisma_1.prisma.employee.findFirst({
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
        const biometric = await prisma_1.prisma.biometricData.findFirst({
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
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to check fingerprint status' });
    }
});
// ============================================
// AUTHENTICATED ENDPOINTS (Require Auth)
// ============================================
// Get all employees
router.get('/', (0, auth_1.requirePermission)('employees:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { department, status, search, page = '1', limit = '50' } = req.query;
    const where = {};
    if (department) {
        where.departmentId = department;
    }
    if (status) {
        where.status = status;
    }
    if (search) {
        where.OR = [
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { employeeId: { contains: search } },
            { email: { contains: search } }
        ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [employees, total] = await Promise.all([
        prisma_1.prisma.employee.findMany({
            where,
            include: {
                department: true,
                shift: true,
                BiometricData: {
                    select: { id: true, type: true, enrolledAt: true }
                }
            },
            skip,
            take: parseInt(limit),
            orderBy: { createdAt: 'desc' }
        }),
        prisma_1.prisma.employee.count({ where })
    ]);
    // Add fingerprintEnrolled flag
    const employeesWithStatus = employees.map((emp) => ({
        ...emp,
        fingerprintEnrolled: emp.BiometricData?.some((b) => b.type === 'FINGERPRINT') || false
    }));
    res.json({
        employees: employeesWithStatus,
        total,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
        }
    });
}));
// Get employee by ID
router.get('/:id', (0, auth_1.requirePermission)('employees:read'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const employee = await prisma_1.prisma.employee.findUnique({
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
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    // Add fingerprint status - cast as any since BiometricData is included in the object
    const result = {
        ...employee,
        fingerprintEnrolled: employee.BiometricData?.some((b) => b.type === 'FINGERPRINT') || false
    };
    res.json(result);
}));
// Create employee with optional photo
router.post('/', (0, auth_1.requirePermission)('employees:write'), upload.single('photo'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    let data;
    if (req.body.data) {
        data = employeeSchema.parse(JSON.parse(req.body.data));
    }
    else {
        data = employeeSchema.parse(req.body);
    }
    const existing = await prisma_1.prisma.employee.findUnique({
        where: { employeeId: data.employeeId }
    });
    if (existing) {
        throw new errorHandler_1.AppError('Employee ID already exists', 409);
    }
    let photoPath;
    if (req.file) {
        try {
            const filename = `employee-${data.employeeId}-${Date.now()}.jpg`;
            const filepath = path_1.default.join(uploadDir, 'photos', filename);
            const photoDir = path_1.default.join(uploadDir, 'photos');
            if (!fs_1.default.existsSync(photoDir)) {
                fs_1.default.mkdirSync(photoDir, { recursive: true });
            }
            await (0, sharp_1.default)(req.file.buffer)
                .resize(640, 480, { fit: 'cover' })
                .jpeg({ quality: 90 })
                .toFile(filepath);
            photoPath = `/uploads/photos/${filename}`;
            logger_1.logger.info(`Photo saved: ${photoPath}`);
        }
        catch (error) {
            logger_1.logger.error('Error processing photo:', error);
        }
    }
    const employee = await prisma_1.prisma.employee.create({
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'create',
            entityType: 'employee',
            entityId: employee.id,
            newValue: JSON.stringify(employee)
        }
    });
    res.status(201).json(employee);
}));
// Update employee
router.put('/:id', (0, auth_1.requirePermission)('employees:write'), upload.single('photo'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const existing = await prisma_1.prisma.employee.findUnique({
        where: { id: req.params.id }
    });
    if (!existing) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    let data;
    if (req.body.data) {
        data = employeeSchema.partial().parse(JSON.parse(req.body.data));
    }
    else {
        data = employeeSchema.partial().parse(req.body);
    }
    if (data.employeeId && data.employeeId !== existing.employeeId) {
        const duplicate = await prisma_1.prisma.employee.findUnique({
            where: { employeeId: data.employeeId }
        });
        if (duplicate) {
            throw new errorHandler_1.AppError('Employee ID already exists', 409);
        }
    }
    let photoPath = existing.photo;
    if (req.file) {
        try {
            const filename = `employee-${data.employeeId || existing.employeeId}-${Date.now()}.jpg`;
            const filepath = path_1.default.join(uploadDir, 'photos', filename);
            const photoDir = path_1.default.join(uploadDir, 'photos');
            if (!fs_1.default.existsSync(photoDir)) {
                fs_1.default.mkdirSync(photoDir, { recursive: true });
            }
            await (0, sharp_1.default)(req.file.buffer)
                .resize(640, 480, { fit: 'cover' })
                .jpeg({ quality: 90 })
                .toFile(filepath);
            photoPath = `/uploads/photos/${filename}`;
            if (existing.photo) {
                const oldPath = path_1.default.join(uploadDir, existing.photo.replace('/uploads/', ''));
                if (fs_1.default.existsSync(oldPath)) {
                    fs_1.default.unlinkSync(oldPath);
                }
            }
        }
        catch (error) {
            logger_1.logger.error('Error processing photo:', error);
        }
    }
    const employee = await prisma_1.prisma.employee.update({
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
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
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
router.delete('/:id', (0, auth_1.requirePermission)('employees:delete'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: req.params.id }
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    // Delete related data
    await prisma_1.prisma.biometricData.deleteMany({ where: { employeeId: req.params.id } });
    await prisma_1.prisma.attendanceLog.deleteMany({ where: { employeeId: req.params.id } });
    await prisma_1.prisma.leaveRequest.deleteMany({ where: { employeeId: req.params.id } });
    if (employee.photo) {
        const photoPath = path_1.default.join(uploadDir, employee.photo.replace('/uploads/', ''));
        if (fs_1.default.existsSync(photoPath)) {
            fs_1.default.unlinkSync(photoPath);
        }
    }
    await prisma_1.prisma.employee.delete({ where: { id: req.params.id } });
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user.id,
            action: 'delete',
            entityType: 'employee',
            entityId: req.params.id,
            oldValue: JSON.stringify(employee)
        }
    });
    res.json({ message: 'Employee deleted successfully' });
}));
// Delete fingerprint (admin only)
router.delete('/:id/fingerprint', (0, auth_1.requirePermission)('employees:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { id: req.params.id }
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    await prisma_1.prisma.biometricData.deleteMany({
        where: {
            employeeId: employee.id,
            type: 'FINGERPRINT',
        },
    });
    await prisma_1.prisma.employee.update({
        where: { id: employee.id },
        data: { fingerprintEnrolled: false },
    });
    res.json({ success: true, message: 'Fingerprint deleted' });
}));
// Bulk import employees
router.post('/import', (0, auth_1.requirePermission)('employees:write'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employees } = req.body;
    if (!Array.isArray(employees)) {
        throw new errorHandler_1.AppError('Invalid data format', 400);
    }
    const results = {
        success: 0,
        failed: 0,
        errors: []
    };
    for (const emp of employees) {
        try {
            const data = employeeSchema.parse(emp);
            await prisma_1.prisma.employee.upsert({
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
        }
        catch (error) {
            results.failed++;
            results.errors.push({
                employeeId: emp.employeeId,
                error: error.message
            });
        }
    }
    res.json(results);
}));
exports.default = router;
//# sourceMappingURL=employees.js.map