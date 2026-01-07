/**
 * routes/fingerprint.ts - USB Fingerprint Scanner Endpoints
 * Handles enrollment, verification, and scanner management
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { AuthRequest, authMiddleware, requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';
import { getFingerprintScanner } from '../services/usbFingerprintScanner';

const router = Router();
const scanner = getFingerprintScanner();

// Validation schemas
const enrollmentStartSchema = z.object({
  employeeId: z.string().min(1),
});

const enrollmentCompleteSchema = z.object({
  employeeId: z.string().min(1),
  template: z.string(),
  enrollmentDate: z.string().optional(),
});

const verifySchema = z.object({
  employeeId: z.string().min(1),
  capturedTemplate: z.string(),
});

// ============================================
// SCANNER STATUS
// ============================================

/**
 * Get fingerprint scanner status
 * Public endpoint - checked during initialization
 */
router.get(
  '/status',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const status = scanner.getStatus();
    res.json({
      connected: status.connected,
      available: status.ready,
      deviceId: status.deviceId,
      ready: status.ready,
      lastError: null,
    });
  })
);

// ============================================
// ENROLLMENT ENDPOINTS
// ============================================

/**
 * Start fingerprint enrollment process
 * Initiates capture sequence for new employee fingerprint
 * Protected: requires admin or manager role
 */
router.post(
  '/enroll/start',
  authMiddleware,
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = enrollmentStartSchema.parse(req.body);

    // Verify employee exists and is active
    const employee = await prisma.employee.findUnique({
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
      throw new AppError('Employee not found', 404);
    }

    if (employee.status !== 'active') {
      throw new AppError('Cannot enroll inactive employee', 400);
    }

    logger.info(`Starting fingerprint enrollment for employee: ${employeeId}`);

    // Start scanner enrollment process
    const result = await scanner.startEnrollment(employeeId);

    if (!result.success) {
      logger.error(`Enrollment failed for ${employeeId}: ${result.errorMessage}`);
      throw new AppError(result.errorMessage || 'Enrollment failed', 400);
    }

    // Return enrollment session info
    res.json({
      success: true,
      employeeId,
      enrollmentCount: result.enrollmentCount,
      template: result.template, // Temporary - will be saved in complete endpoint
      message: 'Enrollment process started. Please follow scanner instructions.',
    });
  })
);

/**
 * Complete fingerprint enrollment
 * Saves the enrolled template to database
 * Protected: requires admin or manager role
 */
router.post(
  '/enroll/complete',
  authMiddleware,
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, template } = enrollmentCompleteSchema.parse(req.body);

    // Verify employee exists
    const employee = await prisma.employee.findUnique({
      where: { employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    if (!template) {
      throw new AppError('Fingerprint template is required', 400);
    }

    // Save fingerprint template and enrollment date to Employee table
    const updated = await prisma.employee.update({
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
    const existingBiometric = await prisma.biometricData.findFirst({
      where: {
        employeeId: employeeId,
        type: 'FINGERPRINT',
        fingerNo: 0,
      },
    });

    if (existingBiometric) {
      await prisma.biometricData.update({
        where: { id: existingBiometric.id },
        data: { data: template },
      });
    } else {
      await prisma.biometricData.create({
        data: {
          id: randomUUID(),
          employeeId: employeeId,
          type: 'FINGERPRINT',
          data: template,
          fingerNo: 0,
        },
      });
    }

    // Create audit log for enrollment activity
    await prisma.auditLog.create({
      data: {
        userId: req.user?.id || undefined,
        action: 'fingerprint_enrolled',
        entityType: 'employee',
        entityId: employee.id,
        ipAddress: req.ip || undefined,
        userAgent: req.headers['user-agent'] || undefined,
      },
    });

    logger.info(`Fingerprint enrollment completed for employee: ${employeeId}`);

    res.json({
      success: true,
      employee: updated,
      message: 'Fingerprint template enrolled and saved successfully',
    });
  })
);

/**
 * Get enrollment status for employee
 * Public endpoint - used by TimeStation
 */
router.get(
  '/enrolled/:employeeId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const employee = await prisma.employee.findUnique({
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
      throw new AppError('Employee not found', 404);
    }

    res.json({
      employeeId: employee.employeeId,
      enrolled: employee.fingerprintEnrolled,
      status: employee.status,
    });
  })
);

// ============================================
// VERIFICATION ENDPOINTS
// ============================================

/**
 * Verify fingerprint during clock in/out
 * Public endpoint - used by TimeStation
 * No auth required for kiosk usage
 */
router.post(
  '/verify',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId, capturedTemplate } = verifySchema.parse(req.body);

    // Get employee and their stored template
    const employee = await prisma.employee.findUnique({
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
      throw new AppError('Employee not found', 404);
    }

    if (employee.status !== 'active') {
      throw new AppError('Employee is not active', 403);
    }

    if (!employee.fingerprintEnrolled || !employee.fingerprintTemplate) {
      throw new AppError('Employee fingerprint not enrolled', 400);
    }

    logger.info(`Verifying fingerprint for employee: ${employeeId}`);

    // Verify captured fingerprint against stored template
    const result = await scanner.verify(employee.fingerprintTemplate);

    if (!result.success) {
      logger.warn(
        `Fingerprint verification failed for ${employeeId}: ${result.errorMessage}`
      );
      throw new AppError(result.errorMessage || 'Verification failed', 400);
    }

    if (!result.match) {
      logger.warn(
        `Fingerprint mismatch for ${employeeId}. Similarity: ${result.similarity}%`
      );
      throw new AppError(
        `Fingerprint does not match. Similarity: ${result.similarity}%. Please try again.`,
        401
      );
    }

    logger.info(
      `Fingerprint verification successful for ${employeeId}. Similarity: ${result.similarity}%`
    );

    res.json({
      success: true,
      match: true,
      similarity: result.similarity,
      employeeId: employee.employeeId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      message: 'Fingerprint verified successfully',
    });
  })
);

/**
 * Initialize scanner connection
 * Called during TimeStation startup
 */
router.post(
  '/init',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const isReady = scanner.isReady();

    if (!isReady) {
      logger.warn('Fingerprint scanner not ready');
      throw new AppError(
        'Fingerprint scanner not available. Please contact administrator.',
        503
      );
    }

    res.json({
      success: true,
      ready: true,
      message: 'Scanner initialized successfully',
    });
  })
);

/**
 * Get employee fingerprint enrollment info (admin only)
 */
router.get(
  '/employees/:employeeId',
  authMiddleware,
  requireRole('admin', 'manager'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const employee = await prisma.employee.findUnique({
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
      throw new AppError('Employee not found', 404);
    }

    res.json(employee);
  })
);

/**
 * Re-enroll fingerprint (admin only)
 * Clears previous enrollment and starts new one
 */
router.post(
  '/reenroll/:employeeId',
  authMiddleware,
  requireRole('admin', 'manager'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { employeeId } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { employeeId },
    });

    if (!employee) {
      throw new AppError('Employee not found', 404);
    }

    // Clear previous enrollment
    await prisma.employee.update({
      where: { employeeId },
      data: {
        fingerprintEnrolled: false,
      },
    });

    logger.info(`Previous fingerprint cleared for employee: ${employeeId}`);

    res.json({
      success: true,
      message: 'Previous fingerprint enrollment cleared. Ready for new enrollment.',
    });
  })
);

// ============================================
// ERROR HANDLING
// ============================================

// If no route matched, return not found
router.use((req, res) => {
  res.status(404).json({ error: 'Fingerprint endpoint not found' });
});

export default router;
