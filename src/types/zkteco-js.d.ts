/**
 * Type declarations for zkteco-js
 * Provides types for the ZKTeco fingerprint terminal library
 */

declare module 'zkteco-js' {
  export interface ZKTeco {
    new (config: any): ZKTecoInstance;
  }

  export interface ZKTecoInstance {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getInfo(): Promise<any>;
    getAttendance(): Promise<any[]>;
    setUser(user: any): Promise<void>;
    deleteUser(userId: string): Promise<void>;
    getUsers(): Promise<any[]>;
    startRealTimeLog(callback: Function): Promise<void>;
    stopRealTimeLog(): Promise<void>;
    enrollUser(enrollData: any): Promise<void>;
    [key: string]: any;
  }

  export default ZKTeco;
}
