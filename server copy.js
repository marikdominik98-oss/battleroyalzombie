const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// === KONFIGURACE ===
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 4;
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 1200;

// === SERVER STAV ===
let rooms = {}; 
let gameIntervals = {}; 

// === MIDDLEWARE ===
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === SOCKET.IO HANDLERY ===
io.on('connection', (socket) => {
    console.log(`👤 Hráč připojen: ${socket.id}`);
    
    socket.on('createRoom', () => handleCreateRoom(socket));
    socket.on('joinRoom', (roomId) => handleJoinRoom(socket, roomId));
    socket.on('playerInput', (inputData) => handlePlayerInput(socket, inputData));
    socket.on('shoot', (shootData) => handleShoot(socket, shootData));
    socket.on('playerDied', (playerId) => handlePlayerDeath(socket, playerId));
    socket.on('restartGame', () => handleRestartGame(socket));
    socket.on('disconnect', () => handleDisconnect(socket));

    // === FUNKCE HANDLERŮ ===
    function handleCreateRoom(clientSocket) {
        const roomId = generateRoomId();
        
        rooms[roomId] = {
            players: {},
            bots: [],
            gameState: initializeGameState(),
            started: false,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            hostId: clientSocket.id,
            autoStartTimer: null
        };

        // ✅ OPRAVENO: Přidej socket do room PŘED přidáním hráče
        clientSocket.join(roomId);
        
        // Přidej hráče do room objektu
        const spawnPositions = [
            {x: 100, y: 100}, {x: WORLD_WIDTH - 100, y: 100},
            {x: 100, y: WORLD_HEIGHT - 100}, {x: WORLD_WIDTH - 100, y: WORLD_HEIGHT - 100}
        ];

        rooms[roomId].players[clientSocket.id] = {
            id: clientSocket.id,
            name: `Hráč 1`,
            x: spawnPositions[0].x,
            y: spawnPositions[0].y,
            width: 20,
            height: 20,
            health: 100,
            maxHealth: 100,
            speed: 4,
            color: generatePlayerColor(),
            ready: true,
            lastShot: 0,
            alive: true,
            lastInputTime: Date.now()
        };
        
        clientSocket.emit('roomCreated', { roomId, players: rooms[roomId].players });
        console.log(`📡 Vytvořena místnost: ${roomId}`);
        updateRoomPlayers(roomId);
    }

    function handleJoinRoom(clientSocket, roomId) {
        roomId = roomId.toUpperCase();
        
        if (!rooms[roomId]) {
            clientSocket.emit('error', 'Místnost neexistuje!');
            return;
        }

        const room = rooms[roomId];
        const currentPlayerCount = Object.keys(room.players).length;

        if (currentPlayerCount >= room.maxPlayers) {
            clientSocket.emit('error', 'Místnost je plná!');
            return;
        }

        // ✅ OPRAVENO: Přidej socket do room PŘED přidáním hráče
        clientSocket.join(roomId);

        const spawnPositions = [
            {x: 100, y: 100}, {x: WORLD_WIDTH - 100, y: 100},
            {x: 100, y: WORLD_HEIGHT - 100}, {x: WORLD_WIDTH - 100, y: WORLD_HEIGHT - 100}
        ];

        room.players[clientSocket.id] = {
            id: clientSocket.id,
            name: `Hráč ${currentPlayerCount + 1}`,
            x: spawnPositions[currentPlayerCount % spawnPositions.length].x,
            y: spawnPositions[currentPlayerCount % spawnPositions.length].y,
            width: 20,
            height: 20,
            health: 100,
            maxHealth: 100,
            speed: 4,
            color: generatePlayerColor(),
            ready: true,
            lastShot: 0,
            alive: true,
            lastInputTime: Date.now()
        };
        
        clientSocket.emit('roomJoined', { roomId, players: room.players });
        console.log(`🔗 Hráč ${clientSocket.id} se připojil do ${roomId}`);
        
        updateRoomPlayers(roomId);

        if (currentPlayerCount + 1 >= 2 && !room.autoStartTimer) {
            room.autoStartTimer = setTimeout(() => {
                if (!room.started && Object.keys(room.players).length >= 2) {
                    startGame(roomId);
                }
            }, 5000);
            
            let countdown = 5;
            const countdownInterval = setInterval(() => {
                io.to(roomId).emit('autoStartCountdown', { countdown });
                countdown--;
                if (countdown < 0) clearInterval(countdownInterval);
            }, 1000);
        }
    }

    function handlePlayerInput(clientSocket, inputData) {
        const roomId = getRoomIdFromSocket(clientSocket);
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players[clientSocket.id];
        if (!player || !player.alive) return;

        if (Date.now() - player.lastInputTime > 16) { // 60 FPS
            const { keys } = inputData;
            let newX = player.x;
            let newY = player.y;

            if (keys['w']) newY -= player.speed;
            if (keys['s']) newY += player.speed;
            if (keys['a']) newX -= player.speed;
            if (keys['d']) newX += player.speed;

            const proposedRect = { x: newX, y: newY, width: player.width, height: player.height };
            if (!checkCollisionWithObstacles(proposedRect, room.gameState.obstacles)) {
                player.x = newX;
                player.y = newY;
            }

            player.x = Math.max(0, Math.min(WORLD_WIDTH - player.width, player.x));
            player.y = Math.max(0, Math.min(WORLD_HEIGHT - player.height, player.y));
            
            player.lastInputTime = Date.now();
        }
    }

    function handleShoot(clientSocket, shootData) {
        const roomId = getRoomIdFromSocket(clientSocket);
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players[clientSocket.id];
        if (!player || !player.alive || Date.now() - player.lastShot < 150) return;

        const { mouseWorldX, mouseWorldY, timestamp } = shootData;
        
        if (Math.abs(Date.now() - timestamp) > 100) return;

        const angle = Math.atan2(mouseWorldY - (player.y + 10), mouseWorldX - (player.x + 10));
        
        room.gameState.bullets.push({
            id: `${clientSocket.id}_${Date.now()}`,
            x: player.x + 10, y: player.y + 10,
            vx: Math.cos(angle) * 10, vy: Math.sin(angle) * 10,
            life: 90, damage: 15, width: 4, height: 4,
            ownerId: clientSocket.id, timestamp: Date.now()
        });

        player.lastShot = Date.now();
    }

    function handlePlayerDeath(clientSocket, playerId) {
        const roomId = getRoomIdFromSocket(clientSocket);
        if (!roomId || !rooms[roomId] || clientSocket.id !== playerId) return;

        const room = rooms[roomId];
        if (room.players[playerId]) {
            room.players[playerId].alive = false;
            room.players[playerId].health = 0;
            console.log(`💀 Hráč ${playerId} zemřel v ${roomId}`);
            checkGameEndCondition(roomId);
        }
    }

    function handleRestartGame(clientSocket) {
        const roomId = getRoomIdFromSocket(clientSocket);
        if (!roomId || !rooms[roomId] || clientSocket.id !== rooms[roomId].hostId) {
            clientSocket.emit('error', 'Pouze host může restartovat!');
            return;
        }
        restartRoom(roomId);
    }

    function handleDisconnect(clientSocket) {
        Object.keys(rooms).forEach(roomId => {
            const room = rooms[roomId];
            if (room && room.players[clientSocket.id]) {
                delete room.players[clientSocket.id];
                console.log(`👋 Hráč ${clientSocket.id} opustil ${roomId}`);
                updateRoomPlayers(roomId);
                
                if (room.started && Object.keys(room.players).length === 0) {
                    cleanupRoom(roomId);
                }
                
                if (room.autoStartTimer) {
                    clearTimeout(room.autoStartTimer);
                    room.autoStartTimer = null;
                }
            }
        });
    }

    // === POMOCNÉ FUNKCE ===
    function getRoomIdFromSocket(socket) {
        for (const roomId in rooms) {
            if (rooms[roomId] && rooms[roomId].players[socket.id]) {
                return roomId;
            }
        }
        return null;
    }

    function updateRoomPlayers(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        // ✅ OPRAVENO: Použij room namespace pro broadcast
        io.to(roomId).emit('playerJoined', { players: room.players });
        console.log(`📡 Aktualizace hráčů v ${roomId}: ${Object.keys(room.players).length} hráčů`);
    }

    function checkGameEndCondition(roomId) {
        const room = rooms[roomId];
        if (!room || !room.started) return;

        const alivePlayers = Object.values(room.players).filter(p => p.alive).length;
        const aliveBots = room.bots.filter(b => b.health > 0).length;
        const totalAlive = alivePlayers + aliveBots;
        
        if (totalAlive <= 1) {
            const winner = Object.values(room.players).find(p => p.alive) || 
                          room.bots.find(b => b.health > 0);
            const message = winner 
                ? `🏆 ${winner.name || 'Voják'} vyhrál!` 
                : 'Hra skončila remízou!';
            
            endGame(roomId, message);
        }
    }

    function initializeGameState() {
        return {
            bullets: [],
            zombies: [],
            particles: [],
            obstacles: generateObstacles(),
            bunkers: generateBunkers(),
            helicopter: null,
            score: 0,
            lastZombieHorde: Date.now(),
            lastZoneShrink: Date.now(),
            safeZone: { 
                x: WORLD_WIDTH/2 + Math.random() * 200 - 100, 
                y: WORLD_HEIGHT/2 + Math.random() * 200 - 100, 
                radius: 600 
            },
            zoneDamage: 2
        };
    }

    function generateObstacles() {
        const obstacles = [];
        for (let i = 0; i < 40; i++) {
            let x, y, width, height, validPosition = false;
            
            for (let attempt = 0; attempt < 20; attempt++) {
                x = Math.random() * WORLD_WIDTH;
                y = Math.random() * WORLD_HEIGHT;
                width = 20 + Math.random() * 60;
                height = 20 + Math.random() * 60;
                
                const proposedRect = { x, y, width, height };
                if (!checkCollisionWithObstacles(proposedRect, obstacles)) {
                    validPosition = true;
                    break;
                }
            }
            
            if (validPosition) {
                obstacles.push({ 
                    x, y, width, height, 
                    color: '#8B4513', health: 150, maxHealth: 150 
                });
            }
        }
        return obstacles;
    }

    function generateBunkers() {
        const bunkers = [];
        for (let i = 0; i < 4; i++) {
            let x, y, validPosition = false;
            
            for (let attempt = 0; attempt < 20; attempt++) {
                x = Math.random() * WORLD_WIDTH;
                y = Math.random() * WORLD_HEIGHT;
                
                const proposedRect = { x, y, width: 80, height: 80 };
                if (!checkCollisionWithObstacles(proposedRect, bunkers)) {
                    validPosition = true;
                    break;
                }
            }
            
            if (validPosition) {
                bunkers.push({ x, y, width: 80, height: 80, color: '#808080' });
            }
        }
        return bunkers;
    }

    function generatePlayerColor() {
        const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#eb4d4b'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    function generateRoomId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    function checkCollision(rect1, rect2) {
        return rect1.x < rect2.x + rect2.width &&
               rect1.x + (rect1.width || 4) > rect2.x &&
               rect1.y < rect2.y + rect2.height &&
               rect1.y + (rect1.height || 4) > rect2.y;
    }

    function checkCollisionWithObstacles(rect, obstacles) {
        return obstacles.some(obstacle => 
            obstacle.health > 0 && checkCollision(rect, obstacle)
        );
    }

    // === KOMPLETNÍ GAME LOGIC ===
    function startGame(roomId) {
        const room = rooms[roomId];
        if (!room || room.started) return;

        console.log(`🎮 Spuštěna hra v místnosti ${roomId} (${Object.keys(room.players).length} hráčů)`);
        
        room.started = true;
        
        // Spawn botů
        const numBots = Math.max(0, 6 - Object.keys(room.players).length * 2);
        spawnBots(room, numBots);
        
        // Spawn počátečních zombie
        spawnZombieHorde(roomId, 5);
        
        // ✅ OPRAVENO: Kompletní synchronizace dat při startu
        const gameStartData = {
            players: room.players,
            bots: room.bots,
            bullets: room.gameState.bullets,
            zombies: room.gameState.zombies,
            particles: room.gameState.particles,
            obstacles: room.gameState.obstacles,
            bunkers: room.gameState.bunkers,
            helicopter: room.gameState.helicopter,
            score: room.gameState.score,
            lastZombieHorde: room.gameState.lastZombieHorde,
            lastZoneShrink: room.gameState.lastZoneShrink,
            safeZone: room.gameState.safeZone,
            zoneDamage: room.gameState.zoneDamage
        };
        
        console.log(`📡 Odesílám gameStart do ${roomId} - Hráči: ${Object.keys(room.players).length}, Boty: ${room.bots.length}`);
        io.to(roomId).emit('gameStart', gameStartData);

        // Spusť herní smyčku
        gameIntervals[roomId] = setInterval(() => updateGame(roomId), 1000 / 60);
    }

    function updateGame(roomId) {
        const room = rooms[roomId];
        if (!room || !room.started) return;

        // UPDATE VŠECH SYSTÉMŮ
        updateBots(room);
        updateBullets(roomId);
        updateZombies(room);
        updateSafeZone(room);
        updateParticles(room);

        // Zónové poškození
        Object.values(room.players).forEach(player => {
            if (player.alive) applyZoneDamage(player, room.gameState);
        });
        room.bots.forEach(bot => applyZoneDamage(bot, room.gameState));
        room.gameState.zombies.forEach(zombie => applyZoneDamage(zombie, room.gameState));

        // Check game over
        Object.keys(room.players).forEach(playerId => {
            const player = room.players[playerId];
            if (player && player.alive && player.health <= 0) {
                player.alive = false;
                io.to(roomId).emit('playerDied', { playerId, health: 0 });
                checkGameEndCondition(roomId);
            }
        });

        checkHelicopter(room);

        // ✅ OPRAVENO: Jednotný gameUpdate pro všechny
        const gameUpdate = {
            players: {},
            bots: room.bots,
            bullets: room.gameState.bullets,
            zombies: room.gameState.zombies,
            particles: room.gameState.particles.slice(0, 50),
            obstacles: room.gameState.obstacles,
            bunkers: room.gameState.bunkers,
            safeZone: room.gameState.safeZone,
            helicopter: room.gameState.helicopter,
            score: room.gameState.score
        };

        // Přidej všechny hráče do updatu
        Object.keys(room.players).forEach(playerId => {
            if (room.players[playerId].alive) {
                gameUpdate.players[playerId] = {
                    x: room.players[playerId].x,
                    y: room.players[playerId].y,
                    health: room.players[playerId].health,
                    color: room.players[playerId].color,
                    name: room.players[playerId].name,
                    width: 20,
                    height: 20
                };
            }
        });
        
        // ✅ OPRAVENO: Broadcast do celé místnosti
        io.to(roomId).emit('gameUpdate', gameUpdate);
    }

    // Zbytek funkcí bez změny...
    function updateBots(room) {
        room.bots = room.bots.filter(bot => {
            aiMove(bot, room);
            
            if (Date.now() - bot.lastShot > 1000) {
                const target = findNearestZombie(bot, room.gameState.zombies);
                if (target) {
                    shoot(bot, target, room);
                    bot.lastShot = Date.now();
                }
            }

            for (let i = room.gameState.zombies.length - 1; i >= 0; i--) {
                if (checkCollision(bot, room.gameState.zombies[i])) {
                    bot.health -= 10;
                    createExplosion(bot.x, bot.y, '#00ff00', room);
                    
                    if (bot.health <= 0) {
                        createSuperZombie(bot.x, bot.y, room);
                        return false;
                    }
                    break;
                }
            }

            Object.values(room.players).forEach(player => {
                if (player.alive && checkCollision(bot, player)) {
                    player.health -= 5;
                }
            });

            return bot.health > 0;
        });
    }

    function aiMove(bot, room) {
        bot.wanderTimer += 16;
        
        const distToCenter = Math.hypot(room.gameState.safeZone.x - bot.x, room.gameState.safeZone.y - bot.y);
        if (distToCenter > room.gameState.safeZone.radius + 50) {
            const dx = room.gameState.safeZone.x - bot.x;
            const dy = room.gameState.safeZone.y - bot.y;
            const distance = Math.hypot(dx, dy);
            if (distance > 0) {
                let newX = bot.x + (dx / distance) * bot.speed * 2;
                let newY = bot.y + (dy / distance) * bot.speed * 2;
                if (!checkCollisionWithObstacles({x: newX, y: newY, width: bot.width, height: bot.height}, room.gameState.obstacles)) {
                    bot.x = newX;
                    bot.y = newY;
                }
            }
        } else {
            if (bot.wanderTimer > 2000) {
                bot.wanderDirection = { x: Math.random() - 0.5, y: Math.random() - 0.5 };
                bot.wanderTimer = 0;
            }
            
            let newX = bot.x + bot.wanderDirection.x * bot.speed * 1.5;
            let newY = bot.y + bot.wanderDirection.y * bot.speed * 1.5;
            
            if (!checkCollisionWithObstacles({x: newX, y: newY, width: bot.width, height: bot.height}, room.gameState.obstacles)) {
                bot.x = newX;
                bot.y = newY;
            }
        }
        
        bot.x = Math.max(0, Math.min(WORLD_WIDTH - bot.width, bot.x));
        bot.y = Math.max(0, Math.min(WORLD_HEIGHT - bot.height, bot.y));
    }

    function spawnBots(room, count) {
        room.bots = [];
        for (let i = 0; i < count; i++) {
            let x, y;
            do {
                x = Math.random() * WORLD_WIDTH;
                y = Math.random() * WORLD_HEIGHT;
            } while (checkCollisionWithObstacles({x, y, width: 20, height: 20}, room.gameState.obstacles));

            room.bots.push({
                x, y, width: 20, height: 20, health: 100, maxHealth: 100,
                speed: 2 + Math.random(), color: '#00cc00', lastShot: 0,
                wanderDirection: { x: Math.random() - 0.5, y: Math.random() - 0.5 },
                wanderTimer: Math.random() * 2000,
                name: `Voják ${i + 1}`
            });
        }
        console.log(`🤖 Spawnováno ${count} botů`);
    }

    function updateZombies(room) {
        const roomId = Object.keys(rooms).find(id => rooms[id] === room);
        
        if (Date.now() - room.gameState.lastZombieHorde > 12000) {
            const hordeSize = Math.max(3, 8 - room.bots.length - Object.keys(room.players).length);
            spawnZombieHorde(roomId, hordeSize);
            room.gameState.lastZombieHorde = Date.now();
        }

        room.gameState.zombies = room.gameState.zombies.filter(zombie => {
            const nearestTarget = findNearestTarget(zombie, room.players, room.bots);
            if (nearestTarget) {
                const dx = nearestTarget.x - zombie.x;
                const dy = nearestTarget.y - zombie.y;
                const distance = Math.hypot(dx, dy);
                
                if (distance > 0) {
                    const moveX = (dx / distance) * zombie.speed;
                    const moveY = (dy / distance) * zombie.speed;
                    const newX = zombie.x + moveX;
                    const newY = zombie.y + moveY;
                    
                    if (!checkCollisionWithObstacles(
                        {x: newX, y: newY, width: zombie.width, height: zombie.height}, 
                        room.gameState.obstacles
                    )) {
                        zombie.x = newX;
                        zombie.y = newY;
                    }
                }
            }

            Object.values(room.players).forEach(player => {
                if (player.alive && checkCollision(player, zombie)) {
                    player.health -= zombie.damage || 1;
                    createExplosion(player.x, player.y, '#00ff00', room);
                }
            });

            room.bots.forEach(bot => {
                if (bot.health > 0 && checkCollision(bot, zombie)) {
                    bot.health -= zombie.damage || 1;
                    createExplosion(bot.x, bot.y, '#00ff00', room);
                }
            });

            return zombie.health > 0;
        });
    }

    function spawnZombieHorde(roomId, count) {
        const room = rooms[roomId];
        if (!room) return;
        
        for (let i = 0; i < count; i++) {
            const side = Math.floor(Math.random() * 4);
            let x, y;
            switch(side) {
                case 0: x = Math.random() * WORLD_WIDTH; y = -20; break;
                case 1: x = Math.random() * WORLD_WIDTH; y = WORLD_HEIGHT + 20; break;
                case 2: x = -20; y = Math.random() * WORLD_HEIGHT; break;
                case 3: x = WORLD_WIDTH + 20; y = Math.random() * WORLD_HEIGHT; break;
            }

            room.gameState.zombies.push({
                x, y, width: 15, height: 15, health: 50, maxHealth: 50,
                speed: 0.8 + Math.random() * 0.6,
                color: `hsl(${Math.random() * 30 + 180}, 70%, 40%)`,
                damage: 1
            });
        }
        console.log(`🧟‍♂️ Spawnováno ${count} zombie`);
    }

    function findNearestTarget(zombie, players, bots) {
        let nearest = null;
        let minDist = Infinity;

        Object.values(players).forEach(player => {
            if (player.alive && player.health > 0) {
                const dist = Math.hypot(player.x - zombie.x, player.y - zombie.y);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = player;
                }
            }
        });

        bots.forEach(bot => {
            if (bot.health > 0) {
                const dist = Math.hypot(bot.x - zombie.x, bot.y - zombie.y);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = bot;
                }
            }
        });

        return nearest;
    }

    function findNearestZombie(entity, zombies) {
        let nearest = null;
        let minDist = Infinity;
        zombies.forEach(z => {
            const dist = Math.hypot(z.x - entity.x, z.y - entity.y);
            if (dist < minDist && dist < 200) {
                minDist = dist;
                nearest = z;
            }
        });
        return nearest;
    }

    function shoot(shooter, target, room) {
        if (!target) return;
        const angle = Math.atan2(target.y - (shooter.y + 10), target.x - (shooter.x + 10));
        
        room.gameState.bullets.push({
            x: shooter.x + 10, y: shooter.y + 10,
            vx: Math.cos(angle) * 8, vy: Math.sin(angle) * 8,
            life: 60, damage: 10, width: 4, height: 4,
            ownerId: shooter.id || 'bot',
            timestamp: Date.now()
        });
    }

    function updateSafeZone(room) {
        if (Date.now() - room.gameState.lastZoneShrink > 10000) {
            room.gameState.safeZone.radius = Math.max(room.gameState.safeZone.radius - 20, 100);
            room.gameState.lastZoneShrink = Date.now();
        }
    }

    function updateParticles(room) {
        room.gameState.particles = room.gameState.particles.filter(particle => {
            particle.x += particle.vx;
            particle.y += particle.vy;
            particle.life--;
            particle.vy += 0.2;
            return particle.life > 0;
        });
    }

    function applyZoneDamage(entity, gameState) {
        if (!entity || !entity.health) return;
        
        const centerX = entity.x + (entity.width || 20) / 2;
        const centerY = entity.y + (entity.height || 20) / 2;
        
        const distToCenter = Math.hypot(
            centerX - gameState.safeZone.x,
            centerY - gameState.safeZone.y
        );
        
        if (distToCenter > gameState.safeZone.radius) {
            entity.health -= gameState.zoneDamage / 60;
            entity.health = Math.max(0, entity.health);
        }
    }

    function checkHelicopter(room) {
        const alivePlayers = Object.values(room.players).filter(p => p.alive).length;
        const aliveBots = room.bots.filter(b => b.health > 0).length;
        const totalAlive = alivePlayers + aliveBots;

        const roomId = Object.keys(rooms).find(id => rooms[id] === room);

        if (totalAlive === 1 && !room.gameState.helicopter) {
            spawnHelicopter(room);
            io.to(roomId).emit('message', '🚁 Helikoptéra přiletěla! Doběhni k ní pro vítězství!');
        }

        if (room.gameState.helicopter) {
            Object.values(room.players).forEach(player => {
                if (player.alive && checkCollision(player, room.gameState.helicopter)) {
                    endGame(roomId, `🏆 ${player.name} se dostal k helikoptéře! Vítězství!`);
                }
            });

            room.bots.forEach(bot => {
                if (bot.health > 0 && checkCollision(bot, room.gameState.helicopter)) {
                    endGame(roomId, `🤖 ${bot.name} se dostal k helikoptéře!`);
                }
            });
        }
    }

    function spawnHelicopter(room) {
        const corner = Math.floor(Math.random() * 4);
        let x, y;
        switch(corner) {
            case 0: x = 50; y = 50; break;
            case 1: x = WORLD_WIDTH - 110; y = 50; break;
            case 2: x = 50; y = WORLD_HEIGHT - 110; break;
            case 3: x = WORLD_WIDTH - 110; y = WORLD_HEIGHT - 110; break;
        }
        room.gameState.helicopter = { x, y, width: 60, height: 60 };
    }

    function createExplosion(x, y, color, room) {
        for (let i = 0; i < 12; i++) {
            room.gameState.particles.push({
                x, y, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 - 2,
                life: 30, size: Math.random() * 4 + 2, color
            });
        }
    }

    function createSuperZombie(x, y, room) {
        room.gameState.zombies.push({
            x, y, width: 30, height: 30, health: 200, maxHealth: 200,
            speed: 1.5 + Math.random() * 0.5, color: '#ff0000', damage: 2
        });
        room.gameState.score += 5;
        console.log('🧟‍♂️ SUPER ZOMBIE SPAWN!');
    }

    function updateBullets(roomId) {
        const room = rooms[roomId];
        room.gameState.bullets = room.gameState.bullets.filter(bullet => {
            if (Date.now() - bullet.timestamp > 1500) return false;
            
            bullet.x += bullet.vx;
            bullet.y += bullet.vy;
            bullet.life--;

            for (let i = room.gameState.obstacles.length - 1; i >= 0; i--) {
                const obstacle = room.gameState.obstacles[i];
                if (obstacle.health > 0 && checkCollision(bullet, obstacle)) {
                    obstacle.health -= bullet.damage || 10;
                    createExplosion(bullet.x, bullet.y, '#ffff00', room);
                    if (obstacle.health <= 0) {
                        room.gameState.obstacles.splice(i, 1);
                    }
                    return false;
                }
            }

            for (let i = room.gameState.zombies.length - 1; i >= 0; i--) {
                if (checkCollision(bullet, room.gameState.zombies[i])) {
                    room.gameState.zombies[i].health -= bullet.damage || 10;
                    createExplosion(room.gameState.zombies[i].x, room.gameState.zombies[i].y, '#ff0000', room);
                    room.gameState.score += 10;
                    if (room.gameState.zombies[i].health <= 0) {
                        room.gameState.zombies.splice(i, 1);
                    }
                    return false;
                }
            }

            for (let i = room.bots.length - 1; i >= 0; i--) {
                if (checkCollision(bullet, room.bots[i]) && room.bots[i].health > 0) {
                    room.bots[i].health -= bullet.damage || 10;
                    createExplosion(room.bots[i].x, room.bots[i].y, '#00ff00', room);
                    if (room.bots[i].health <= 0) {
                        createSuperZombie(room.bots[i].x, room.bots[i].y, room);
                        room.bots.splice(i, 1);
                    }
                    return false;
                }
            }

            Object.keys(room.players).forEach(playerId => {
                const player = room.players[playerId];
                if (player.alive && checkCollision(bullet, player) && bullet.ownerId !== playerId) {
                    player.health -= bullet.damage || 15;
                    createExplosion(player.x, player.y, '#ff6b6b', room);
                    return false;
                }
            });

            return bullet.life > 0 && 
                   bullet.x > 0 && bullet.x < WORLD_WIDTH && 
                   bullet.y > 0 && bullet.y < WORLD_HEIGHT;
        });
    }

    function endGame(roomId, message) {
        const room = rooms[roomId];
        if (!room) return;

        console.log(`🎯 Konec hry v ${roomId}: ${message}`);
        io.to(roomId).emit('gameOver', { message });
        
        if (gameIntervals[roomId]) {
            clearInterval(gameIntervals[roomId]);
            delete gameIntervals[roomId];
        }

        setTimeout(() => restartRoom(roomId), 10000);
    }

    function restartRoom(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        console.log(`🔄 Restart ${roomId}`);
        
        if (gameIntervals[roomId]) {
            clearInterval(gameIntervals[roomId]);
            delete gameIntervals[roomId];
        }

        Object.keys(room.players).forEach(playerId => {
            room.players[playerId].health = 100;
            room.players[playerId].alive = true;
            const spawnPos = [
                {x: 100, y: 100}, {x: WORLD_WIDTH - 100, y: 100},
                {x: 100, y: WORLD_HEIGHT - 100}, {x: WORLD_WIDTH - 100, y: WORLD_HEIGHT - 100}
            ][Object.keys(room.players).indexOf(playerId) % 4];
            room.players[playerId].x = spawnPos.x;
            room.players[playerId].y = spawnPos.y;
        });

        room.bots = [];
        room.gameState = initializeGameState();
        room.started = false;

        io.to(roomId).emit('gameRestarted', {
            players: room.players,
            gameState: room.gameState,
            bots: room.bots
        });
    }

    function cleanupRoom(roomId) {
        if (gameIntervals[roomId]) {
            clearInterval(gameIntervals[roomId]);
            delete gameIntervals[roomId];
        }
        if (rooms[roomId]?.autoStartTimer) {
            clearTimeout(rooms[roomId].autoStartTimer);
        }
        delete rooms[roomId];
        console.log(`🧹 Vyčištěna místnost ${roomId}`);
    }
});

// === SPAUŠTĚNÍ ===
server.listen(PORT, () => {
    console.log(`🚀 Server běží na portu ${PORT}`);
    console.log(`📱 http://localhost:${PORT}`);
    console.log(`🎮 Kompletní Battle Royale s boty, zombie, helikoptérou!`);
});

process.on('SIGTERM', () => {
    console.log('🛑 Ukončuji server...');
    Object.keys(gameIntervals).forEach(roomId => clearInterval(gameIntervals[roomId]));
    server.close(() => process.exit(0));
});