import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();

// Bridge URL - the bridge handles all terminal communication
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3000';

/**
 * Helper to call bridge API
 */
async function callBridge(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(`${BRIDGE_URL}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Bridge returned ${response.status}`);
    }
    
    return await response.json();
  } catch (error: any) {
    logger.warn(`Bridge call failed: ${error.message}`);
    throw error;
  }
}

/**
 * Check if bridge is running
 */
async function isBridgeOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${BRIDGE_URL}/health`, { 
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get all terminals
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const terminals = await prisma.terminal.findMany({
      orderBy: { createdAt: 'desc' }
    });
    
    // Try to get live status from bridge
    try {
      const bridgeStatus = await callBridge('/status');
      const bridgeTerminals = bridgeStatus.terminals || [];
      
      // Merge bridge status with database records
      const enrichedTerminals = terminals.map(t => {
        const bridgeT = bridgeTerminals.find((bt: any) => 
          bt.ip === t.ipAddress || bt.name === t.name
        );
        return {
          ...t,
          isOnline: bridgeT?.online ?? t.isOnline,
          lastEvent: bridgeT?.lastEvent ?? null
        };
      });
      
      return res.json(enrichedTerminals);
    } catch {
      // Bridge not available, return database status
      return res.json(terminals);
    }
  } catch (error: any) {
    logger.error(`Failed to get terminals: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single terminal
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id }
    });
    
    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }
    
    res.json(terminal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create terminal
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, ipAddress, port, location, password } = req.body;

    const terminal = await prisma.terminal.create({
      data: {
        id: randomUUID(),
        name,
        ipAddress,
        port: port || 4370,
        location: location || null,
        username: 'admin', // ZKTeco doesn't use username
        password: password || '0', // Comm Key
        deviceType: 'ZKTeco F22',
        isActive: true,
        isOnline: false,
        updatedAt: new Date()
      }
    });

    // Note: For terminal to work, it must also be added to bridge's config.json
    logger.info(`Terminal created: ${name} (${ipAddress}:${port})`);
    logger.info('Remember to add this terminal to bridge config.json!');

    res.status(201).json({
      ...terminal,
      message: 'Terminal created. Add to bridge config.json for real-time sync.'
    });
  } catch (error: any) {
    logger.error(`Failed to create terminal: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update terminal
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, ipAddress, port, location, password, isActive } = req.body;

    const terminal = await prisma.terminal.update({
      where: { id: req.params.id },
      data: {
        name,
        ipAddress,
        port: port || 4370,
        location: location || null,
        password,
        isActive
      }
    });

    res.json(terminal);
  } catch (error: any) {
    logger.error(`Failed to update terminal: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete terminal
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.terminal.delete({
      where: { id: req.params.id }
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Failed to delete terminal: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test terminal connection (via bridge)
 */
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id }
    });

    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    // Check if bridge is running
    const bridgeOnline = await isBridgeOnline();
    
    if (!bridgeOnline) {
      // Update terminal as offline
      await prisma.terminal.update({
        where: { id: req.params.id },
        data: { isOnline: false }
      });
      
      return res.json({
        success: false,
        message: 'Bridge is not running. Start the bridge with: cd bridge && npm start',
        bridgeOnline: false
      });
    }

    // Test through bridge
    try {
      const result = await callBridge(`/api/terminals/${terminal.id}/test`, 'POST', {
        ipAddress: terminal.ipAddress,
        port: terminal.port
      });
      
      // Update database with result
      await prisma.terminal.update({
        where: { id: req.params.id },
        data: { 
          isOnline: result.connected || result.success,
          lastSyncAt: result.connected ? new Date() : undefined
        }
      });

      return res.json({
        success: result.connected || result.success,
        message: result.connected ? 'Connection successful' : 'Connection failed',
        bridgeOnline: true,
        details: result
      });
    } catch (bridgeError: any) {
      // Bridge couldn't reach terminal
      await prisma.terminal.update({
        where: { id: req.params.id },
        data: { isOnline: false }
      });
      
      return res.json({
        success: false,
        message: `Bridge could not connect to terminal: ${bridgeError.message}`,
        bridgeOnline: true
      });
    }
  } catch (error: any) {
    logger.error(`Connection test failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get terminal device info (via bridge)
 */
router.get('/:id/info', async (req: Request, res: Response) => {
  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id }
    });

    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    const bridgeOnline = await isBridgeOnline();
    if (!bridgeOnline) {
      return res.status(503).json({ 
        error: 'Bridge is not running',
        message: 'Start the bridge with: cd bridge && npm start'
      });
    }

    try {
      const status = await callBridge(`/api/terminals/${terminal.id}/status`);
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  } catch (error: any) {
    logger.error(`Failed to get device info: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Sync all employees to terminal (via bridge)
 */
router.post('/:id/sync-employees', async (req: Request, res: Response) => {
  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id }
    });

    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    const bridgeOnline = await isBridgeOnline();
    if (!bridgeOnline) {
      return res.status(503).json({ 
        error: 'Bridge is not running',
        message: 'Start the bridge with: cd bridge && npm start'
      });
    }

    // Trigger sync through bridge
    const result = await callBridge('/sync-all', 'POST');
    
    // Update sync time
    await prisma.terminal.update({
      where: { id: req.params.id },
      data: { lastSyncAt: new Date() }
    });

    res.json({
      success: true,
      message: result.message || 'Sync initiated',
      ...result
    });
  } catch (error: any) {
    logger.error(`Sync failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get attendance logs from terminal (via bridge)
 */
router.get('/:id/attendance', async (req: Request, res: Response) => {
  try {
    const bridgeOnline = await isBridgeOnline();
    if (!bridgeOnline) {
      return res.status(503).json({ 
        error: 'Bridge is not running'
      });
    }

    // Get recent attendance from database instead
    const attendance = await prisma.timeEntry.findMany({
      where: {
        terminalId: req.params.id
      },
      orderBy: { clockIn: 'desc' },
      take: 100,
      include: {
        Employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeId: true
          }
        }
      }
    });

    res.json(attendance);
  } catch (error: any) {
    logger.error(`Failed to get attendance: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get users on terminal (via bridge)  
 */
router.get('/:id/users', async (req: Request, res: Response) => {
  try {
    const bridgeOnline = await isBridgeOnline();
    if (!bridgeOnline) {
      return res.status(503).json({ 
        error: 'Bridge is not running'
      });
    }

    // This would need bridge support - for now return synced count
    const terminal = await prisma.terminal.findUnique({
      where: { id: req.params.id }
    });

    if (!terminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    // Return employees that should be on terminal
    const employees = await prisma.employee.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        employeeId: true,
        firstName: true,
        lastName: true
      }
    });

    res.json({
      terminal: terminal.name,
      expectedUsers: employees.length,
      users: employees
    });
  } catch (error: any) {
    logger.error(`Failed to get users: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check bridge status
 */
router.get('/bridge/status', async (req: Request, res: Response) => {
  try {
    const bridgeOnline = await isBridgeOnline();
    
    if (!bridgeOnline) {
      return res.json({
        online: false,
        message: 'Bridge is not running. Start with: cd bridge && npm start'
      });
    }

    const status = await callBridge('/status');
    res.json({
      online: true,
      ...status
    });
  } catch (error: any) {
    res.json({
      online: false,
      error: error.message
    });
  }
});

export default router;
