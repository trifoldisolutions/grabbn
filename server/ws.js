// server/ws.js — WebSocket client registry
// Holds the connection map and push helper so any module can import it
// without creating a circular dependency on serve.js.

// userId (string) → Set of WebSocket instances (same user, multiple tabs)
export const wsClients = new Map();

export function pushNotification(userId, payload) {
    const set = wsClients.get(String(userId));
    if (!set) return;
    const msg = JSON.stringify(payload);
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
    }
}
