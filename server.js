// =========================================================
// KODE SERVER: NODE.JS, EXPRESS, DAN SOCKET.IO
// =========================================================
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const MAX_PLAYERS_PER_ROOM = 5;

// === MAP & STRUKTUR BASE CAMP (DIPERLUAS SUPER LUAS 200x200) ===
function generateBaseWalls() {
    const walls = [];
    function add(x, z, w, d, h, color, name) {
        walls.push({ x, z, width: w, depth: d, height: h, color, name });
    }

    // Pagar Keliling (-100 sampai 100)
    // Celah pintu diperlebar (jadi 30 unit) dan sekarang TERBUKA DI KEEMPAT SISI
    
    // Pagar Utara & Selatan (Celah di tengah)
    add(-57.5, -100, 85, 2, 6, 0x8B4513, "Pagar_Utara_Kiri");
    add(57.5, -100, 85, 2, 6, 0x8B4513, "Pagar_Utara_Kanan");
    add(-57.5, 100, 85, 2, 6, 0x8B4513, "Pagar_Selatan_Kiri");
    add(57.5, 100, 85, 2, 6, 0x8B4513, "Pagar_Selatan_Kanan");
    
    // Pagar Barat & Timur (Sekarang terbuka di tengah juga)
    add(-100, -57.5, 2, 85, 6, 0x8B4513, "Pagar_Barat_Atas");
    add(-100, 57.5, 2, 85, 6, 0x8B4513, "Pagar_Barat_Bawah");
    add(100, -57.5, 2, 85, 6, 0x8B4513, "Pagar_Timur_Atas");
    add(100, 57.5, 2, 85, 6, 0x8B4513, "Pagar_Timur_Bawah");

    // Bangunan Utama
    add(0, -30, 24, 24, 10, 0xffffff, "Rumah_Putih"); // Inventory
    add(40, 20, 20, 20, 8, 0x22aa22, "Rumah_Hijau");  // Toko Senjata
    add(-40, 20, 20, 20, 8, 0x2222aa, "Rumah_Biru");  // Toko Perangkap

    return walls;
}

function spawnZombies(room) {
    room.zombies = {}; 
    let count = 4 + (room.level * 2);
    for (let i = 0; i < count; i++) {
        let id = 'zombie_' + Date.now() + '_' + i;
        let type = Math.random() < 0.3 ? 'kuat' : 'kroco';
        let hpBase = type === 'kuat' ? 6 : 3;
        
        // Spawn Zombie lebih jauh karena pagar sekarang besar (Radius 160 - 200)
        let angle = Math.random() * Math.PI * 2;
        let radius = 160 + Math.random() * 40; 

        room.zombies[id] = {
            id: id, type: type,
            x: Math.cos(angle) * radius, 
            z: Math.sin(angle) * radius,
            hp: hpBase + Math.floor(room.level / 2), 
            maxHp: hpBase + Math.floor(room.level / 2),
            speed: (type === 'kuat' ? 12 : 8) + (room.level * 0.4),
            lastAttack: 0 
        };
    }
    
    if (room.level % 5 === 0) {
        let bossId = 'zombie_boss_' + Date.now();
        room.zombies[bossId] = {
            id: bossId, type: 'boss',
            x: 0, z: -220, // Bos spawn sangat jauh
            hp: 25 * room.level, maxHp: 25 * room.level, 
            speed: 9 + (room.level * 0.2), lastAttack: 0
        };
    }
    io.to(room.id).emit('syncZombies', room.zombies);
}

// Loop Otak Server Zombie
setInterval(() => {
    let now = Date.now();
    for (let roomId in rooms) {
        let room = rooms[roomId];
        if (room.gameState !== 'PLAYING') continue;
        
        let playerIds = Object.keys(room.players);
        if (playerIds.length === 0) continue;

        let allDead = true;
        playerIds.forEach(pid => { if (room.players[pid].hp > 0) allDead = false; });
        if (allDead) {
            room.gameState = 'LOBBY';
            room.zombies = {};
            io.to(roomId).emit('gameOverReset');
            continue;
        }

        let zombiesMoved = false;
        for (let zid in room.zombies) {
            let z = room.zombies[zid];
            let nearest = null; let minDist = Infinity;

            playerIds.forEach(pid => {
                let p = room.players[pid];
                if (p.hp > 0) {
                    let dist = Math.hypot(p.x - z.x, p.z - z.z);
                    if (dist < minDist) { minDist = dist; nearest = p; }
                }
            });

            if (nearest && minDist > (z.type === 'boss' ? 4 : 2.5)) {
                let dx = nearest.x - z.x; let dz = nearest.z - z.z;
                let len = Math.hypot(dx, dz);
                let moveX = (dx / len) * z.speed * 0.1;
                let moveZ = (dz / len) * z.speed * 0.1;
                
                let newX = z.x + moveX; let newZ = z.z + moveZ;
                let zRadius = z.type === 'boss' ? 2 : 1;
                
                let collideX = false; let collideZ = false;
                for (let w of room.walls) {
                    let hwX = w.width / 2; let hwZ = w.depth / 2;
                    if (newX + zRadius > w.x - hwX && newX - zRadius < w.x + hwX && z.z + zRadius > w.z - hwZ && z.z - zRadius < w.z + hwZ) collideX = true;
                    if (z.x + zRadius > w.x - hwX && z.x - zRadius < w.x + hwX && newZ + zRadius > w.z - hwZ && newZ - zRadius < w.z + hwZ) collideZ = true;
                }

                // PATHFINDING: Kalau nabrak tembok, zombie menggeser cari jalan
                if (!collideX) {
                    z.x = newX;
                } else {
                    z.z += (dz > 0 ? 1 : -1) * z.speed * 0.05; // Sliding halus di sumbu Z
                }

                if (!collideZ) {
                    z.z = newZ;
                } else {
                    z.x += (dx > 0 ? 1 : -1) * z.speed * 0.05; // Sliding halus di sumbu X
                }
                
                zombiesMoved = true;
            }

            // Serangan Zombie (Cooldown 1.5 Detik)
            if (nearest && minDist <= (z.type === 'boss' ? 4.5 : 3)) {
                if (now - z.lastAttack > 1500) {
                    z.lastAttack = now;
                    let baseDmg = z.type === 'boss' ? 6 : (z.type === 'kuat' ? 3 : 1);
                    let dmg = baseDmg + Math.floor(room.level * 0.5);
                    nearest.hp -= dmg;
                    io.to(roomId).emit('playerHpUpdate', { id: nearest.id, hp: nearest.hp });
                    io.to(roomId).emit('spawnDamageIndicator', { x: nearest.x, y: nearest.y + 2, z: nearest.z, dmg: dmg, color: '#ff0000' });
                }
            }
        }
        if (zombiesMoved) io.to(roomId).emit('updateZombiesPosition', room.zombies);
    }
}, 100);

app.get('/rooms', (req, res) => {
    const publicRooms = Object.keys(rooms).map(id => ({ id, name: rooms[id].name, players: Object.keys(rooms[id].players).length }));
    res.json(publicRooms);
});

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ username, roomId, roomName }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { id: roomId, name: roomName, players: {}, zombies: {}, level: 1, gameState: 'LOBBY', walls: generateBaseWalls() };
        }
        let room = rooms[roomId];
        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('roomError', 'Room Penuh!'); return;
        }

        socket.join(roomId);
        socket.roomId = roomId;

        room.players[socket.id] = {
            id: socket.id, username: username || 'Player',
            x: (Math.random() - 0.5) * 10, y: 5.5, z: 20 + (Math.random() - 0.5) * 10,
            rotationY: 0, hp: 100, color: Math.floor(Math.random()*16777215)
        };
        
        socket.emit('initGameData', { players: room.players, gameState: room.gameState, currentLevel: room.level, zombies: room.zombies, walls: room.walls });
        socket.broadcast.to(roomId).emit('newPlayer', room.players[socket.id]);
        io.emit('roomListUpdated');
    });

    socket.on('requestRespawn', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            let p = room.players[socket.id];
            if (p) {
                p.hp = 100; p.x = (Math.random() - 0.5) * 10; p.z = 20 + (Math.random() - 0.5) * 10;
                io.to(socket.roomId).emit('playerHpUpdate', { id: socket.id, hp: 100 });
                socket.emit('respawnApproved', p);
            }
        }
    });

    socket.on('startGame', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            if (room.gameState === 'LOBBY') {
                room.gameState = 'PLAYING'; room.level = 1; spawnZombies(room);
                Object.values(room.players).forEach(p => { p.hp = 100; io.to(socket.roomId).emit('playerHpUpdate', { id: p.id, hp: p.hp }); });
                io.to(socket.roomId).emit('gameStarted', room.level);
            }
        }
    });

    socket.on('playerMove', (data) => {
        if (socket.roomId && rooms[socket.roomId]) {
            let p = rooms[socket.roomId].players[socket.id];
            if (p) {
                p.x = data.x; p.y = data.y; p.z = data.z; p.rotationY = data.rotationY;
                socket.broadcast.to(socket.roomId).emit('playerMoved', p);
            }
        }
    });

    socket.on('playerShootVisual', () => {
        if (socket.roomId) socket.broadcast.to(socket.roomId).emit('otherPlayerShot', socket.id);
    });

    socket.on('shootZombie', (data) => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            let z = room.zombies[data.id];
            if (z) {
                let damage = 1; if (data.part === 'head') damage = 3; else if (data.part === 'legs') damage = 0.5;
                z.hp -= damage;
                
                io.to(socket.roomId).emit('spawnDamageIndicator', { x: z.x, y: 5, z: z.z, dmg: damage, color: '#ffff00' });

                if (z.hp <= 0) {
                    delete room.zombies[data.id]; io.to(socket.roomId).emit('zombieDied', data.id);
                    if (Object.keys(room.zombies).length === 0) {
                        room.level++; setTimeout(() => { spawnZombies(room); io.to(socket.roomId).emit('levelUp', room.level); }, 3000);
                    }
                } else { io.to(socket.roomId).emit('zombieHit', { id: data.id, hp: z.hp, maxHp: z.maxHp }); }
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            delete room.players[socket.id];
            io.to(socket.roomId).emit('playerLeft', socket.id);
            if (Object.keys(room.players).length === 0) { delete rooms[socket.roomId]; io.emit('roomListUpdated'); }
        }
    });
});

// PENGATURAN PORT DINAMIS UNTUK RAILWAY & LOCALHOST
// =========================================================
// =========================================================
// PENGATURAN PORT DINAMIS UNTUK RAILWAY & LOCALHOST
// =========================================================
const PORT = process.env.PORT || 8080;
http.listen(PORT, '0.0.0.0', () => { 
    console.log(`Server jalan di port ${PORT}`); 
});
