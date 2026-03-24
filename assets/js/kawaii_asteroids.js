const canvas = document.getElementById("canvas");
const ctx    = canvas.getContext("2d");

const TWO_PI  = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Tuning
const SHIP    = { SIZE: 35, THRUST: 0.11, TURN: 0.1, FRICTION: 0.97, MAX_SPEED: 8 };
const BULLET  = { SPEED: 12, LIFE: 62, COOLDOWN: 12 };
const ROID    = { SIZE: 60, VERTS: 10, JAG: 0.4, BASE_SPEED: 1.5 };
const POWERUP = { PROB: 0.12, DURATION: 500, SIZE: 25 };
const GAME    = { LIVES: 3, SAFE_RADIUS: 140, RESPAWN_FRAMES: 120, START_ROIDS: 4 };

// Kawaii colors ✨
const COLOR_BG           = "#A7C7E7";
const COLOR_PASTEL_PINK  = "#FFB6C1";
const COLOR_PASTEL_YELLOW= "#FFFACD";
const COLOR_PASTEL_LAVENDER = "#E6E6FA";
const COLOR_KAWAII_RED   = "#FF69B4";
const COLOR_KAWAII_GREEN = "#90EE90";
const COLOR_SHIP_WINDOW  = "#ADD8E6";
const DISCO_COLORS = ["#FFB6C1","#FFA07A","#FFFACD","#90EE90","#ADD8E6","#E6E6FA","#DA70D6"];
const GLITTER_COLORS = ["#FFB6C1","#FF69B4","#FFD700","#ADFF2F","#87CEFA","#DA70D6","#FFA07A","#90EE90"];

let discoIdx = 0, discoTimer = 0;

// Input
const keys = {};
document.addEventListener("keydown", e => { keys[e.code] = true; });
document.addEventListener("keyup",   e => { keys[e.code] = false; });
window.addEventListener("keydown", e => {
    if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code))
        e.preventDefault();
}, false);

// Restart button — registered once with correct coordinate scaling
canvas.addEventListener("mousedown", e => {
    if (!gameOver) return;
    const r      = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / r.width;
    const scaleY = canvas.height / r.height;
    const mx = (e.clientX - r.left) * scaleX;
    const my = (e.clientY - r.top)  * scaleY;
    const bx = canvas.width / 2;
    const by = canvas.height / 2 + 38;
    if (mx > bx - 60 && mx < bx + 60 && my > by && my < by + 32) startGame();
});

// State
let ship, bullets, asteroids, powerUps, glitter;
let score, highScore = 0, lives, wave;
let respawnTimer, waveTimer, gameOver;

// ─── Init ────────────────────────────────────────────────────────────────────

function startGame() {
    score        = 0;
    lives        = GAME.LIVES;
    wave         = 1;
    gameOver     = false;
    bullets      = [];
    powerUps     = [];
    glitter      = [];
    respawnTimer = 0;
    waveTimer    = 0;
    discoIdx     = 0;
    discoTimer   = 0;
    spawnShip();
    spawnWave();
}

function spawnShip() {
    ship = {
        x: canvas.width / 2,  y: canvas.height / 2,
        a: -HALF_PI,
        dx: 0,  dy: 0,
        alive: true,
        invincible: true,  invincibleTimer: GAME.RESPAWN_FRAMES,
        shootCooldown: 0
    };
}

function spawnWave() {
    asteroids = [];
    const count = GAME.START_ROIDS + (wave - 1) * 2;
    for (let i = 0; i < count; i++) createAsteroid();
    waveTimer = 0;
}

// ─── Object factories ─────────────────────────────────────────────────────────

function createAsteroid(x, y, size) {
    if (x === undefined) {
        let tries = 0;
        do {
            x = Math.random() * canvas.width;
            y = Math.random() * canvas.height;
        } while (ship && dist(x, y, ship.x, ship.y) < GAME.SAFE_RADIUS && ++tries < 20);
    }
    size = size !== undefined ? size : ROID.SIZE;

    const spd = ROID.BASE_SPEED + wave * 0.1;
    const a = {
        x, y, size,
        dx: (Math.random() * spd + spd * 0.4) * (Math.random() < 0.5 ? -1 : 1),
        dy: (Math.random() * spd + spd * 0.4) * (Math.random() < 0.5 ? -1 : 1),
        a:  Math.random() * TWO_PI,
        da: (Math.random() * 0.01 + 0.002) * (Math.random() < 0.5 ? -1 : 1),
        verts: []
    };
    for (let i = 0; i < ROID.VERTS; i++) {
        const ang = (i / ROID.VERTS) * TWO_PI;
        const r   = (size / 2) * (1 - ROID.JAG / 2 + Math.random() * ROID.JAG);
        a.verts.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
    asteroids.push(a);
}

function createPowerUp(x, y) {
    const p = { x, y, size: POWERUP.SIZE, dx: (Math.random()-0.5), dy: (Math.random()-0.5), a: 0, da: 0.03, verts: [] };
    for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * TWO_PI - HALF_PI;
        p.verts.push({ x: Math.cos(ang) * POWERUP.SIZE / 2, y: Math.sin(ang) * POWERUP.SIZE / 2 });
    }
    powerUps.push(p);
}

function spawnGlitter(x, y, n) {
    for (let i = 0; i < n; i++) {
        const ang = Math.random() * TWO_PI;
        const spd = Math.random() * 4 + 1;
        glitter.push({
            x, y,
            dx: Math.cos(ang) * spd,  dy: Math.sin(ang) * spd,
            size: Math.random() * 3 + 1,
            color: GLITTER_COLORS[Math.floor(Math.random() * GLITTER_COLORS.length)],
            alpha: 1,
            life: Math.floor(Math.random() * 30 + 25)
        });
    }
}

// ─── Update ───────────────────────────────────────────────────────────────────

function updateShip() {
    if (!ship.alive) return;

    if (keys["ArrowLeft"])  ship.a -= SHIP.TURN;
    if (keys["ArrowRight"]) ship.a += SHIP.TURN;

    if (keys["ArrowUp"]) {
        ship.dx += SHIP.THRUST * Math.cos(ship.a);
        ship.dy += SHIP.THRUST * Math.sin(ship.a);
    }

    // Reverse: thrust opposite to nose direction
    if (keys["ArrowDown"]) {
        ship.dx -= SHIP.THRUST * Math.cos(ship.a);
        ship.dy -= SHIP.THRUST * Math.sin(ship.a);
    }

    ship.dx *= SHIP.FRICTION;
    ship.dy *= SHIP.FRICTION;

    const spd = Math.hypot(ship.dx, ship.dy);
    if (spd > SHIP.MAX_SPEED) {
        ship.dx = (ship.dx / spd) * SHIP.MAX_SPEED;
        ship.dy = (ship.dy / spd) * SHIP.MAX_SPEED;
    }

    ship.x = wrap(ship.x + ship.dx, canvas.width);
    ship.y = wrap(ship.y + ship.dy, canvas.height);

    // Auto-fire with cooldown
    if (ship.shootCooldown > 0) ship.shootCooldown--;
    if (keys["Space"] && ship.shootCooldown === 0) {
        bullets.push({
            x:    ship.x + Math.cos(ship.a) * SHIP.SIZE / 2,
            y:    ship.y + Math.sin(ship.a) * SHIP.SIZE / 2,
            dx:   Math.cos(ship.a) * BULLET.SPEED + ship.dx,
            dy:   Math.sin(ship.a) * BULLET.SPEED + ship.dy,
            life: BULLET.LIFE
        });
        ship.shootCooldown = BULLET.COOLDOWN;
    }

    if (ship.invincible) {
        // Advance disco effect only during powerup invincibility
        if (ship.invincibleTimer < POWERUP.DURATION) {
            if (++discoTimer > 4) { discoTimer = 0; discoIdx = (discoIdx + 1) % DISCO_COLORS.length; }
        }
        if (--ship.invincibleTimer <= 0) ship.invincible = false;
    }
}

function updateBullets() {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x = wrap(b.x + b.dx, canvas.width);
        b.y = wrap(b.y + b.dy, canvas.height);
        if (--b.life <= 0) bullets.splice(i, 1);
    }
}

function updateAsteroids() {
    for (const a of asteroids) {
        a.x = wrap(a.x + a.dx, canvas.width);
        a.y = wrap(a.y + a.dy, canvas.height);
        a.a += a.da;
    }
}

function updatePowerUps() {
    for (const p of powerUps) {
        p.x = wrap(p.x + p.dx, canvas.width);
        p.y = wrap(p.y + p.dy, canvas.height);
        p.a += p.da;
    }
}

function updateGlitter() {
    for (let i = glitter.length - 1; i >= 0; i--) {
        const g = glitter[i];
        g.x += g.dx;  g.y += g.dy;
        g.dx *= 0.97; g.dy *= 0.97;
        g.alpha -= 0.025;
        if (--g.life <= 0 || g.alpha <= 0) glitter.splice(i, 1);
    }
}

function checkCollisions() {
    // Bullets vs asteroids — iterate backwards on both
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
        const b = bullets[bi];
        for (let ai = asteroids.length - 1; ai >= 0; ai--) {
            const a = asteroids[ai];
            if (dist(b.x, b.y, a.x, a.y) < 6 + a.size / 2) {
                spawnGlitter(a.x, a.y, Math.floor(a.size / 2));
                bullets.splice(bi, 1);
                asteroids.splice(ai, 1);
                if (a.size > ROID.SIZE / 3) {
                    createAsteroid(a.x, a.y, a.size / 2);
                    createAsteroid(a.x, a.y, a.size / 2);
                    score += 20;
                } else {
                    score += 50;
                }
                if (Math.random() < POWERUP.PROB) createPowerUp(a.x, a.y);
                if (score > highScore) highScore = score;
                break;
            }
        }
    }

    if (!ship.alive || ship.invincible) return;

    // Ship vs asteroids
    for (const a of asteroids) {
        if (dist(ship.x, ship.y, a.x, a.y) < SHIP.SIZE / 2.5 + a.size / 2) {
            spawnGlitter(ship.x, ship.y, 50);
            ship.alive = false;
            if (--lives > 0) {
                respawnTimer = GAME.RESPAWN_FRAMES;
            } else {
                gameOver = true;
            }
            return;
        }
    }

    // Ship vs powerups
    for (let i = powerUps.length - 1; i >= 0; i--) {
        const p = powerUps[i];
        if (dist(ship.x, ship.y, p.x, p.y) < SHIP.SIZE / 2 + p.size / 2) {
            powerUps.splice(i, 1);
            ship.invincible     = true;
            ship.invincibleTimer = POWERUP.DURATION;
            discoIdx = 0; discoTimer = 0;
        }
    }
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

function drawShip() {
    if (!ship.alive) return;

    // Flicker during spawn invincibility only
    const isSpawnInvincible = ship.invincible && ship.invincibleTimer <= GAME.RESPAWN_FRAMES;
    if (isSpawnInvincible && Math.floor(ship.invincibleTimer / 5) % 2 === 0) return;

    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.a);

    // Sparkles for thrust/reverse
    if (keys["ArrowUp"] || keys["ArrowDown"]) {
        const sparkColor = keys["ArrowUp"] ? COLOR_PASTEL_YELLOW : COLOR_SHIP_WINDOW;
        for (let i = 0; i < 5; i++) {
            const ang  = (Math.random() - 0.5) * 0.8;
            const d    = Math.random() * SHIP.SIZE * 0.5 + SHIP.SIZE * 0.1;
            ctx.fillStyle = sparkColor;
            ctx.beginPath();
            ctx.arc(-SHIP.SIZE / 2.5 - d * Math.cos(ang), d * Math.sin(ang), Math.random() * 2 + 1, 0, TWO_PI);
            ctx.fill();
        }
    }

    // Hull — disco color if powerup invincible, pink otherwise
    const hullColor = (ship.invincible && !isSpawnInvincible) ? DISCO_COLORS[discoIdx] : COLOR_KAWAII_RED;
    ctx.strokeStyle = hullColor;
    ctx.lineWidth   = ship.invincible && !isSpawnInvincible ? 4 : 3;
    ctx.fillStyle   = COLOR_PASTEL_PINK;
    ctx.beginPath();
    ctx.moveTo(SHIP.SIZE / 2, 0);
    ctx.lineTo(-SHIP.SIZE / 4,  SHIP.SIZE / 3);
    ctx.quadraticCurveTo(-SHIP.SIZE / 2.5, 0, -SHIP.SIZE / 4, -SHIP.SIZE / 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Window
    ctx.fillStyle = COLOR_SHIP_WINDOW;
    ctx.beginPath();
    ctx.arc(SHIP.SIZE / 6, 0, SHIP.SIZE / 7, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(SHIP.SIZE / 6 + 2, -2, SHIP.SIZE / 15, 0, TWO_PI);
    ctx.fill();

    ctx.restore();
}

function drawGlitter() {
    for (const g of glitter) {
        ctx.globalAlpha = Math.max(g.alpha, 0);
        ctx.fillStyle = g.color;
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.size, 0, TWO_PI);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawBullet(b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = COLOR_KAWAII_RED;
    ctx.beginPath();
    const s = 5;
    ctx.moveTo(0, -s * 0.4);
    ctx.bezierCurveTo( s*0.5, -s,   s, -s*0.5,  s,      0);
    ctx.bezierCurveTo( s,      s*0.6, s*0.6, s*0.8, 0, s);
    ctx.bezierCurveTo(-s*0.6,  s*0.8,-s,  s*0.6,  -s,     0);
    ctx.bezierCurveTo(-s,     -s*0.5,-s*0.5,-s,     0, -s*0.4);
    ctx.fill();
    ctx.restore();
}

function drawAsteroid(a) {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.a);
    ctx.strokeStyle = COLOR_PASTEL_LAVENDER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.verts[0].x, a.verts[0].y);
    for (let i = 1; i < a.verts.length; i++) ctx.lineTo(a.verts[i].x, a.verts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

function drawPowerUp(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    ctx.strokeStyle = COLOR_KAWAII_GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.verts[0].x, p.verts[0].y);
    for (let i = 1; i < p.verts.length; i++) ctx.lineTo(p.verts[i].x, p.verts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = COLOR_PASTEL_YELLOW;
    ctx.beginPath();
    ctx.arc(0, 0, POWERUP.SIZE / 5, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
}

function drawHUD() {
    const font = "20px 'Comic Sans MS', cursive, sans-serif";
    ctx.textBaseline = "top";

    ctx.fillStyle = COLOR_KAWAII_RED;
    ctx.font = font;
    ctx.textAlign = "left";
    ctx.fillText(`score: ${score} 💖`, 10, 10);

    ctx.fillStyle = COLOR_PASTEL_YELLOW;
    ctx.font = "16px 'Comic Sans MS', cursive, sans-serif";
    ctx.fillText(`best: ${highScore}`, 10, 36);
    ctx.fillText(`wave: ${wave}`, 10, 56);

    // Lives as mini hearts
    for (let i = 0; i < lives; i++) {
        ctx.fillStyle = COLOR_KAWAII_RED;
        ctx.font = "16px serif";
        ctx.fillText("♥", 10 + i * 20, 76);
    }

    if (ship.alive && ship.invincible && ship.invincibleTimer < POWERUP.DURATION) {
        ctx.fillStyle = COLOR_KAWAII_GREEN;
        ctx.font = font;
        ctx.textAlign = "right";
        ctx.fillText(`✨ shield: ${Math.ceil(ship.invincibleTimer / 60)}s ✨`, canvas.width - 10, 10);
    }
}

function drawOverlay() {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (gameOver) {
        ctx.fillStyle = COLOR_PASTEL_PINK;
        ctx.font = "48px 'Comic Sans MS', cursive, sans-serif";
        ctx.fillText("game over 🥺", canvas.width / 2, canvas.height / 2 - 28);
        ctx.font = "20px 'Comic Sans MS', cursive, sans-serif";
        ctx.fillStyle = "rgba(255,105,180,0.7)";
        ctx.fillText(`score: ${score}  ·  best: ${highScore}`, canvas.width / 2, canvas.height / 2 + 8);
        // Restart button
        const bx = canvas.width / 2, by = canvas.height / 2 + 38;
        ctx.strokeStyle = COLOR_KAWAII_GREEN;
        ctx.lineWidth = 2;
        ctx.strokeRect(bx - 60, by, 120, 32);
        ctx.fillStyle = COLOR_KAWAII_GREEN;
        ctx.font = "22px 'Comic Sans MS', cursive, sans-serif";
        ctx.fillText("restart ✨", bx, by + 16);
        return;
    }

    if (waveTimer > 0) {
        const alpha = Math.min(waveTimer / 30, 1);
        ctx.fillStyle = `rgba(255, 105, 180, ${alpha * 0.85})`;
        ctx.font = "28px 'Comic Sans MS', cursive, sans-serif";
        ctx.fillText(`wave ${wave} ✨`, canvas.width / 2, canvas.height / 2);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dist(x1, y1, x2, y2) { return Math.hypot(x1 - x2, y1 - y2); }

function wrap(val, max) {
    if (val < 0)   return val + max;
    if (val > max) return val - max;
    return val;
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

function gameLoop() {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!gameOver) {
        if (!ship.alive && respawnTimer > 0 && --respawnTimer === 0) spawnShip();

        updateShip();
        updateBullets();
        updateAsteroids();
        updatePowerUps();
        updateGlitter();
        checkCollisions();

        // Wave clear
        if (asteroids.length === 0 && waveTimer === 0) {
            wave++;
            waveTimer = 100;
        }
        if (waveTimer > 0 && --waveTimer === 0) spawnWave();
    }

    drawGlitter();
    for (const a of asteroids) drawAsteroid(a);
    for (const p of powerUps)  drawPowerUp(p);
    for (const b of bullets)   drawBullet(b);
    drawShip();
    drawHUD();
    drawOverlay();

    requestAnimationFrame(gameLoop);
}

startGame();
gameLoop();
