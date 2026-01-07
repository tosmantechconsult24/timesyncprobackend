#!/usr/bin/env python3
"""
ZKTeco USB Fingerprint Scanner Bridge
Provides a Python interface to the ZKTeco SDK via ctypes
This avoids the need for Node.js native modules that require compilation
"""

import ctypes
import os
import sys
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import base64

class ZKTecoFingerprintScanner:
    """Interface to ZKTeco Fingerprint SDK"""
    
    # Error codes
    ZKFP_ERR_OK = 0
    ZKFP_ERR_TIMEOUT = 1
    ZKFP_ERR_INVALID_PARAM = 2
    ZKFP_ERR_INVALID_HANDLE = 3
    ZKFP_ERR_OPEN_DEVICE = 4
    ZKFP_ERR_OPEN_FAILED = 5
    
    def __init__(self):
        self.lib = None
        self.device_handle = None
        self.db_handle = None
        self.is_initialized = False
        self.max_template_size = 2048
        self.max_image_size = 320 * 480
        self._load_library()
    
    def _load_library(self) -> bool:
        """Try to load libzkfp.dll from multiple locations"""
        search_paths = [
            # Try explicit System32 path first (most reliable)
            r'C:\Windows\System32\libzkfp.dll',
            r'C:\Program Files\libzkfp.dll',
            'libzkfp.dll',  # Fall back to system PATH
            r'C:\Program Files\ZKTeco\SDK\libzkfp.dll',
            str(Path(__file__).parent.parent.parent / 'bridge' / 'libzkfp.dll'),
        ]
        
        for dll_path in search_paths:
            try:
                # Try to load the DLL
                self.lib = ctypes.CDLL(dll_path)
                
                # Verify it's the real SDK by checking for ZKFPM_Init function
                try:
                    init_func = self.lib.ZKFPM_Init
                    print(f'[ZKTeco] SDK loaded from: {dll_path}')
                    return True
                except AttributeError:
                    print(f'[ZKTeco] DLL loaded but wrong library (no ZKFPM_Init): {dll_path}')
                    self.lib = None
                    continue
                    
            except (OSError, TypeError) as e:
                print(f'[ZKTeco] Failed to load {dll_path}: {e}')
                continue
        
        print('[ZKTeco] Failed to load libzkfp.dll from any location')
        print('[ZKTeco] Try: copy "C:\\Program Files (x86)\\ZKTeco SDK\\libzkfp.dll" C:\\Windows\\System32\\')
        return False
    
    def init(self) -> bool:
        """Initialize SDK"""
        if not self.lib:
            print('[ZKTeco] Library not loaded')
            return False
        
        try:
            # ZKFPM_Init
            init_func = self.lib.ZKFPM_Init
            init_func.restype = ctypes.c_int
            init_func.argtypes = []
            
            ret = init_func()
            if ret != self.ZKFP_ERR_OK:
                print(f'[ZKTeco] ZKFPM_Init failed: {ret}')
                return False
            
            # ZKFPM_DBInit
            db_init = self.lib.ZKFPM_DBInit
            db_init.restype = ctypes.c_void_p
            db_init.argtypes = []
            
            self.db_handle = db_init()
            if not self.db_handle:
                print('[ZKTeco] ZKFPM_DBInit failed')
                return False
            
            self.is_initialized = True
            print('[ZKTeco] SDK initialized successfully')
            return True
        except Exception as e:
            print(f'[ZKTeco] Initialization error: {e}')
            return False
    
    def get_device_count(self) -> int:
        """Get number of connected devices"""
        if not self.lib or not self.is_initialized:
            return 0
        
        try:
            get_count = self.lib.ZKFPM_GetDeviceCount
            get_count.restype = ctypes.c_int
            get_count.argtypes = []
            
            count = get_count()
            return max(0, count)
        except Exception as e:
            print(f'[ZKTeco] Error getting device count: {e}')
            return 0
    
    def open_device(self, device_index: int = 0) -> bool:
        """Open fingerprint device"""
        if not self.lib or not self.is_initialized:
            return False
        
        try:
            open_dev = self.lib.ZKFPM_OpenDevice
            open_dev.restype = ctypes.c_void_p
            open_dev.argtypes = [ctypes.c_int]
            
            print(f'[ZKTeco] Attempting to open device at index {device_index}...')
            handle = open_dev(device_index)
            
            if not handle:
                print(f'[ZKTeco] ZKFPM_OpenDevice returned NULL handle for index {device_index}')
                print(f'[ZKTeco] Detected {self.get_device_count()} devices available')
                print(f'[ZKTeco] Check:')
                print(f'[ZKTeco]   - Device index is valid (0-{self.get_device_count()-1})')
                print(f'[ZKTeco]   - Scanner has power (green light visible)')
                print(f'[ZKTeco]   - No other app is using the device')
                print(f'[ZKTeco]   - Device drivers are installed')
                return False
            
            self.device_handle = handle
            print(f'[ZKTeco] Device opened successfully (handle: {handle})')
            return True
        except Exception as e:
            print(f'[ZKTeco] Exception opening device: {e}')
            import traceback
            traceback.print_exc()
            return False
    
    def close_device(self):
        """Close device"""
        if not self.lib or not self.device_handle:
            return
        
        try:
            close_dev = self.lib.ZKFPM_CloseDevice
            close_dev.restype = ctypes.c_int
            close_dev.argtypes = [ctypes.c_void_p]
            
            close_dev(self.device_handle)
            self.device_handle = None
            print('[ZKTeco] Device closed')
        except Exception as e:
            print(f'[ZKTeco] Error closing device: {e}')
    
    def terminate(self):
        """Terminate SDK"""
        if not self.lib or not self.is_initialized:
            return
        
        try:
            if self.db_handle:
                db_free = self.lib.ZKFPM_DBFree
                db_free.restype = ctypes.c_int
                db_free.argtypes = [ctypes.c_void_p]
                db_free(self.db_handle)
                self.db_handle = None
            
            term_func = self.lib.ZKFPM_Terminate
            term_func.restype = ctypes.c_int
            term_func.argtypes = []
            
            term_func()
            self.is_initialized = False
            print('[ZKTeco] SDK terminated')
        except Exception as e:
            print(f'[ZKTeco] Error terminating SDK: {e}')
    
    def capture_fingerprint(self) -> Optional[Tuple[bytes, int]]:
        """Capture fingerprint from device
        Returns: (template_bytes, quality) or None on error
        """
        if not self.lib or not self.device_handle:
            print('[ZKTeco] Device not initialized')
            return None
        
        try:
            # Allocate buffers
            img_buf = ctypes.create_string_buffer(self.max_image_size)
            template_buf = ctypes.create_string_buffer(self.max_template_size)
            template_len = ctypes.c_uint(self.max_template_size)
            
            # Call ZKFPM_AcquireFingerprint
            acquire = self.lib.ZKFPM_AcquireFingerprint
            acquire.restype = ctypes.c_int
            acquire.argtypes = [
                ctypes.c_void_p,      # device handle
                ctypes.c_char_p,      # image buffer
                ctypes.c_uint,        # image size
                ctypes.c_char_p,      # template buffer
                ctypes.POINTER(ctypes.c_uint),  # template length
            ]
            
            ret = acquire(
                self.device_handle,
                img_buf,
                self.max_image_size,
                template_buf,
                ctypes.byref(template_len)
            )
            
            if ret != self.ZKFP_ERR_OK:
                print(f'[ZKTeco] ZKFPM_AcquireFingerprint failed: {ret}')
                return None
            
            # Extract template
            actual_len = template_len.value
            template = template_buf.raw[:actual_len]
            
            print(f'[ZKTeco] Fingerprint captured (template size: {actual_len})')
            return (template, 95)  # Quality estimate
        
        except Exception as e:
            print(f'[ZKTeco] Capture error: {e}')
            return None
    
    def enroll_fingerprint(self, num_samples: int = 3) -> Optional[bytes]:
        """Enroll fingerprint (capture multiple samples)
        Returns: merged template bytes or None on error
        """
        samples = []
        
        for i in range(num_samples):
            print(f'[ZKTeco] Scanning fingerprint {i+1} of {num_samples}...')
            result = self.capture_fingerprint()
            if not result:
                print(f'[ZKTeco] Failed to capture sample {i+1}')
                return None
            
            template, quality = result
            samples.append(template)
        
        if len(samples) < 3:
            print('[ZKTeco] Need at least 3 samples for enrollment')
            return None
        
        try:
            # Merge templates using ZKFPM_GenRegTemplate
            merged_buf = ctypes.create_string_buffer(self.max_template_size)
            merged_len = ctypes.c_uint(self.max_template_size)
            
            gen_reg = self.lib.ZKFPM_GenRegTemplate
            gen_reg.restype = ctypes.c_int
            gen_reg.argtypes = [
                ctypes.c_void_p,      # db handle
                ctypes.c_char_p,      # template 1
                ctypes.c_char_p,      # template 2
                ctypes.c_char_p,      # template 3
                ctypes.c_char_p,      # output buffer
                ctypes.POINTER(ctypes.c_uint),  # output length
            ]
            
            ret = gen_reg(
                self.db_handle,
                samples[0],
                samples[1],
                samples[2],
                merged_buf,
                ctypes.byref(merged_len)
            )
            
            if ret != self.ZKFP_ERR_OK:
                print(f'[ZKTeco] ZKFPM_GenRegTemplate failed: {ret}')
                return None
            
            actual_len = merged_len.value
            merged = merged_buf.raw[:actual_len]
            
            print(f'[ZKTeco] Enrollment complete (template size: {actual_len})')
            return merged
        
        except Exception as e:
            print(f'[ZKTeco] Enrollment error: {e}')
            return None
    
    def verify_fingerprint(self, stored_template: bytes) -> Optional[Dict]:
        """Verify fingerprint against stored template
        Returns: {'match': bool, 'similarity': score} or None on error
        """
        result = self.capture_fingerprint()
        if not result:
            return None
        
        captured_template, _ = result
        
        try:
            # Compare templates using ZKFPM_DBMatch
            match_func = self.lib.ZKFPM_DBMatch
            match_func.restype = ctypes.c_int
            match_func.argtypes = [
                ctypes.c_void_p,      # db handle
                ctypes.c_char_p,      # template 1
                ctypes.c_uint,        # template 1 size
                ctypes.c_char_p,      # template 2
                ctypes.c_uint,        # template 2 size
            ]
            
            similarity = match_func(
                self.db_handle,
                stored_template,
                len(stored_template),
                captured_template,
                len(captured_template)
            )
            
            if similarity < 0:
                print(f'[ZKTeco] ZKFPM_DBMatch error: {similarity}')
                return None
            
            match = similarity >= 60  # ZKTeco default threshold
            
            print(f'[ZKTeco] Verification complete (similarity: {similarity})')
            return {
                'match': match,
                'similarity': similarity
            }
        
        except Exception as e:
            print(f'[ZKTeco] Verification error: {e}')
            return None


def handle_request(request_type: str, payload: Dict) -> Dict:
    """Handle requests from Node.js backend"""
    scanner = ZKTecoFingerprintScanner()
    
    try:
        if request_type == 'init':
            success = scanner.init()
            device_count = scanner.get_device_count() if success else 0
            opened = scanner.open_device(0) if device_count > 0 else False
            
            return {
                'success': success and device_count > 0 and opened,
                'device_count': device_count,
                'error': None if success else 'Failed to initialize SDK'
            }
        
        elif request_type == 'capture':
            scanner.init()
            scanner.get_device_count()
            scanner.open_device(0)
            
            result = scanner.capture_fingerprint()
            if result:
                template, quality = result
                return {
                    'success': True,
                    'template': base64.b64encode(template).decode(),
                    'quality': quality
                }
            return {'success': False, 'error': 'Capture failed'}
        
        elif request_type == 'enroll':
            scanner.init()
            scanner.get_device_count()
            scanner.open_device(0)
            
            template = scanner.enroll_fingerprint(3)
            if template:
                return {
                    'success': True,
                    'template': base64.b64encode(template).decode()
                }
            return {'success': False, 'error': 'Enrollment failed'}
        
        elif request_type == 'verify':
            scanner.init()
            scanner.get_device_count()
            scanner.open_device(0)
            
            stored = base64.b64decode(payload.get('template', ''))
            result = scanner.verify_fingerprint(stored)
            
            if result:
                return {
                    'success': True,
                    'match': result['match'],
                    'similarity': result['similarity']
                }
            return {'success': False, 'error': 'Verification failed'}
        
        else:
            return {'success': False, 'error': f'Unknown request type: {request_type}'}
    
    finally:
        scanner.terminate()


if __name__ == '__main__':
    # Simple CLI for testing
    if len(sys.argv) > 1:
        req_type = sys.argv[1]
        payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        result = handle_request(req_type, payload)
        print(json.dumps(result))
    else:
        print('ZKTeco Fingerprint Bridge - CLI Interface')
        print('Usage: python zkTecoFingerprintBridge.py <type> [payload]')
