import type { WebSocketServer } from 'ws';

/**
 * TASKMASTER WEBSOCKET UTILITIES
 * ==============================
 * 
 * Utilities for broadcasting TaskMaster state changes via WebSocket.
 * Integrates with the existing WebSocket system to provide real-time updates.
 */

/**
 * Broadcast TaskMaster project update to all connected clients.
 *
 * The payload key is `projectId` post-migration so frontend listeners can
 * match notifications against the DB-assigned project identifier they
 * already use everywhere else.
 *
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectId - DB id of the updated project
 * @param {Object} taskMasterData - Updated TaskMaster data
 */
export function broadcastTaskMasterProjectUpdate(wss: WebSocketServer, projectId: string, taskMasterData: unknown): void {
    if (!wss || !projectId) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectId');
        return;
    }

    const message = {
        type: 'taskmaster-project-updated',
        projectId,
        taskMasterData,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster project update:', error);
            }
        }
    });
}

/**
 * Broadcast TaskMaster tasks update for a specific project.
 *
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectId - DB id of the project with updated tasks
 * @param {Object} tasksData - Updated tasks data
 */
export function broadcastTaskMasterTasksUpdate(wss: WebSocketServer, projectId: string, tasksData: unknown): void {
    if (!wss || !projectId) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectId');
        return;
    }

    const message = {
        type: 'taskmaster-tasks-updated',
        projectId,
        tasksData,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster tasks update:', error);
            }
        }
    });
}
