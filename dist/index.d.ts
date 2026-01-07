import { Server as SocketIOServer } from 'socket.io';
declare class HikvisionService {
    initialize(): Promise<void>;
    stopPolling(): void;
}
declare const app: import("express-serve-static-core").Express;
declare const io: SocketIOServer<import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, any>;
declare global {
    var io: SocketIOServer;
    var hikvisionService: HikvisionService;
}
export declare const broadcastAttendanceEvent: (event: any) => void;
export { app, io };
//# sourceMappingURL=index.d.ts.map