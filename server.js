// Flash9 信令服务器 — WebSocket + 静态文件
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 12 * 3600 * 1000;

const rooms = new Map();
const clients = new Map();

// MIME types
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain' };

function broadcastMemberUpdate(room) {
    const msg = JSON.stringify({ type: 'member-update', count: room.members.size });
    for (const member of room.members) { if (member.readyState === 1) member.send(msg); }
}

// 静态文件服务器
const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/Flash9_demo.html' : req.url;
    filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server });

console.log(`⚡ Flash9 信令服务器启动，端口 ${PORT}`);

// 定时清理过期房间
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (now >= room.destroyTimestamp || now - room.createdAt > ROOM_TTL_MS) {
            console.log(`🗑️  清理过期房间: ${code}`);
            for (const ws of room.members) {
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'room-destroyed', roomCode: code }));
                clients.delete(ws);
            }
            rooms.delete(code);
        }
    }
}, 60000);

wss.on('connection', (ws) => {
    console.log('🔗 新连接');

    ws.on('message', (raw) => {
        // 二进制分片：首字节非 '{' (0x7B)
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buf.length > 0 && buf[0] !== 0x7B) {
            const client = clients.get(ws);
            if (client && rooms.has(client.roomCode)) {
                const room = rooms.get(client.roomCode);
                for (const member of room.members) {
                    if (member !== ws && member.readyState === 1) member.send(buf);
                }
            }
            return;
        }

        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!msg || !msg.type) return;

        if (msg.type === 'register') {
            const { roomCode, peerId, nickname, color, destroyTimestamp } = msg;
            if (!roomCode || !peerId) return;

            const room = rooms.get(roomCode);
            if (room) {
                // 加入已有房间
                if (Date.now() >= room.destroyTimestamp) {
                    ws.send(JSON.stringify({ type: 'error', text: '房间已过期' }));
                    return;
                }
                room.members.add(ws);
                clients.set(ws, { roomCode, peerId, nickname, color });
                // 构造已有成员列表
                const members = [];
                for (const m of room.members) {
                    if (m !== ws) {
                        const c = clients.get(m);
                        if (c) members.push({ peerId: c.peerId, nickname: c.nickname, color: c.color });
                    }
                }
                ws.send(JSON.stringify({ type: 'register-ok', roomCode, destroyTimestamp: room.destroyTimestamp, members }));
                // 广播新成员给已有成员
                for (const m of room.members) {
                    if (m !== ws && m.readyState === 1) {
                        m.send(JSON.stringify({ type: 'peer-joined', peerId, nickname, color }));
                    }
                }
                console.log(`👤 ${nickname} 加入房间: ${roomCode}`);
                broadcastMemberUpdate(room);
                return;
            }
            // 创建新房间
            const ts = destroyTimestamp || Date.now() + ROOM_TTL_MS;
            rooms.set(roomCode, { destroyTimestamp: ts, createdAt: Date.now(), members: new Set([ws]) });
            clients.set(ws, { roomCode, peerId, nickname, color });
            ws.send(JSON.stringify({ type: 'register-ok', roomCode, destroyTimestamp: ts, members: [] }));
            console.log(`🏠 房间创建: ${roomCode} (${nickname})`);
            return;
        }

        const client = clients.get(ws);
        if (!client) return;
        const room = rooms.get(client.roomCode);
        if (!room) return;

        msg.from = client.peerId;

        // 广播给房间所有其他成员
        for (const member of room.members) {
            if (member !== ws && member.readyState === 1) {
                member.send(JSON.stringify(msg));
            }
        }

        if (msg.type === 'room-destroyed') {
            console.log(`💣 房间销毁: ${client.roomCode}`);
            setTimeout(() => {
                if (rooms.has(client.roomCode)) {
                    for (const m of rooms.get(client.roomCode).members) clients.delete(m);
                    rooms.delete(client.roomCode);
                }
            }, 1000);
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client && rooms.has(client.roomCode)) {
            const room = rooms.get(client.roomCode);
            room.members.delete(ws);
            console.log(`👋 ${client.nickname || client.peerId} 离开: ${client.roomCode}`);
            if (room.members.size === 0) {
                rooms.delete(client.roomCode);
                console.log(`🗑️  房间空置销毁: ${client.roomCode}`);
            } else {
                broadcastMemberUpdate(room);
            }
        }
        clients.delete(ws);
    });

    ws.on('error', (err) => console.error('WS 错误:', err.message));
});

server.listen(PORT, () => console.log('✅ 信令服务器就绪'));
