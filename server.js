const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",  // 🆕 Nech "*" pro všechny, ale pro produkci přidej tvůj Render URL: "https://tvoje-hra.onrender.com"
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],  // 🆕 Prioritizuj WebSocket, polling jako fallback
    pingTimeout: 60000,  // 🆕 Zvýš timeout pro Render (pomalé spojení)
    pingInterval: 25000
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

// === POMOCNÉ FUNKCE (přesunuté ven kvůli scope) ===
function generateRoomId() {
    return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').sort(() => Math.random() - 0.5).slice(0,6).join('');
}

function generatePlayerColor() {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function checkCollision(rect1, rect2) {
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + (rect1.width || 4) > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + (rect1.height || 4) > rect2.y;
}

function checkCollisionWithObstacles(rect, obstacles) {
    return obstacles.some(obstacle => obstacle.health > 0 && checkCollision(rect, obstacle));
}

// === GAME OBJECT FUNCTIONS (přesunuté ven kvůli scope) ===
function generateObstaclesAndBunkers(room) {
    room.obstacles = [];
    room.bunkers = [];

    for (let i = 0; i < 40; i++) {
        let x, y, width, height;
        do {
            x = Math.random() * WORLD_WIDTH;
            y = Math.random() * WORLD_HEIGHT;
            width = 20 + Math.random() * 60;
            height = 20 + Math.random() * 60;
        } while (checkCollisionWithObstacles({x, y, width, height}, room.obstacles));

        room.obstacles.push({ x, y, width, height, color: '#8B4513', health: 150, maxHealth: 150 });
    }

    for (let i = 0; i < 4; i++) {
        let x, y;
        do {
            x = Math.random() * WORLD_WIDTH;
            y = Math.random() * WORLD_HEIGHT;
        } while (checkCollisionWithObstacles({x, y, width: 80, height: 80}, room.obstacles));

        room.bunkers.push({ x, y, width: 80, height: 80, color: '#808080' });
    }
}

function spawnBots(room, numBots) {
    room.bots = [];
    let spawned = 0;
    for (let i = 0; i < numBots && spawned < numBots; i++) {
        let attempts = 0;
        let x, y;
        do {
            x = 50 + Math.random() * (WORLD_WIDTH - 100);
            y = 50 + Math.random() * (WORLD_HEIGHT - 100);
            attempts++;
            if (attempts > 50) break;
        } while (checkCollisionWithObstacles({x, y, width: 20, height: 20}, room.obstacles) && attempts < 50);

        if (attempts <= 50) {
            room.bots.push({
                x, y,
                width: 20,
                height: 20,
                health: 100,
                maxHealth: 100,
                speed: 2 + Math.random(),
                color: '#00cc00',
                lastShot: 0,
                wanderDirection: { x: Math.random() - 0.5, y: Math.random() - 0.5 },
                wanderTimer: Math.random() * 2000,
                name: `Voják ${spawned + 1}`,
                alive: true
            });
            spawned++;
        }
    }
    console.log(`🤖 Spawnováno ${spawned}/${numBots} botů (pokusy: OK)`);
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

        room.zombies.push({
            x, y,
            width: 15,
            height: 15,
            health: 50 * room.zombieHealthMultiplier,
            maxHealth: 50 * room.zombieHealthMultiplier,
            speed: 0.8 + Math.random() * 0.6,
            color: `hsl(${Math.random() * 30 + 180}, 70%, 40%)`,
            damage: 1
        });
    }
    console.log(`🧟 Spawnováno ${count} zombie (multi: ${room.zombieHealthMultiplier})`);
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
    room.helicopter = { x, y, width: 60, height: 60 };
}

function updateBots(room) {
    room.bots = room.bots.filter(bot => {
        if (!bot.alive) return false;

        aiMove(bot, room);
        if (Date.now() - bot.lastShot > 1000) {
            const target = findNearestZombie(bot, room.zombies);
            if (target) {
                shoot(bot, target, room);
                bot.lastShot = Date.now();
            }
        }

        // Zombie collision
        for (let i = room.zombies.length - 1; i >= 0; i--) {
            if (checkCollision(bot, room.zombies[i])) {
                bot.health -= 10;
                createExplosion(bot.x, bot.y, '#00ff00', room);
                if (bot.health <= 0) {
                    createSuperZombie(bot.x, bot.y, room);
                    bot.alive = false;
                    return false;
                }
                break;
            }
        }

        applyZoneDamage(bot, room);
        return bot.health > 0;
    });
}

function updateBullets(room) {
    room.bullets = room.bullets.filter(bullet => {
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;
        bullet.life--;

        // Obstacles collision
        for (let i = room.obstacles.length - 1; i >= 0; i--) {
            const obstacle = room.obstacles[i];
            if (obstacle.health > 0 && checkCollision(bullet, obstacle)) {
                obstacle.health -= bullet.damage || 10;
                createExplosion(bullet.x, bullet.y, '#ffff00', room);
                if (obstacle.health <= 0) {
                    room.obstacles.splice(i, 1);
                }
                return false;
            }
        }

        // Zombies collision
        for (let i = room.zombies.length - 1; i >= 0; i--) {
            if (checkCollision(bullet, room.zombies[i])) {
                room.zombies[i].health -= bullet.damage || 10;
                createExplosion(room.zombies[i].x, room.zombies[i].y, '#ff0000', room);
                if (room.zombies[i].health <= 0) {
                    room.zombies.splice(i, 1);
                    room.score += 10;
                }
                return false;
            }
        }

        return bullet.life > 0 && bullet.x > 0 && bullet.x < WORLD_WIDTH && bullet.y > 0 && bullet.y < WORLD_HEIGHT;
    });
}

function updateZombies(room) {
    room.zombies = room.zombies.filter(zombie => {
        const target = findNearestSoldier(zombie, room.players, room.bots);
        if (target) {
            const dx = target.x - zombie.x;
            const dy = target.y - zombie.y;
            const distance = Math.hypot(dx, dy);
            if (distance > 0) {
                let newX = zombie.x + (dx / distance) * zombie.speed;
                let newY = zombie.y + (dy / distance) * zombie.speed;
                if (!checkCollisionWithObstacles({x: newX, y: newY, width: zombie.width, height: zombie.height}, room.obstacles)) {
                    zombie.x = newX;
                    zombie.y = newY;
                }
            }
        }

        // Player collision
        Object.values(room.players).forEach(player => {
            if (player.alive && checkCollision(player, zombie)) {
                player.health -= zombie.damage || 1;
                createExplosion(player.x, player.y, '#00ff00', room);
            }
        });

        // Bots collision
        room.bots.forEach(bot => {
            if (bot.alive && checkCollision(bot, zombie)) {
                bot.health -= zombie.damage || 1;
                createExplosion(bot.x, bot.y, '#00ff00', room);
            }
        });

        applyZoneDamage(zombie, room);
        return zombie.health > 0;
    });
}

function updateParticles(room) {
    room.particles = room.particles.filter(particle => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.life--;
        particle.vy += 0.2;
        return particle.life > 0;
    });
}

function aiMove(bot, room) {
    bot.wanderTimer += 16;
    const distToCenter = Math.hypot(room.safeZone.x - bot.x, room.safeZone.y - bot.y);
    if (distToCenter > room.safeZone.radius + 50) {
        const dx = room.safeZone.x - bot.x;
        const dy = room.safeZone.y - bot.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0) {
            let newX = bot.x + (dx / distance) * bot.speed * 2;
            let newY = bot.y + (dy / distance) * bot.speed * 2;
            if (!checkCollisionWithObstacles({x: newX, y: newY, width: bot.width, height: bot.height}, room.obstacles)) {
                bot.x = newX;
                bot.y = newY;
            }
        }
    } else {
        if (bot.wanderTimer > 2000) {
            bot.wanderDirection.x = Math.random() - 0.5;
            bot.wanderDirection.y = Math.random() - 0.5;
            bot.wanderTimer = 0;
        }
        let newX = bot.x + bot.wanderDirection.x * bot.speed * 1.5;
        let newY = bot.y + bot.wanderDirection.y * bot.speed * 1.5;
        if (!checkCollisionWithObstacles({x: newX, y: newY, width: bot.width, height: bot.height}, room.obstacles)) {
            bot.x = newX;
            bot.y = newY;
        }
    }
    bot.x = Math.max(0, Math.min(WORLD_WIDTH - bot.width, bot.x));
    bot.y = Math.max(0, Math.min(WORLD_HEIGHT - bot.height, bot.y));
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

function findNearestSoldier(zombie, players, bots) {
    let nearest = null;
    let minDist = Infinity;

    // Players
    Object.values(players).forEach(player => {
        if (player.alive) {
            const dist = Math.hypot(player.x - zombie.x, player.y - zombie.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = player;
            }
        }
    });

    // Bots
    bots.forEach(bot => {
        if (bot.alive) {
            const dist = Math.hypot(bot.x - zombie.x, bot.y - zombie.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = bot;
            }
        }
    });

    return nearest;
}

function applyZoneDamage(entity, room) {
    if (!entity || !entity.health) return;
    const distToCenter = Math.hypot(
        entity.x + (entity.width || 20)/2 - room.safeZone.x,
        entity.y + (entity.height || 20)/2 - room.safeZone.y
    );
    if (distToCenter > room.safeZone.radius) {
        entity.health -= room.zoneDamage / 60;
    }
}

function createSuperZombie(x, y, room) {
    room.zombies.push({
        x, y,
        width: 30,
        height: 30,
        health: 200 * room.zombieHealthMultiplier,
        maxHealth: 200 * room.zombieHealthMultiplier,
        speed: 1.5 + Math.random() * 0.5,
        color: '#ff0000',
        damage: 2
    });
    room.score += 5;
}

function shoot(shooter, target, room) {
    if (!target) return;
    const angle = Math.atan2(target.y - (shooter.y + 10), target.x - (shooter.x + 10));
    room.bullets.push({
        x: shooter.x + 10,
        y: shooter.y + 10,
        vx: Math.cos(angle) * 8,
        vy: Math.sin(angle) * 8,
        life: 60,
        damage: 10,
        ownerId: shooter.id || 'bot'
    });
}

function createExplosion(x, y, color, room) {
    for (let i = 0; i < 12; i++) {
        room.particles.push({
            x, y,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8 - 2,
            life: 30,
            size: Math.random() * 4 + 2,
            color
        });
    }
}

// === SOCKET.IO HANDLERY ===
io.on('connection', (socket) => {
    console.log(`👤 Hráč připojen: ${socket.id}`);
    
    socket.on('createRoom', (data) => handleCreateRoom(socket, data));
    socket.on('joinRoom', (data) => handleJoinRoom(socket, data));
    socket.on('playerInput', (inputData) => handlePlayerInput(socket, inputData));
    socket.on('shoot', (shootData) => handleShoot(socket, shootData));
    socket.on('startGame', () => handleStartGame(socket));
    socket.on('restartGame', () => handleRestartGame(socket));
    socket.on('disconnect', () => handleDisconnect(socket));

    // === FUNKCE HANDLERŮ ===
    function handleCreateRoom(clientSocket, data) {
        const roomId = generateRoomId();
        const { playerName, difficulty = 'easy', numBots = 8 } = data || {};
        
        rooms[roomId] = {
            players: {},
            bots: [],
            bullets: [],
            zombies: [],
            particles: [],
            obstacles: [],
            bunkers: [],
            helicopter: null,
            score: 0,
            gameRunning: true,
            lastZombieHorde: Date.now(),
            lastZoneShrink: Date.now(),
            safeZone: { x: WORLD_WIDTH/2, y: WORLD_HEIGHT/2, radius: 600 },
            zoneDamage: 2,
            zombieHealthMultiplier: { easy: 1, medium: 2, hard: 3 }[difficulty] || 1,
            started: false,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            hostId: clientSocket.id,
            autoStartTimer: null,
            difficulty,
            numBots: Math.min(Math.max(parseInt(numBots) || 8, 0), 20)
        };

        clientSocket.join(roomId);
        
        const spawnPositions = [
            {x: 100, y: 100}, {x: WORLD_WIDTH - 100, y: 100},
            {x: 100, y: WORLD_HEIGHT - 100}, {x: WORLD_WIDTH - 100, y: WORLD_HEIGHT - 100}
        ];

        rooms[roomId].players[clientSocket.id] = {
            id: clientSocket.id,
            name: playerName || 'Host',
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
        console.log(`📡 Vytvořena místnost: ${roomId}, obtížnost: ${difficulty}, botů: ${rooms[roomId].numBots}`);
        updateRoomPlayers(roomId);
    }

    function handleJoinRoom(clientSocket, data) {
        const { roomId, playerName } = data || {};
        const upperRoomId = roomId.toUpperCase();
        
        if (!rooms[upperRoomId]) {
            clientSocket.emit('error', 'Místnost neexistuje!');
            return;
        }

        const room = rooms[upperRoomId];
        const currentPlayerCount = Object.keys(room.players).length;

        if (currentPlayerCount >= room.maxPlayers) {
            clientSocket.emit('error', 'Místnost je plná!');
            return;
        }

        clientSocket.join(upperRoomId);

        const spawnPositions = [
            {x: 100, y: 100}, {x: WORLD_WIDTH - 100, y: 100},
            {x: 100, y: WORLD_HEIGHT - 100}, {x: WORLD_WIDTH - 100, y: WORLD_HEIGHT - 100}
        ];

        room.players[clientSocket.id] = {
            id: clientSocket.id,
            name: playerName || `Hráč ${clientSocket.id.substring(0,4)}`,
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
        
        clientSocket.emit('roomJoined', { roomId: upperRoomId, players: room.players });
        io.to(upperRoomId).emit('playerJoined', { players: room.players });
        console.log(`🔗 Hráč ${clientSocket.id} (${room.players[clientSocket.id].name}) se připojil do ${upperRoomId}`);
        
        if (currentPlayerCount + 1 >= 2 && !room.autoStartTimer) {
            room.autoStartTimer = setTimeout(() => {
                if (!room.started && Object.keys(room.players).length >= 2) {
                    console.log(`🆕 Auto-startuji hru v ${upperRoomId} po odpočtu...`);
                    startGame(upperRoomId);
                }
            }, 10000);
            
            let countdown = 10;
            const countdownInterval = setInterval(() => {
                io.to(upperRoomId).emit('autoStartCountdown', { countdown });
                countdown--;
                if (countdown < 0) {
                    clearInterval(countdownInterval);
                    console.log(`🆕 Odpočet skončil v ${upperRoomId}, spouštím hru...`);
                }
            }, 1000);
        }
    }

    function handleStartGame(clientSocket) {
        const roomId = Object.keys(clientSocket.rooms).find(room => room !== clientSocket.id);
        if (!roomId || !rooms[roomId] || rooms[roomId].started || clientSocket.id !== rooms[roomId].hostId) {
            clientSocket.emit('error', 'Nemůžeš spustit hru!');
            return;
        }

        console.log(`▶️ Manuální start hry v ${roomId} od hosta ${clientSocket.id}`);
        startGame(roomId);
    }

    function handlePlayerInput(clientSocket, inputData) {
        const roomId = Object.keys(clientSocket.rooms).find(room => room !== clientSocket.id);
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players[clientSocket.id];
        if (!player || !player.alive) return;

        player.lastInputTime = Date.now();
        const { keys, mouse, timestamp } = inputData;

        let newX = player.x;
        let newY = player.y;
        if (keys['w']) newY -= player.speed;
        if (keys['s']) newY += player.speed;
        if (keys['a']) newX -= player.speed;
        if (keys['d']) newX += player.speed;

        const collisionRect = { x: newX, y: newY, width: player.width, height: player.height };
        if (!checkCollisionWithObstacles(collisionRect, room.obstacles)) {
            player.x = newX;
            player.y = newY;
        }

        player.x = Math.max(0, Math.min(WORLD_WIDTH - player.width, player.x));
        player.y = Math.max(0, Math.min(WORLD_HEIGHT - player.height, player.y));
    }

    function handleShoot(clientSocket, shootData) {
        const roomId = Object.keys(clientSocket.rooms).find(room => room !== clientSocket.id);
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players[clientSocket.id];
        if (!player || !player.alive || Date.now() - player.lastShot < 150) return;

        const { mouseWorldX, mouseWorldY, timestamp } = shootData;
        const angle = Math.atan2(mouseWorldY - (player.y + 10), mouseWorldX - (player.x + 10));

        room.bullets.push({
            x: player.x + 10,
            y: player.y + 10,
            vx: Math.cos(angle) * 10,
            vy: Math.sin(angle) * 10,
            life: 90,
            damage: 15,
            ownerId: clientSocket.id
        });

        player.lastShot = Date.now();
    }

    function handleRestartGame(clientSocket) {
        const roomId = Object.keys(clientSocket.rooms).find(room => room !== clientSocket.id);
        if (!roomId || !rooms[roomId] || clientSocket.id !== rooms[roomId].hostId) return;

        restartGame(roomId);
    }

    function handleDisconnect(clientSocket) {
        console.log(`👤 Hráč odpojen: ${clientSocket.id}`);
        const roomId = Object.keys(clientSocket.rooms).find(room => room !== clientSocket.id);
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        if (room.players[clientSocket.id]) {
            delete room.players[clientSocket.id];
            io.to(roomId).emit('playerLeft', { players: room.players });
            console.log(`🚪 Hráč ${clientSocket.id} opustil místnost ${roomId}`);
        }

        if (Object.keys(room.players).length === 0) {
            clearInterval(gameIntervals[roomId]);
            delete rooms[roomId];
            console.log(`🗑️ Místnost ${roomId} smazána (prázdná)`);
        } else if (clientSocket.id === room.hostId) {
            io.to(roomId).emit('gameOver', { message: 'Host opustil hru! Game Over.' });
            clearInterval(gameIntervals[roomId]);
            delete rooms[roomId];
            console.log(`🔚 Místnost ${roomId} ukončena (host odešel)`);
        } else {
            updateRoomPlayers(roomId);
        }
    }

    function updateRoomPlayers(roomId) {
        const room = rooms[roomId];
        io.to(roomId).emit('playerJoined', { players: room.players });
    }

    // === GAME LOGIC ===
    function startGame(roomId) {
        const room = rooms[roomId];
        if (!room || room.started) return;

        console.log(`🎮 Spuštěna hra v místnosti ${roomId} (${Object.keys(room.players).length} hráčů), obtížnost: ${room.difficulty}, botů: ${room.numBots}`);
        
        room.started = true;
        
        generateObstaclesAndBunkers(room);
        spawnBots(room, room.numBots);
        spawnZombieHorde(roomId, 5);
        
        const gameData = {
            players: room.players,
            bots: room.bots,
            bullets: room.bullets,
            zombies: room.zombies,
            particles: room.particles,
            obstacles: room.obstacles,
            bunkers: room.bunkers,
            helicopter: room.helicopter,
            score: room.score,
            lastZombieHorde: room.lastZombieHorde,
            lastZoneShrink: room.lastZoneShrink,
            safeZone: room.safeZone,
            zoneDamage: room.zoneDamage,
            zombieHealthMultiplier: room.zombieHealthMultiplier
        };
        
        io.to(roomId).emit('gameStart', gameData);
        
        gameIntervals[roomId] = setInterval(() => updateGame(roomId), 16);
    }

    function updateGame(roomId) {
        const room = rooms[roomId];
        if (!room || !room.gameRunning) return;

        Object.keys(room.players).forEach(playerId => {
            const player = room.players[playerId];
            if (!player.alive) return;
            
            applyZoneDamage(player, room);
            
            if (player.health <= 0) {
                player.alive = false;
                io.to(roomId).emit('playerDied', { playerId });
            }
        });

        updateBots(room);

        updateBullets(room);

        if (Date.now() - room.lastZombieHorde > 12000) {
            const hordeSize = Math.max(3, room.numBots - room.bots.length);
            spawnZombieHorde(roomId, hordeSize);
            room.lastZombieHorde = Date.now();
        }

        if (Date.now() - room.lastZoneShrink > 10000) {
            room.safeZone.radius = Math.max(room.safeZone.radius - 20, 100);
            room.lastZoneShrink = Date.now();
        }

        updateZombies(room);

        updateParticles(room);

        const totalSoldiers = room.bots.length + Object.values(room.players).filter(p => p.alive).length;
        if (totalSoldiers <= 1 && !room.helicopter) {
            spawnHelicopter(room);
            io.to(roomId).emit('message', '🚁 Helikoptéra přiletěla! Doběhni k ní pro vítězství!');
        }

        Object.keys(room.players).forEach(playerId => {
            const player = room.players[playerId];
            if (player.alive && room.helicopter && checkCollision(player, room.helicopter)) {
                io.to(roomId).emit('gameOver', { message: `${player.name} dosáhl helikoptéry! Vítězství!` });
                room.gameRunning = false;
                clearInterval(gameIntervals[roomId]);
            }
        });

        const alivePlayers = Object.values(room.players).filter(p => p.alive).length;
        if (alivePlayers === 0) {
            io.to(roomId).emit('gameOver', { message: 'Všichni hráči mrtví! Game Over!' });
            room.gameRunning = false;
            clearInterval(gameIntervals[roomId]);
        }

        const updatedState = {
            players: room.players,
            bots: room.bots,
            bullets: room.bullets,
            zombies: room.zombies,
            particles: room.particles,
            obstacles: room.obstacles,
            safeZone: room.safeZone,
            helicopter: room.helicopter,
            score: room.score,
            zombieHealthMultiplier: room.zombieHealthMultiplier
        };

        io.to(roomId).emit('gameUpdate', updatedState);
    }

    function restartGame(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        room.gameRunning = true;
        room.started = false;
        room.score = 0;
        room.lastZombieHorde = Date.now();
        room.lastZoneShrink = Date.now();
        room.safeZone = { x: WORLD_WIDTH/2, y: WORLD_HEIGHT/2, radius: 600 };
        room.bullets = [];
        room.zombies = [];
        room.particles = [];
        room.bots = [];
        room.helicopter = null;

        Object.keys(room.players).forEach(playerId => {
            const player = room.players[playerId];
            player.health = 100;
            player.alive = true;
            player.x = Math.random() * WORLD_WIDTH;
            player.y = Math.random() * WORLD_HEIGHT;
            player.lastShot = 0;
        });

        generateObstaclesAndBunkers(room);
        spawnBots(room, room.numBots);

        const data = {
            gameState: {
                score: room.score,
                lastZombieHorde: room.lastZombieHorde,
                lastZoneShrink: room.lastZoneShrink,
                safeZone: room.safeZone,
                zombieHealthMultiplier: room.zombieHealthMultiplier
            },
            players: room.players,
            bots: room.bots,
            obstacles: room.obstacles,
            zombieHealthMultiplier: room.zombieHealthMultiplier
        };

        io.to(roomId).emit('gameRestarted', data);

        clearInterval(gameIntervals[roomId]);
        gameIntervals[roomId] = setInterval(() => updateGame(roomId), 16);
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
