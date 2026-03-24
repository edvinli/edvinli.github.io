const canvas = document.getElementById("canvas");
const ctx    = canvas.getContext("2d");

const TWO_PI = Math.PI * 2;
const FONT   = "13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// Tuning
const SHIP     = { SIZE: 20, THRUST: 0.13, TURN: 0.075, FRICTION: 0.97, MAX_SPEED: 10 };
const BULLET   = { SPEED: 15, LIFE: 58, COOLDOWN: 10 };
const ROID     = { SIZE: 50, VERTS: 10, JAG: 0.4, BASE_SPEED: 1.5 };
const POWERUP  = { PROB: 0.12, DURATION: 420, SIZE: 14 };
const GAME     = { LIVES: 3, SAFE_RADIUS: 130, RESPAWN_FRAMES: 120, START_ROIDS: 4 };

// Input — single object, no stacking listeners
const keys = {};
document.addEventListener("keydown", e => { keys[e.code] = true; });
document.addEventListener("keyup",   e => { keys[e.code] = false; });
window.addEventListener("keydown", e => {
    if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code))
        e.preventDefault();
}, false);

// Restart button — registered once, not inside the loop
canvas.addEventListener("mousedown", e => {
    if (!gameOver) return;
    const r      = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / r.width;
    const scaleY = canvas.height / r.height;
    const mx = (e.clientX - r.left) * scaleX;
    const my = (e.clientY - r.top)  * scaleY;
    const bx = canvas.width / 2;
    const by = canvas.height / 2 + 38;
    if (mx > bx - 52 && mx < bx + 52 && my > by && my < by + 28) startGame();
});

// State
let ship, bullets, asteroids, powerUps, particles;
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
    particles    = [];
    respawnTimer = 0;
    waveTimer    = 0;
    spawnShip();
    spawnWave();
}

function spawnShip() {
    ship = {
        x: canvas.width / 2,  y: canvas.height / 2,
        a: -Math.PI / 2,
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
    // Safe-spawn: keep trying until far enough from ship
    if (x === undefined) {
        let tries = 0;
        do {
            x = Math.random() * canvas.width;
            y = Math.random() * canvas.height;
        } while (ship && dist(x, y, ship.x, ship.y) < GAME.SAFE_RADIUS && ++tries < 20);
    }
    size = size !== undefined ? size : ROID.SIZE;

    const spd = ROID.BASE_SPEED + wave * 0.12;
    const a = {
        x, y, size,
        dx: (Math.random() * spd + spd * 0.4) * (Math.random() < 0.5 ? -1 : 1),
        dy: (Math.random() * spd + spd * 0.4) * (Math.random() < 0.5 ? -1 : 1),
        a:  Math.random() * TWO_PI,
        da: (Math.random() * 0.03 + 0.005) * (Math.random() < 0.5 ? -1 : 1),
        verts: []
    };
    for (let i = 0; i < ROID.VERTS; i++) {
        const ang = (i / ROID.VERTS) * TWO_PI;
        const r   = (size / 2) * (1 + Math.random() * ROID.JAG);
        a.verts.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
    asteroids.push(a);
}

function createPowerUp(x, y) {
    const p = {
        x, y,
        size: POWERUP.SIZE,
        dx: (Math.random() - 0.5) * 2,
        dy: (Math.random() - 0.5) * 2,
        a: 0, da: 0.04,
        verts: []
    };
    for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * TWO_PI - Math.PI / 2;
        p.verts.push({ x: Math.cos(ang) * POWERUP.SIZE / 2, y: Math.sin(ang) * POWERUP.SIZE / 2 });
    }
    powerUps.push(p);
}

function spawnParticles(x, y, n) {
    for (let i = 0; i < n; i++) {
        const ang = Math.random() * TWO_PI;
        const spd = Math.random() * 3 + 0.5;
        particles.push({ x, y, dx: Math.cos(ang) * spd, dy: Math.sin(ang) * spd, life: 25 + Math.random() * 20 });
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

    // Reverse: thrust opposite to ship's nose direction
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

    // Auto-fire: hold spacebar, fires every COOLDOWN frames
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

    if (ship.invincible && --ship.invincibleTimer <= 0) ship.invincible = false;
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

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x  += p.dx;  p.y  += p.dy;
        p.dx *= 0.93;  p.dy *= 0.93;
        if (--p.life <= 0) particles.splice(i, 1);
    }
}

function checkCollisions() {
    // Bullets vs asteroids — iterate both backwards so splicing is safe
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
        const b = bullets[bi];
        for (let ai = asteroids.length - 1; ai >= 0; ai--) {
            const a = asteroids[ai];
            if (dist(b.x, b.y, a.x, a.y) < a.size / 2 + 2) {
                spawnParticles(a.x, a.y, 8);
                bullets.splice(bi, 1);
                asteroids.splice(ai, 1);
                if (a.size > ROID.SIZE / 4) {
                    createAsteroid(a.x, a.y, a.size / 2);
                    createAsteroid(a.x, a.y, a.size / 2);
                }
                if (Math.random() < POWERUP.PROB) createPowerUp(a.x, a.y);
                // Smaller asteroids worth more points
                score += Math.round(ROID.SIZE / a.size) * 10;
                if (score > highScore) highScore = score;
                break;
            }
        }
    }

    if (!ship.alive || ship.invincible) return;

    // Ship vs asteroids
    for (const a of asteroids) {
        if (dist(ship.x, ship.y, a.x, a.y) < SHIP.SIZE / 2 + a.size * 0.4) {
            spawnParticles(ship.x, ship.y, 14);
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
        if (dist(ship.x, ship.y, p.x, p.y) < SHIP.SIZE / 2 + POWERUP.SIZE / 2) {
            powerUps.splice(i, 1);
            ship.invincible     = true;
            ship.invincibleTimer = POWERUP.DURATION;
        }
    }
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

function drawShip() {
    const s = ship;
    if (!s.alive) return;

    // Flicker while invincible
    if (s.invincible && Math.floor(s.invincibleTimer / 5) % 2 === 0) return;

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.a);
    ctx.lineWidth = 1.5;

    // Flame
    if (keys["ArrowUp"]) {
        ctx.strokeStyle = `hsl(${20 + Math.random() * 25}, 100%, 60%)`;
        ctx.beginPath();
        ctx.moveTo(-SHIP.SIZE / 3,  SHIP.SIZE / 5);
        ctx.lineTo(-SHIP.SIZE / 2 - Math.random() * SHIP.SIZE * 0.7, 0);
        ctx.lineTo(-SHIP.SIZE / 3, -SHIP.SIZE / 5);
        ctx.stroke();
    }

    // Hull — slight indent on back for a crisper silhouette
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo( SHIP.SIZE / 2,  0);
    ctx.lineTo(-SHIP.SIZE / 2,  SHIP.SIZE / 3);
    ctx.lineTo(-SHIP.SIZE / 3,  0);
    ctx.lineTo(-SHIP.SIZE / 2, -SHIP.SIZE / 3);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
}

function drawPolygon(obj, color) {
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate(obj.a);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(obj.verts[0].x, obj.verts[0].y);
    for (let i = 1; i < obj.verts.length; i++) ctx.lineTo(obj.verts[i].x, obj.verts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

function drawParticles() {
    for (const p of particles) {
        ctx.globalAlpha = Math.min(p.life / 25, 1) * 0.8;
        ctx.fillStyle = "#ccc";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, TWO_PI);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawHUD() {
    ctx.font = FONT;
    ctx.textBaseline = "top";

    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(`score: ${score}`, 12, 12);
    ctx.fillText(`wave: ${wave}`,   12, 30);

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.textAlign = "right";
    ctx.fillText(`best: ${highScore}`, canvas.width - 12, 12);

    // Shield timer (only for powerup, not spawn invincibility)
    if (ship.alive && ship.invincible && ship.invincibleTimer > GAME.RESPAWN_FRAMES) {
        ctx.fillStyle = "#4f4";
        ctx.textAlign = "right";
        ctx.fillText(`shield: ${Math.ceil(ship.invincibleTimer / 60)}s`, canvas.width - 12, 30);
    }

    // Lives as mini ship icons
    for (let i = 0; i < lives; i++) {
        ctx.save();
        ctx.translate(14 + i * 20, 58);
        ctx.rotate(-Math.PI / 2);
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(7, 0); ctx.lineTo(-7, 4); ctx.lineTo(-4, 0); ctx.lineTo(-7, -4);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }
}

function drawOverlay() {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (gameOver) {
        ctx.fillStyle = "#fff";
        ctx.font = `bold 30px ui-monospace, monospace`;
        ctx.fillText("game over", canvas.width / 2, canvas.height / 2 - 22);
        ctx.font = FONT;
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fillText(`score: ${score}  ·  best: ${highScore}`, canvas.width / 2, canvas.height / 2 + 8);
        // Restart button
        const bx = canvas.width / 2, by = canvas.height / 2 + 38;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 52, by, 104, 28);
        ctx.fillStyle = "#fff";
        ctx.fillText("restart", bx, by + 14);
        return;
    }

    if (waveTimer > 0) {
        const alpha = Math.min(waveTimer / 30, 1);
        ctx.fillStyle = `rgba(255,255,255,${alpha * 0.75})`;
        ctx.font = FONT;
        ctx.fillText(`wave ${wave}`, canvas.width / 2, canvas.height / 2);
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
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!gameOver) {
        if (!ship.alive && respawnTimer > 0 && --respawnTimer === 0) spawnShip();

        updateShip();
        updateBullets();
        updateAsteroids();
        updatePowerUps();
        updateParticles();
        checkCollisions();

        // Wave clear
        if (asteroids.length === 0 && waveTimer === 0) {
            wave++;
            waveTimer = 100;
        }
        if (waveTimer > 0 && --waveTimer === 0) spawnWave();
    }

    drawParticles();
    for (const b of bullets) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2, 0, TWO_PI);
        ctx.fill();
    }
    for (const a of asteroids) drawPolygon(a, "#fff");
    for (const p of powerUps)  drawPolygon(p, "#4f4");
    drawShip();
    drawHUD();
    drawOverlay();

    requestAnimationFrame(gameLoop);
}

startGame();
gameLoop();
