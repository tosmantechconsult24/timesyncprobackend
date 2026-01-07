"use strict";
/**
 * routes/fingerprint.ts - USB Fingerprint Scanner Endpoints
 * Handles enrollment, verification, and scanner management
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const prisma_1 = require("../utils/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const auth_1 = require("../middleware/auth");
const logger_1 = require("../utils/logger");
const usbFingerprintScanner_1 = require("../services/usbFingerprintScanner");
const router = (0, express_1.Router)();
const scanner = (0, usbFingerprintScanner_1.getFingerprintScanner)();
// Validation schemas
const enrollmentStartSchema = zod_1.z.object({
    employeeId: zod_1.z.string().min(1),
});
const enrollmentCompleteSchema = zod_1.z.object({
    employeeId: zod_1.z.string().min(1),
    template: zod_1.z.string(),
    enrollmentDate: zod_1.z.string().optional(),
});
const verifySchema = zod_1.z.object({
    employeeId: zod_1.z.string().min(1),
    capturedTemplate: zod_1.z.string(),
});
// ============================================
// SCANNER STATUS
// ============================================
/**
 * Get fingerprint scanner status
 * Public endpoint - checked during initialization
 */
router.get('/status', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const status = scanner.getStatus();
    res.json({
        connected: status.connected,
        available: status.ready,
        deviceId: status.deviceId,
        ready: status.ready,
        lastError: null,
    });
}));
// ============================================
// ENROLLMENT ENDPOINTS
// ============================================
/**
 * Start fingerprint enrollment process
 * Initiates capture sequence for new employee fingerprint
 * Protected: requires admin or manager role
 */
router.post('/enroll/start', auth_1.authMiddleware, (0, auth_1.requireRole)('super_admin', 'admin', 'manager'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = enrollmentStartSchema.parse(req.body);
    // Verify employee exists and is active
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            status: true,
            fingerprintEnrolled: true,
        },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    if (employee.status !== 'active') {
        throw new errorHandler_1.AppError('Cannot enroll inactive employee', 400);
    }
    logger_1.logger.info(`Starting fingerprint enrollment for employee: ${employeeId}`);
    // Start scanner enrollment process
    const result = await scanner.startEnrollment(employeeId);
    if (!result.success) {
        logger_1.logger.error(`Enrollment failed for ${employeeId}: ${result.errorMessage}`);
        throw new errorHandler_1.AppError(result.errorMessage || 'Enrollment failed', 400);
    }
    // Return enrollment session info
    res.json({
        success: true,
        employeeId,
        enrollmentCount: result.enrollmentCount,
        template: result.template, // Temporary - will be saved in complete endpoint
        message: 'Enrollment process started. Please follow scanner instructions.',
    });
}));
/**
 * Complete fingerprint enrollment
 * Saves the enrolled template to database
 * Protected: requires admin or manager role
 */
router.post('/enroll/complete', auth_1.authMiddleware, (0, auth_1.requireRole)('super_admin', 'admin', 'manager'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId, template } = enrollmentCompleteSchema.parse(req.body);
    // Verify employee exists
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
        select: {
            id: true,
            firstName: true,
            lastName: true,
        },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    if (!template) {
        throw new errorHandler_1.AppError('Fingerprint template is required', 400);
    }
    // Save fingerprint template and enrollment date to Employee table
    const updated = await prisma_1.prisma.employee.update({
        where: { employeeId },
        data: {
            fingerprintTemplate: template, // Store base64-encoded template
            fingerprintTemplateDate: new Date(), // Store enrollment timestamp
            fingerprintEnrolled: true, // Mark as enrolled
        },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            fingerprintEnrolled: true,
            fingerprintTemplateDate: true,
        },
    });
    // Also save to BiometricData table for consistency
    const existingBiometric = await prisma_1.prisma.biometricData.findFirst({
        where: {
            employeeId: employeeId,
            type: 'FINGERPRINT',
            fingerNo: 0,
        },
    });
    if (existingBiometric) {
        await prisma_1.prisma.biometricData.update({
            where: { id: existingBiometric.id },
            data: { data: template },
        });
    }
    else {
        await prisma_1.prisma.biometricData.create({
            data: {
                id: (0, crypto_1.randomUUID)(),
                employeeId: employeeId,
                type: 'FINGERPRINT',
                data: template,
                fingerNo: 0,
            },
        });
    }
    // Create audit log for enrollment activity
    await prisma_1.prisma.auditLog.create({
        data: {
            userId: req.user?.id || undefined,
            action: 'fingerprint_enrolled',
            entityType: 'employee',
            entityId: employee.id,
            ipAddress: req.ip || undefined,
            userAgent: req.headers['user-agent'] || undefined,
        },
    });
    logger_1.logger.info(`Fingerprint enrollment completed for employee: ${employeeId}`);
    res.json({
        success: true,
        employee: updated,
        message: 'Fingerprint template enrolled and saved successfully',
    });
}));
/**
 * Get enrollment status for employee
 * Public endpoint - used by TimeStation
 */
router.get('/enrolled/:employeeId', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = req.params;
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            fingerprintEnrolled: true,
            status: true,
        },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    res.json({
        employeeId: employee.employeeId,
        enrolled: employee.fingerprintEnrolled,
        status: employee.status,
    });
}));
// ============================================
// VERIFICATION ENDPOINTS
// ============================================
/**
 * Verify fingerprint during clock in/out
 * Public endpoint - used by TimeStation
 * No auth required for kiosk usage
 */
router.post('/verify', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId, capturedTemplate } = verifySchema.parse(req.body);
    // Get employee and their stored template
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            fingerprintEnrolled: true,
            fingerprintTemplate: true,
            status: true,
        },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    if (employee.status !== 'active') {
        throw new errorHandler_1.AppError('Employee is not active', 403);
    }
    if (!employee.fingerprintEnrolled || !employee.fingerprintTemplate) {
        throw new errorHandler_1.AppError('Employee fingerprint not enrolled', 400);
    }
    logger_1.logger.info(`Verifying fingerprint for employee: ${employeeId}`);
    // Verify captured fingerprint against stored template
    const result = await scanner.verify(employee.fingerprintTemplate);
    if (!result.success) {
        logger_1.logger.warn(`Fingerprint verification failed for ${employeeId}: ${result.errorMessage}`);
        throw new errorHandler_1.AppError(result.errorMessage || 'Verification failed', 400);
    }
    if (!result.match) {
        logger_1.logger.warn(`Fingerprint mismatch for ${employeeId}. Similarity: ${result.similarity}%`);
        throw new errorHandler_1.AppError(`Fingerprint does not match. Similarity: ${result.similarity}%. Please try again.`, 401);
    }
    logger_1.logger.info(`Fingerprint verification successful for ${employeeId}. Similarity: ${result.similarity}%`);
    res.json({
        success: true,
        match: true,
        similarity: result.similarity,
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        message: 'Fingerprint verified successfully',
    });
}));
/**
 * Initialize scanner connection
 * Called during TimeStation startup
 */
router.post('/init', (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const isReady = scanner.isReady();
    if (!isReady) {
        logger_1.logger.warn('Fingerprint scanner not ready');
        throw new errorHandler_1.AppError('Fingerprint scanner not available. Please contact administrator.', 503);
    }
    res.json({
        success: true,
        ready: true,
        message: 'Scanner initialized successfully',
    });
}));
/**
 * Get employee fingerprint enrollment info (admin only)
 */
router.get('/employees/:employeeId', auth_1.authMiddleware, (0, auth_1.requireRole)('admin', 'manager'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = req.params;
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
        select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            fingerprintEnrolled: true,
            status: true,
        },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    res.json(employee);
}));
/**
 * Re-enroll fingerprint (admin only)
 * Clears previous enrollment and starts new one
 */
router.post('/reenroll/:employeeId', auth_1.authMiddleware, (0, auth_1.requireRole)('admin', 'manager'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { employeeId } = req.params;
    const employee = await prisma_1.prisma.employee.findUnique({
        where: { employeeId },
    });
    if (!employee) {
        throw new errorHandler_1.AppError('Employee not found', 404);
    }
    // Clear previous enrollment
    await prisma_1.prisma.employee.update({
        where: { employeeId },
        data: {
            fingerprintEnrolled: false,
        },
    });
    logger_1.logger.info(`Previous fingerprint cleared for employee: ${employeeId}`);
    res.json({
        success: true,
        message: 'Previous fingerprint enrollment cleared. Ready for new enrollment.',
    });
}));
// ============================================
// ERROR HANDLING
// ============================================
// If no route matched, return not found
router.use((req, res) => {
    res.status(404).json({ error: 'Fingerprint endpoint not found' });
});
exports.default = router;
//# sourceMappingURL=fingerprint.js.map