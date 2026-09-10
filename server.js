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
// --- KONSTANTA AUTHORITATIVE DOWNED & REVIVE (PHASE 2) ---
const MAX_PLAYERS_PER_ROOM = 5;
const BLEED_OUT_TIME_SEC = 30; // Waktu pendarahan authoritaitve authoritaitve
const REVIVE_DISTANCE = 4.0;    // Jarak revive authoritaitve authoritaitveauthoritaitve
const REVIVE_TIME_SEC = 6.0;    // Waktu revive FPS style (6 detik)
const MOVEMENT_TOLERANCE = 0.1; // Toleransi diam authoritaitve authoritaitve

// === STRUKTUR BASE RAPI (TANPA TEMBOK TEMBUS & ADA API UNGGUN DI TENGAH) ===
function generateBaseWalls() {
    const walls = [];
    function add(x, z, w, d, h, color, name) {
        walls.push({ x, z, width: w, depth: d, height: h, color, name });
    }

    // Pagar Keliling Base (Luas 200x200, Pintu di 4 Sisi)
    add(-57.5, -100, 85, 2, 6, 0x8B4513, "Pagar_Utara_Kiri");
    add(57.5, -100, 85, 2, 6, 0x8B4513, "Pagar_Utara_Kanan");
    add(-57.5, 100, 85, 2, 6, 0x8B4513, "Pagar_Selatan_Kiri");
    add(57.5, 100, 85, 2, 6, 0x8B4513, "Pagar_Selatan_Kanan");
    
    add(-100, -57.5, 2, 85, 6, 0x8B4513, "Pagar_Barat_Atas");
    add(-100, 57.5, 2, 85, 6, 0x8B4513, "Pagar_Barat_Bawah");
    add(100, -57.5, 2, 85, 6, 0x8B4513, "Pagar_Timur_Atas");
    add(100, 57.5, 2, 85, 6, 0x8B4513, "Pagar_Timur_Bawah");

    // Rumah-rumah di sekitar base (Solid & Terstruktur rapi)
    add(0, -50, 24, 20, 10, 0xffffff, "Rumah_Putih"); // Inventory
    add(55, 30, 20, 20, 8, 0x22aa22, "Rumah_Hijau");   // Toko Senjata
    add(-55, 30, 20, 20, 8, 0x2222aa, "Rumah_Biru");   // Toko Sewa

    return walls;
}

function spawnZombies(room) {
    room.zombies = {}; 
    let count = 4 + (room.level * 2);
    for (let i = 0; i < count; i++) {
        let id = 'zombie_' + Date.now() + '_' + i;
        let type = Math.random() < 0.3 ? 'kuat' : 'kroco';
        let hpBase = type === 'kuat' ? 6 : 3;
        
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
            x: 0, z: -220,
            hp: 25 * room.level, maxHp: 25 * room.level, 
            speed: 9 + (room.level * 0.2), lastAttack: 0
        };
    }
    io.to(room.id).emit('syncZombies', room.zombies);
}

// --- STATE REVIVE GLOBAL ---
    // key: targetId, value: { reviverId, startX, startZ, progress, remainingBleed }
    let roomReviveProgress = {};
setInterval(() => {
    let now = Date.now();
    for (let roomId in rooms) {
        let room = rooms[roomId];
        if (room.gameState !== 'PLAYING') continue;
        
        let playerIds = Object.keys(room.players);
        if (playerIds.length === 0) continue;

        let allDead = true;
        playerIds.forEach(pid => { if (room.players[pid].hp > 0) allDead = false; });
        
        // Jika semua player mati ATAU api unggun hancur (HP <= 0), Game Over
        if (allDead || room.campfireHp <= 0) {
            room.gameState = 'LOBBY';
            room.zombies = {};
            io.to(roomId).emit('gameOverReset');
            continue;
        }

        let zombiesMoved = false;
        for (let zid in room.zombies) {
            let z = room.zombies[zid];
            let target = null;
            let targetType = 'player';
            let minDist = Infinity;

          // 1. Cari Player terdekat atau arahkan ke Api Unggun (0,0)
            playerIds.forEach(pid => {
                let p = room.players[pid];
                if (p.hp > 0) {
                    let dist = Math.hypot(p.x - z.x, p.z - z.z);
                    if (dist < minDist) { minDist = dist; target = p; targetType = 'player'; }
                }
            });

            let distToCampfire = Math.hypot(0 - z.x, 0 - z.z);
            if (minDist > 25 && distToCampfire < minDist) {
                target = { x: 0, z: 0 };
                targetType = 'campfire';
                minDist = distToCampfire;
            }

         let attackRange = targetType === 'campfire' ? 4 : (z.type === 'boss' ? 4 : 2.5);

            if (target && minDist > attackRange) {
                let dx = target.x - z.x; let dz = target.z - z.z;
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

                if (!collideX) z.x = newX; else z.z += (dz > 0 ? 1 : -1) * z.speed * 0.05;
                if (!collideZ) z.z = newZ; else z.x += (dx > 0 ? 1 : -1) * z.speed * 0.05;
                
                zombiesMoved = true;
            }

            // Serangan Zombie ke Player atau Campfire
            if (target && minDist <= attackRange) {
                if (now - z.lastAttack > 1500) {
                    z.lastAttack = now;
                    let baseDmg = z.type === 'boss' ? 6 : (z.type === 'kuat' ? 3 : 1);
                    let dmg = baseDmg + Math.floor(room.level * 0.5);

                   if (targetType === 'player') {
                        target.hp -= dmg;
                        if (target.hp <= 0 && !target.isDowned) {
                            target.isDowned = true;
                            target.hp = 0;
                            io.to(roomId).emit('playerDowned', { id: target.id });
                        } else if (!target.isDowned) {
                            io.to(roomId).emit('playerHpUpdate', { id: target.id, hp: target.hp });
                        }
                        io.to(roomId).emit('spawnDamageIndicator', { x: target.x, y: target.y + 2, z: target.z, dmg: dmg, color: '#ff0000' });
                    } else {
                        // Serang Api Unggun (Campfire)
                        room.campfireHp -= dmg;
                        io.to(roomId).emit('campfireHpUpdate', { hp: room.campfireHp });
                        io.to(roomId).emit('spawnDamageIndicator', { x: 0, y: 3, z: 0, dmg: dmg, color: '#ff7700' });
                    }
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
            // Pembuat room pertama otomatis jadi HOST
            rooms[roomId] = { 
                id: roomId, name: roomName, players: {}, zombies: {}, 
                level: 1, gameState: 'LOBBY', walls: generateBaseWalls(),
                campfireHp: 200, maxCampfireHp: 200, teamCoin: 0,
                hostId: socket.id 
            };
        }
        let room = rooms[roomId];
        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            return socket.emit('roomError', 'Room Penuh!');
        }

        socket.join(roomId);
        socket.roomId = roomId;

        // Spawn acak aman
        let spawnX = (Math.random() - 0.5) * 10;
        let spawnZ = 20 + (Math.random() - 0.5) * 10;

        room.players[socket.id] = {
            id: socket.id, username: username || 'Player',
            x: spawnX, y: 5.5, z: spawnZ,
            rotationY: 0, hp: 100, isDowned: false, xp: 0, level: 1, color: Math.floor(Math.random()*16777215)
        };
        
        let pCount = Object.keys(room.players).length;

        // 1. KIRIM SNAPSHOT PENUH KE PLAYER BARU
        socket.emit('joinRoomSuccess', { 
            roomId: room.id, roomName: room.name, hostId: room.hostId,
            players: room.players, playerCount: pCount,
            gameState: room.gameState, level: room.level, 
            zombies: room.zombies, walls: room.walls, 
            campfireHp: room.campfireHp, maxCampfireHp: room.maxCampfireHp,
            teamCoin: room.teamCoin
        });
        
        // 2. BERITAHU PLAYER LAMA ADA YANG MASUK
        socket.broadcast.to(roomId).emit('playerJoined', {
            player: room.players[socket.id],
            playerCount: pCount
        });
        
        io.emit('roomListUpdated');
    });

  socket.on('requestRespawn', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            let p = room.players[socket.id];
            if (p) {
                p.hp = 100; p.isDowned = false; p.x = (Math.random() - 0.5) * 10; p.z = 20 + (Math.random() - 0.5) * 10;
                io.to(socket.roomId).emit('playerHpUpdate', { id: socket.id, hp: 100 });
                socket.emit('respawnApproved', p);
            }
        }
    });

 socket.on('startGame', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            
            // --- VALIDASI SERVER AUTHORITATIVE KHUSUS HOST ---
            if (socket.id !== room.hostId) {
                return socket.emit('roomError', 'Akses ditolak: Hanya Host yang bisa memulai game.');
            }

            if (room.gameState === 'LOBBY') {
                room.gameState = 'PLAYING'; room.level = 1; room.campfireHp = 200; 
                spawnZombies(room);
                Object.values(room.players).forEach(p => { 
                    p.hp = 100; p.isDowned = false; 
                    io.to(socket.roomId).emit('playerHpUpdate', { id: p.id, hp: p.hp }); 
                });
                io.to(socket.roomId).emit('gameStarted', room.level);
            }
        }
    });

    socket.on('playerMove', (data) => {
        if (socket.roomId && rooms[socket.roomId]) {
            let p = rooms[socket.roomId].players[socket.id];
            if (p) {
                p.x = data.x; p.y = data.y; p.z = data.z; p.rotationY = data.rotationY;
                
                // SinkronisasiAuthoritaitve Lambat (Speed 100-600) authoritaitve authoritaitve
                // Movement dikirimauthoritaitve lambat, player lain melihat lambatauthoritaitve authoritaitve
                socket.broadcast.to(socket.roomId).emit('playerMoved', p);
            }
        }
    });

    socket.on('playerShootVisual', () => {
        if (socket.roomId) socket.broadcast.to(socket.roomId).emit('otherPlayerShot', socket.id);
    });

    socket.on('playerAction', (data) => {
        if (socket.roomId) {
            socket.broadcast.to(socket.roomId).emit('otherPlayerAction', { id: socket.id, action: data.action });
        }
    });

    socket.on('shootZombie', (data) => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            let z = room.zombies[data.id];
            let player = room.players[socket.id];
            
            if (z && player) {
                let distToZombie = Math.hypot(player.x - z.x, player.z - z.z);
                if (distToZombie > 300) return;

                let wDmg = Number(data.damage) || 1;
                let damage = wDmg;
                if (data.part === 'head') damage = wDmg * 3;
                else if (data.part === 'legs') damage = wDmg * 0.5;

                if (!z.damageTrack) z.damageTrack = {};
                z.damageTrack[socket.id] = (z.damageTrack[socket.id] || 0) + damage;

                z.hp -= damage;
                let hitPt = data.hitPoint || { x: z.x, y: 5, z: z.z };
                io.to(socket.roomId).emit('spawnDamageIndicator', { x: hitPt.x, y: hitPt.y + 1, z: hitPt.z, dmg: Math.floor(damage), color: '#ffff00' });

                if (z.hp <= 0) {
                    let tCoin = 0;
                    let baseXP = 0;
                    if (z.type === 'boss') { tCoin = 500; baseXP = 500; }
                    else if (z.type === 'kuat') { tCoin = 50; baseXP = 100; }
                    else if (z.type === 'fast') { tCoin = 35; baseXP = 70; }
                    else { tCoin = 25; baseXP = 50; }

                    room.teamCoin = (room.teamCoin || 0) + tCoin;
                    io.to(socket.roomId).emit('syncTeamCoin', room.teamCoin);

                    let totalDmgDone = 0;
                    for (let pid in z.damageTrack) totalDmgDone += z.damageTrack[pid];

                    for (let pid in z.damageTrack) {
                        if (room.players[pid]) {
                            let ratio = z.damageTrack[pid] / totalDmgDone;
                            let earnedXp = Math.floor(ratio * baseXP);
                            
                            if (pid === socket.id) {
                                let killBonus = z.type === 'boss' ? 100 : (z.type === 'kuat' ? 20 : (z.type === 'fast' ? 15 : 10));
                                earnedXp += killBonus;
                            }

                            room.players[pid].xp = (room.players[pid].xp || 0) + earnedXp;

                            let pXp = room.players[pid].xp;
                            let pLv = 1;
                            if (pXp >= 6500) pLv = 10;
                            else if (pXp >= 5200) pLv = 9;
                            else if (pXp >= 4000) pLv = 8;
                            else if (pXp >= 3000) pLv = 7;
                            else if (pXp >= 2200) pLv = 6;
                            else if (pXp >= 1500) pLv = 5;
                            else if (pXp >= 1000) pLv = 4;
                            else if (pXp >= 600) pLv = 3;
                            else if (pXp >= 250) pLv = 2;

                            room.players[pid].level = pLv;
                            io.to(pid).emit('syncPersonalXp', { xp: pXp, level: pLv });
                        }
                    }

                    delete room.zombies[data.id];
                    io.to(socket.roomId).emit('zombieDied', data.id);

                    if (Object.keys(room.zombies).length === 0) {
                        room.level++;
                        if (room.level > 99) room.level = 99;
                        io.to(socket.roomId).emit('waveCleared', { nextLevel: room.level, cooldown: 45 });

                        setTimeout(() => {
                            if (room.gameState === 'PLAYING') {
                                spawnZombies(room);
                                io.to(socket.roomId).emit('levelUp', room.level);
                            }
                        }, 45000);
                    }
                } else {
                    io.to(socket.roomId).emit('zombieHit', { id: data.id, hp: z.hp, maxHp: z.maxHp });
                }
            }
        }
    });

// --- SINKRONISASI REVIVE 6 DETIK (PHASE 2 AUTHORITATIVE) ---
    socket.on('reviveHoldingAction', (data) => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        let room = rooms[roomId];
        let reviver = room.players[socket.id];
        let target = room.players[data.targetId];

        if (!reviver || !target || !target.isDowned || reviver.isDowned) return;

        // 1. Cek Jarak Valid (Authoritative)
        let dx = reviver.x - target.x;
        let dz = reviver.z - target.z;
        let dist = Math.sqrt(dx*dx + dz*dz);

        if (dist > REVIVE_DISTANCE) {
            delete roomReviveProgress[target.id];
            io.to(roomId).emit('stopReviveSinkron', { targetId: target.id, remainingBleed: target.bleedTimeRemaining });
            return;
        }

        // 2. Inisialisasi State Revive jika belum ada
        if (!roomReviveProgress[target.id] || roomReviveProgress[target.id].reviverId !== socket.id) {
            roomReviveProgress[target.id] = {
                reviverId: socket.id,
                startX: reviver.x,
                startZ: reviver.z,
                progress: 0
            };
        }

        let reviveData = roomReviveProgress[target.id];

        // 3. Syarat: Penolong harus DIAM (Toleransi Pergerakan)
        let moveX = Math.abs(reviver.x - reviveData.startX);
        let moveZ = Math.abs(reviver.z - reviveData.startZ);
        if (moveX > MOVEMENT_TOLERANCE || moveZ > MOVEMENT_TOLERANCE) {
            delete roomReviveProgress[target.id];
            io.to(roomId).emit('stopReviveSinkron', { targetId: target.id, remainingBleed: target.bleedTimeRemaining });
            return;
        }

        // 4. Tambah Progress (6 detik = 100%)
        reviveData.progress += (100 / (REVIVE_TIME_SEC * 10));

        if (reviveData.progress >= 100) {
            // BERHASIL REVIVE!
            target.isDowned = false;
            target.hp = 30; // Bangkit dengan HP 30
            delete roomReviveProgress[target.id];

            io.to(roomId).emit('revived', { id: target.id, hp: target.hp });
        } else {
            // KIRIM PROGRESS KE CLIENT
            io.to(roomId).emit('reviveProgress', {
                targetId: target.id,
                progress: reviveData.progress,
                remainingBleed: target.bleedTimeRemaining
            });
        }
    });

    // Batal Revive pas lepas tombol [C]
    socket.on('stopReviveAction', () => {
        let roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        for (let tId in roomReviveProgress) {
            if (roomReviveProgress[tId].reviverId === socket.id) {
                let target = rooms[roomId].players[tId];
                let remainingBleed = target ? target.bleedTimeRemaining : 0;

                delete roomReviveProgress[tId];
                io.to(roomId).emit('stopReviveSinkron', { targetId: tId, remainingBleed: remainingBleed });
                break;
            }
        }
    });


   

 

  

    
  socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            
            // Simpan nama sebelum dihapus untuk notifikasi
            let pName = room.players[socket.id] ? room.players[socket.id].username : 'Player';
            
            delete room.players[socket.id];
            let pCount = Object.keys(room.players).length;

            if (pCount === 0) { 
                // Room kosong, hapus
                delete rooms[socket.roomId]; 
                io.emit('roomListUpdated'); 
            } else {
                // Handle Host Migration jika yang keluar adalah Host
                if (socket.id === room.hostId) {
                    // Berikan title Host ke player pertama yang masih ada di room
                    room.hostId = Object.keys(room.players)[0];
                }

                // Beritahu client lain siapa yang keluar dan siapa Host baru
                io.to(socket.roomId).emit('playerLeft', { 
                    id: socket.id, 
                    name: pName, 
                    playerCount: pCount, 
                    newHostId: room.hostId 
                });
            }
        }
    });


const PORT = process.env.PORT || 8080;
http.listen(PORT, '0.0.0.0', () => { console.log(`Server jalan di port ${PORT}`); });
