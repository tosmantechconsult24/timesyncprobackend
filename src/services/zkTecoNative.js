/**
 * USB Fingerprint Scanner - Native Binding Module
 * Handles direct communication with ZKTeco 9500 USB scanner
 * 
 * This module attempts to use native bindings to communicate with the hardware
 * Falls back to mock mode if bindings not available
 */

const path = require('path');
const fs = require('fs');

class ZKTecoUSBScanner {
  constructor() {
    this.connected = false;
    this.device = null;
    this.templateBuffer = Buffer.alloc(2048);
    this.lastTemplate = null;
    this.nativeModule = null;
    
    this._initializeNative();
  }

  /**
   * Try to load native ZKTeco module
   */
  _initializeNative() {
    try {
      // Try to require the native zkteco module if available
      this.nativeModule = require('zkteco-js');
      console.log('[ZKTeco] Native module loaded successfully');
      return true;
    } catch (error) {
      console.log('[ZKTeco] Native module not available:', error.message);
      return false;
    }
  }

  /**
   * Initialize and connect to scanner device
   */
  async connect() {
    try {
      if (this.nativeModule && typeof this.nativeModule.init === 'function') {
        const result = this.nativeModule.init();
        if (result) {
          this.connected = true;
          console.log('[ZKTeco] ✓ Scanner connected');
          return true;
        }
      }
      
      console.log('[ZKTeco] ⚠ Scanner connection in compatibility mode');
      this.connected = false;
      return false;
    } catch (error) {
      console.error('[ZKTeco] Connection error:', error.message);
      this.connected = false;
      return false;
    }
  }

  /**
   * Capture single fingerprint from device
   * Returns: {template: Buffer, quality: number}
   */
  async captureFingerprint() {
    if (!this.connected) {
      throw new Error('Scanner not connected');
    }

    try {
      if (this.nativeModule && typeof this.nativeModule.captureFingerprint === 'function') {
        // Use native module to capture from device
        const result = this.nativeModule.captureFingerprint();
        
        if (result && result.template) {
          this.lastTemplate = Buffer.from(result.template);
          return {
            template: Buffer.from(result.template),
            quality: result.quality || 85,
          };
        }
      }

      throw new Error('Failed to capture from device');
    } catch (error) {
      console.error('[ZKTeco] Capture error:', error.message);
      throw error;
    }
  }

  /**
   * Enroll fingerprint with multiple samples
   * Returns combined template
   */
  async enrollFingerprint(sampleCount = 3) {
    if (!this.connected) {
      throw new Error('Scanner not connected');
    }

    try {
      const samples = [];
      
      for (let i = 0; i < sampleCount; i++) {
        console.log(`[ZKTeco] Capturing sample ${i + 1}/${sampleCount}`);
        
        const capture = await this.captureFingerprint();
        samples.push(capture.template);
        
        // Wait before next capture
        if (i < sampleCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      // Merge templates using native function if available
      return this._mergeTemplates(samples);
    } catch (error) {
      console.error('[ZKTeco] Enrollment error:', error.message);
      throw error;
    }
  }

  /**
   * Verify captured template against stored template
   * Returns: {match: boolean, similarity: number}
   */
  async verifyFingerprint(storedTemplate, capturedTemplate) {
    if (!this.connected) {
      throw new Error('Scanner not connected');
    }

    try {
      if (this.nativeModule && typeof this.nativeModule.compareTemplate === 'function') {
        // Use native SDK comparison
        const score = this.nativeModule.compareTemplate(storedTemplate, capturedTemplate);
        
        return {
          match: score >= 85,
          similarity: Math.min(100, Math.max(0, score)),
        };
      }

      // Fallback: binary comparison
      const similarity = this._compareBinary(storedTemplate, capturedTemplate);
      return {
        match: similarity > 85,
        similarity,
      };
    } catch (error) {
      console.error('[ZKTeco] Verification error:', error.message);
      throw error;
    }
  }

  /**
   * Merge multiple template samples into one
   */
  _mergeTemplates(templates) {
    try {
      if (this.nativeModule && typeof this.nativeModule.mergeTemplates === 'function') {
        return this.nativeModule.mergeTemplates(templates);
      }
    } catch (error) {
      console.log('[ZKTeco] Native merge failed, using fallback');
    }

    // Fallback: XOR all templates together
    let merged = Buffer.alloc(2048);
    for (let template of templates) {
      for (let i = 0; i < Math.min(template.length, merged.length); i++) {
        merged[i] ^= template[i];
      }
    }
    return merged;
  }

  /**
   * Simple binary comparison fallback
   */
  _compareBinary(template1, template2) {
    if (!template1 || !template2) return 0;

    const minLen = Math.min(template1.length, template2.length);
    let matches = 0;

    for (let i = 0; i < minLen; i++) {
      if (template1[i] === template2[i]) {
        matches++;
      }
    }

    return Math.round((matches / minLen) * 100);
  }

  /**
   * Disconnect from scanner
   */
  async disconnect() {
    try {
      if (this.nativeModule && typeof this.nativeModule.disconnect === 'function') {
        this.nativeModule.disconnect();
      }
      this.connected = false;
      console.log('[ZKTeco] Scanner disconnected');
    } catch (error) {
      console.error('[ZKTeco] Disconnect error:', error.message);
    }
  }

  /**
   * Get scanner status
   */
  getStatus() {
    return {
      connected: this.connected,
      nativeAvailable: !!this.nativeModule,
      mode: this.nativeModule ? 'native' : 'compatibility',
    };
  }
}

// Export singleton
module.exports = {
  ZKTecoUSBScanner,
  createScanner: () => new ZKTecoUSBScanner(),
};
