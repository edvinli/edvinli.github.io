// Get the canvas element and its context
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

// Define some constants
var PI = Math.PI;
var TWO_PI = 2 * PI;
var HALF_PI = PI / 2;
var SHIP_SIZE = 35; // pixels - slightly larger for cuteness
var SHIP_THRUST = 0.1; // acceleration per frame
var SHIP_TURN_SPEED = 0.1; // radians per frame
var SHIP_FRICTION = 0.99; // speed reduction per frame
var SHIP_MAX_SPEED = 8; // pixels per frame - slightly slower?
var BULLET_SPEED = 12; // pixels per frame
var BULLET_LIFETIME = 60; // frames - last a bit longer
var ASTEROID_SPEED = 1.5; // pixels per frame - slightly slower
var ASTEROID_SIZE = 60; // pixels - bigger base size
var ASTEROID_VERTICES = 10; // number of vertices per asteroid
var ASTEROID_JAGGEDNESS = 0.4; // how jagged the asteroids are (0 to 1) - slightly less jagged
var ASTEROID_NUM = 4; // initial number of asteroids
var SCORE = 0; // score
var HIGH_SCORE = 0; // high score
var MAX_ASTEROIDS = 15; // maximum number of asteroids on screen at once
var POWERUP_PROBA = 0.1; // chance of a power up spawning - increased!
var POWERUP_DURATION = 500; // frames
var POWER_UP_SIZE = 25; // pixels - slightly bigger
var ASTEROID_PROBA = 1/500; // chance of an asteroid spawning every frame - slightly less frequent


// Define some Kawaii colors! ✨
var COLOR_BACKGROUND = "#A7C7E7"; // Soft Pastel Blue
var COLOR_PASTEL_YELLOW = "#FFFACD"; // Lemon Chiffon (softer yellow)
var COLOR_PASTEL_PINK = "#FFB6C1"; // Light Pink
var COLOR_PASTEL_LAVENDER = "#E6E6FA"; // Lavender (softer)
var COLOR_PASTEL_GREEN = "#98FB98"; // Pale Green
var COLOR_KAWAII_RED = "#FF69B4"; // Hot Pink (for accents)
var COLOR_KAWAII_GREEN = "#90EE90"; // Light Green
var COLOR_SHIP_WINDOW = "#ADD8E6"; // Light Blue

// Disco colors for the invincible ship (Kawaii Rainbow!)
const DISCO_COLORS = [
    "#FFB6C1", // Light Pink
    "#FFA07A", // Light Salmon
    "#FFFACD", // Lemon Chiffon
    "#90EE90", // Light Green
    "#ADD8E6", // Light Blue
    "#E6E6FA", // Lavender
    "#DA70D6"  // Orchid
];
let discoColorIndex = 0;
let discoColorTimer = 0;

// Define some keys
var KEY_LEFT = 37;
var KEY_UP = 38;
var KEY_RIGHT = 39;
var KEY_SPACE = 32;
var KEY_DOWN = 40;

// Define some variables
var ship = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    a: -HALF_PI, // angle pointing up
    dx: 0,
    dy: 0,
    thrusting: false,
    turningLeft: false,
    turningRight: false,
    shooting: false,
    canShoot: true,
    alive: true,
    breaking: false,
    invincible: false,
    invincibleTimer: 0
};

var bullets = []; // array of bullet objects (hearts!)
var asteroids = []; // array of asteroid objects (cute rocks!)
var powerUps = []; // array of power up objects (stars/sparkles!)
var glitterParticles = []; // array for sparkly explosions! ✨

// Create initial asteroids
for (var i = 0; i < ASTEROID_NUM; i++) {
    createAsteroid();
}

// --- Functions ---

// Create a new asteroid object
function createAsteroid(x, y, size) {
    x = x || Math.random() * canvas.width;
    y = y || Math.random() * canvas.height;
    // Avoid spawning too close to the center where the ship starts
    if (Math.abs(x - canvas.width / 2) < ASTEROID_SIZE * 2 && Math.abs(y - canvas.height / 2) < ASTEROID_SIZE * 2) {
        x += (Math.random() < 0.5 ? -1 : 1) * ASTEROID_SIZE * 2;
        y += (Math.random() < 0.5 ? -1 : 1) * ASTEROID_SIZE * 2;
    }
    size = size || ASTEROID_SIZE;

    var asteroid = {
        x: x,
        y: y,
        size: size,
        dx: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1),
        dy: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1),
        a: Math.random() * TWO_PI,
        da: Math.random() * 0.01 * (Math.random() < 0.5 ? -1 : 1), // Slower rotation
        vertices: []
    };

    // Create vertices for the asteroid shape
    for (var i = 0; i < ASTEROID_VERTICES; i++) {
        var angle = i * TWO_PI / ASTEROID_VERTICES;
        var radius = size / 2 * (1 - ASTEROID_JAGGEDNESS / 2 + Math.random() * ASTEROID_JAGGEDNESS); // Adjusted jaggedness application
        var vertX = Math.cos(angle) * radius;
        var vertY = Math.sin(angle) * radius;
        asteroid.vertices.push({ x: vertX, y: vertY, angle: angle, radius: radius });
    }
    asteroids.push(asteroid);
}

// Create a new power up object (Green Triangle for now)
function createPowerUp(x, y) {
    var powerUp = {
        x: x,
        y: y,
        size: POWER_UP_SIZE,
        dx: Math.random() * ASTEROID_SPEED * 0.5 * (Math.random() < 0.5 ? -1 : 1), // Slower drift
        dy: Math.random() * ASTEROID_SPEED * 0.5 * (Math.random() < 0.5 ? -1 : 1),
        a: Math.random() * TWO_PI,
        da: Math.random() * 0.02 * (Math.random() < 0.5 ? -1 : 1),
        vertices: []
    };
    // Simple triangle shape
    for (var i = 0; i < 3; i++) {
        var angle = i * TWO_PI / 3;
        var radius = POWER_UP_SIZE / 2;
        var vertX = Math.cos(angle) * radius;
        var vertY = Math.sin(angle) * radius;
        powerUp.vertices.push({ x: vertX, y: vertY, angle: angle, radius: radius });
    }
    powerUps.push(powerUp);
}

// --- Glitter Effect Functions --- ✨

// Create glitter particles at a location
function createGlitter(x, y, count) {
    for (let i = 0; i < count; i++) {
        let angle = Math.random() * TWO_PI;
        let speed = Math.random() * 4 + 1; // Random speed
        let size = Math.random() * 3 + 1; // Random size
        let color = getRandomGlitterColor(); // Get a random kawaii color

        glitterParticles.push({
            x: x,
            y: y,
            dx: speed * Math.cos(angle),
            dy: speed * Math.sin(angle),
            size: size,
            color: color,
            alpha: 1, // Start fully visible
            lifetime: Math.random() * 40 + 30 // Random lifetime (frames)
        });
    }
}

// Get a random glitter color
function getRandomGlitterColor() {
    const glitterColors = [
        "#FFB6C1", // Light Pink
        "#FF69B4", // Hot Pink
        "#FFD700", // Gold
        "#ADFF2F", // GreenYellow
        "#87CEFA", // Light Sky Blue
        "#DA70D6", // Orchid
        "#FFA07A", // Light Salmon
        "#FFFACD", // Lemon Chiffon
        "#90EE90", // Light Green
        "#00FA9A", // Medium Spring Green
        "#ADD8E6", // Light Blue
    ];
    return glitterColors[Math.floor(Math.random() * glitterColors.length)];
}

// Draw a single glitter particle
function drawGlitter(glitter) {
    ctx.save();
    ctx.globalAlpha = glitter.alpha; // Apply fading effect
    ctx.fillStyle = glitter.color;
    ctx.beginPath();
    // Little star shape maybe? Or just circle is fine.
    ctx.arc(glitter.x, glitter.y, glitter.size, 0, TWO_PI);
    // // Simple Star:
    // ctx.moveTo(glitter.x, glitter.y - glitter.size);
    // for (let i = 0; i < 5; i++) {
    //     ctx.lineTo(glitter.x + Math.cos((18 + i * 72) / 180 * PI) * glitter.size,
    //                glitter.y - Math.sin((18 + i * 72) / 180 * PI) * glitter.size);
    //     ctx.lineTo(glitter.x + Math.cos((54 + i * 72) / 180 * PI) * glitter.size * 0.5,
    //                glitter.y - Math.sin((54 + i * 72) / 180 * PI) * glitter.size * 0.5);
    // }
    // ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// Update glitter particles' position and lifetime
function updateGlitter() {
    for (let i = glitterParticles.length - 1; i >= 0; i--) { // Iterate backwards for safe removal
        let glitter = glitterParticles[i];
        glitter.x += glitter.dx;
        glitter.y += glitter.dy;
        glitter.alpha -= 0.025; // Fade out rate
        glitter.lifetime--;

        // Apply some friction to glitter
        glitter.dx *= 0.98;
        glitter.dy *= 0.98;

        // Remove if faded or lifetime ended
        if (glitter.lifetime <= 0 || glitter.alpha <= 0) {
            glitterParticles.splice(i, 1);
        }
    }
}

// --- Drawing Functions ---

// Draw the Kawaii ship 🚀💖
function drawShip() {
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.a);

    // Ship Body (Rounded shape)
    if (ship.invincible) {
        ctx.strokeStyle = DISCO_COLORS[discoColorIndex]; // Rainbow flash!
        ctx.lineWidth = 4; // Thicker glow
        discoColorTimer++;
        if (discoColorTimer > 5) { // Faster color change
            discoColorTimer = 0;
            discoColorIndex = (discoColorIndex + 1) % DISCO_COLORS.length;
        }
    } else {
        ctx.strokeStyle = COLOR_KAWAII_RED; // Default Hot Pink
        ctx.lineWidth = 3; // Standard thickness
    }
    ctx.fillStyle = COLOR_PASTEL_PINK; // Light pink fill
    ctx.beginPath();
    // Nose
    ctx.moveTo(SHIP_SIZE / 2, 0);
    // Side fin - right
    ctx.lineTo(-SHIP_SIZE / 4, SHIP_SIZE / 3);
    // Rounded back/tail
    ctx.quadraticCurveTo(-SHIP_SIZE / 2.5, 0, -SHIP_SIZE / 4, -SHIP_SIZE / 3);
    // Side fin - left
    ctx.lineTo(SHIP_SIZE / 2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cute Window
    ctx.fillStyle = COLOR_SHIP_WINDOW;
    ctx.beginPath();
    ctx.arc(SHIP_SIZE / 6, 0, SHIP_SIZE / 7, 0, TWO_PI); // Circle window near the front
    ctx.fill();
    // Optional window shine:
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(SHIP_SIZE / 6 + 2, -2, SHIP_SIZE / 15, 0, TWO_PI);
    ctx.fill();


    // Sparkles for thrust/brake ✨
    if (ship.thrusting || ship.breaking) {
        let sparkleColor = ship.thrusting ? COLOR_PASTEL_YELLOW : COLOR_PASTEL_BLUE; // Yellow for forward, blue for brake
        let baseOffsetX = -SHIP_SIZE / 2.5; // Position behind the rounded back
        for (let i = 0; i < 5; i++) { // More sparkles!
            let angle = (Math.random() - 0.5) * 0.8; // Narrower angle backwards
            let dist = Math.random() * SHIP_SIZE * 0.5 + SHIP_SIZE * 0.1;
            let size = Math.random() * 2 + 1;
            ctx.fillStyle = sparkleColor;
            ctx.beginPath();
            ctx.arc(baseOffsetX - dist * Math.cos(angle), dist * Math.sin(angle), size, 0, TWO_PI);
            ctx.fill();
        }
    }

    ctx.restore();
}

// Draw a bullet (Kawaii Heart! ❤️)
function drawBullet(bullet) {
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    // Rotate hearts slightly for fun? Optional.
    // ctx.rotate(bullet.a || 0); // Need to add angle to bullet if you want rotation

    ctx.fillStyle = COLOR_KAWAII_RED; // Hot Pink Hearts
    ctx.beginPath();
    let heartSize = 5; // Size of the heart bullet
    ctx.moveTo(0, -heartSize * 0.4);
    ctx.bezierCurveTo(heartSize * 0.5, -heartSize, heartSize, -heartSize * 0.5, heartSize, 0);
    ctx.bezierCurveTo(heartSize, heartSize * 0.6, heartSize * 0.6, heartSize * 0.8, 0, heartSize);
    ctx.bezierCurveTo(-heartSize * 0.6, heartSize * 0.8, -heartSize, heartSize * 0.6, -heartSize, 0);
    ctx.bezierCurveTo(-heartSize, -heartSize * 0.5, -heartSize * 0.5, -heartSize, 0, -heartSize * 0.4);
    ctx.fill();
    ctx.restore();
}

// Draw an asteroid (Pastel Rock ☁️)
function drawAsteroid(asteroid) {
    ctx.save();
    ctx.translate(asteroid.x, asteroid.y);
    ctx.rotate(asteroid.a);

    ctx.strokeStyle = COLOR_PASTEL_LAVENDER; // Soft Lavender outline
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(asteroid.vertices[0].x, asteroid.vertices[0].y);
    for (let i = 1; i < asteroid.vertices.length; i++) {
        ctx.lineTo(asteroid.vertices[i].x, asteroid.vertices[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Optional: Add a subtle fill?
    // ctx.fillStyle = "rgba(230, 230, 250, 0.1)"; // Very light lavender fill
    // ctx.fill();

    ctx.restore();
}

// Draw a power up (Green Triangle 🌟)
function drawPowerUp(powerUp) {
    ctx.save();
    ctx.translate(powerUp.x, powerUp.y);
    ctx.rotate(powerUp.a);
    ctx.strokeStyle = COLOR_KAWAII_GREEN; // Light Green
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(powerUp.vertices[0].x, powerUp.vertices[0].y);
    for (var i = 1; i < powerUp.vertices.length; i++) {
        ctx.lineTo(powerUp.vertices[i].x, powerUp.vertices[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Maybe add a little sparkle inside?
    ctx.fillStyle = COLOR_PASTEL_YELLOW;
    ctx.beginPath();
    ctx.arc(0, 0, POWER_UP_SIZE / 5, 0, TWO_PI);
    ctx.fill();

    ctx.restore();
}

// --- Update Functions ---

// Update the ship's state
function updateShip() {
    // Handle turning
    if (ship.turningLeft) ship.a -= SHIP_TURN_SPEED;
    if (ship.turningRight) ship.a += SHIP_TURN_SPEED;

    // Handle thrusting/breaking
    if (ship.thrusting) {
        ship.dx += SHIP_THRUST * Math.cos(ship.a);
        ship.dy += SHIP_THRUST * Math.sin(ship.a);
    }
     if (ship.breaking) {
        // Apply brakes more effectively? Reduce velocity directly.
         ship.dx *= 0.95;
         ship.dy *= 0.95;
        // Add slight counter-thrust effect if needed
        // ship.dx -= SHIP_THRUST * 0.5 * Math.cos(ship.a);
        // ship.dy -= SHIP_THRUST * 0.5 * Math.sin(ship.a);
    }

    // Apply friction
    ship.dx *= SHIP_FRICTION;
    ship.dy *= SHIP_FRICTION;

    // Limit speed
    var speed = Math.sqrt(ship.dx * ship.dx + ship.dy * ship.dy);
    if (speed > SHIP_MAX_SPEED) {
        ship.dx *= SHIP_MAX_SPEED / speed;
        ship.dy *= SHIP_MAX_SPEED / speed;
    }

    // Update position
    ship.x += ship.dx;
    ship.y += ship.dy;

    // Handle screen wrapping
    if (ship.x < 0 - SHIP_SIZE / 2) ship.x = canvas.width + SHIP_SIZE / 2;
    if (ship.x > canvas.width + SHIP_SIZE / 2) ship.x = 0 - SHIP_SIZE / 2;
    if (ship.y < 0 - SHIP_SIZE / 2) ship.y = canvas.height + SHIP_SIZE / 2;
    if (ship.y > canvas.height + SHIP_SIZE / 2) ship.y = 0 - SHIP_SIZE / 2;


    // Handle shooting
    if (ship.shooting && ship.canShoot) {
        createBullet();
        ship.canShoot = false;
        // Add slight recoil?
        // ship.dx -= Math.cos(ship.a) * 0.1;
        // ship.dy -= Math.sin(ship.a) * 0.1;
    }

    // Update invincibility timer
    updateShipInvincibility();
}

// Create a new bullet (heart!)
function createBullet() {
    // Calculate offset from ship center to nose tip
    var noseX = ship.x + Math.cos(ship.a) * SHIP_SIZE / 2;
    var noseY = ship.y + Math.sin(ship.a) * SHIP_SIZE / 2;

    var bullet = {
        x: noseX,
        y: noseY,
        dx: Math.cos(ship.a) * BULLET_SPEED + ship.dx, // Add ship's velocity
        dy: Math.sin(ship.a) * BULLET_SPEED + ship.dy,
        lifetime: BULLET_LIFETIME,
        // a: ship.a // Store angle if needed for rotation
    };
    bullets.push(bullet);
    // Add sound effect here (e.g., pyu!)
}

// Update bullet position and lifetime
function updateBullet(bullet, index) { // Pass index for easier removal
    bullet.x += bullet.dx;
    bullet.y += bullet.dy;

    // Screen wrapping
    if (bullet.x < 0) bullet.x = canvas.width;
    if (bullet.x > canvas.width) bullet.x = 0;
    if (bullet.y < 0) bullet.y = canvas.height;
    if (bullet.y > canvas.height) bullet.y = 0;

    bullet.lifetime--;
    if (bullet.lifetime <= 0) {
        bullets.splice(index, 1); // Remove using index
    }
}

// Update asteroid position and rotation
function updateAsteroid(asteroid) {
    asteroid.x += asteroid.dx;
    asteroid.y += asteroid.dy;
    asteroid.a += asteroid.da;

    // Screen wrapping
    let margin = asteroid.size / 2;
    if (asteroid.x < 0 - margin) asteroid.x = canvas.width + margin;
    if (asteroid.x > canvas.width + margin) asteroid.x = 0 - margin;
    if (asteroid.y < 0 - margin) asteroid.y = canvas.height + margin;
    if (asteroid.y > canvas.height + margin) asteroid.y = 0 - margin;
}

// Update powerup position and rotation
function updatePowerUp(powerup) {
    powerup.x += powerup.dx;
    powerup.y += powerup.dy;
    powerup.a += powerup.da;

     // Screen wrapping
    let margin = powerup.size / 2;
    if (powerup.x < 0 - margin) powerup.x = canvas.width + margin;
    if (powerup.x > canvas.width + margin) powerup.x = 0 - margin;
    if (powerup.y < 0 - margin) powerup.y = canvas.height + margin;
    if (powerup.y > canvas.height + margin) powerup.y = 0 - margin;
}

// --- Collision Detection ---

// Check ship vs asteroid collision
function checkShipCollision() {
    if (ship.invincible) return; // Can't collide if invincible

    for (let i = 0; i < asteroids.length; i++) {
        let asteroid = asteroids[i];
        let dx = ship.x - asteroid.x;
        let dy = ship.y - asteroid.y;
        let distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < SHIP_SIZE / 2.5 + asteroid.size / 2) { // Use smaller ship radius for collision
            ship.alive = false;
             // Create glitter explosion for ship death?
            createGlitter(ship.x, ship.y, 50); // Big glitter poof!
            // Add sound effect for death
            break;
        }
    }
}

// Check ship vs powerup collision
function checkPowerupCollision() {
    for (let i = powerUps.length - 1; i >= 0; i--) { // Loop backwards for removal
        let powerup = powerUps[i];
        let dx = ship.x - powerup.x;
        let dy = ship.y - powerup.y;
        let distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < SHIP_SIZE / 2 + powerup.size / 2) {
            makeShipInvincible();
            powerUps.splice(i, 1); // Remove the collected powerup
            // Add sound effect for powerup collect
            break; // Only collect one powerup per frame
        }
    }
}

// Check bullet vs asteroid collision
function checkBulletCollisions() { // Check all bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        let bullet = bullets[i];
        for (let j = asteroids.length - 1; j >= 0; j--) {
            let asteroid = asteroids[j];

            let dx = bullet.x - asteroid.x;
            let dy = bullet.y - asteroid.y;
            let distance = Math.sqrt(dx * dx + dy * dy);

            // Collision!
            if (distance < 5 + asteroid.size / 2) { // 5 is approx heart radius
                // Remove bullet
                bullets.splice(i, 1);

                // Create glitter explosion! ✨
                createGlitter(asteroid.x, asteroid.y, Math.floor(asteroid.size / 2)); // More glitter for bigger asteroids

                // Split or remove asteroid
                if (asteroid.size > ASTEROID_SIZE / 3) { // Split threshold
                    let newSize = asteroid.size / 2;
                    createAsteroid(asteroid.x, asteroid.y, newSize);
                    createAsteroid(asteroid.x, asteroid.y, newSize);
                    SCORE += 20; // More points for splitting
                } else {
                    SCORE += 50; // More points for destroying small ones
                }
                // Always remove the original asteroid
                asteroids.splice(j, 1);

                // Maybe spawn powerup
                if (Math.random() < POWERUP_PROBA) {
                    createPowerUp(asteroid.x, asteroid.y);
                }

                // Update high score
                if (SCORE > HIGH_SCORE) {
                    HIGH_SCORE = SCORE;
                }

                 // Add sound effect for asteroid hit/destruction

                // Since bullet hit, break inner loop and continue to next bullet
                break;
            }
        }
         // Important: If the inner loop broke because of a hit, the outer loop `i`
         // might now point to the wrong bullet if `splice` was used.
         // The backward loop already handles this correctly.
    }
}


// --- Ship State Management ---

// Make ship invincible
function makeShipInvincible() {
    ship.invincible = true;
    ship.invincibleTimer = POWERUP_DURATION;
    discoColorIndex = 0; // Reset disco effect start
    discoColorTimer = 0;
}

// Update invincibility timer
function updateShipInvincibility() {
    if (ship.invincible) {
        ship.invincibleTimer--;
        if (ship.invincibleTimer <= 0) {
            ship.invincible = false;
        }
    }
}

// --- Event Handlers ---

function keyDownHandler(event) {
    if (!ship.alive && event.keyCode !== 32) return; // Allow space to restart? No, handled by mouse click

    switch (event.keyCode) {
        case KEY_LEFT: ship.turningLeft = true; break;
        case KEY_RIGHT: ship.turningRight = true; break;
        case KEY_UP: ship.thrusting = true; break;
        case KEY_DOWN: ship.breaking = true; break;
        case KEY_SPACE: ship.shooting = true; break;
    }
}

function keyUpHandler(event) {
     if (!ship.alive) return;

    switch (event.keyCode) {
        case KEY_LEFT: ship.turningLeft = false; break;
        case KEY_RIGHT: ship.turningRight = false; break;
        case KEY_UP: ship.thrusting = false; break;
        case KEY_DOWN: ship.breaking = false; break;
        case KEY_SPACE: ship.shooting = false; ship.canShoot = true; break; // Allow shooting again
    }
}

document.addEventListener("keydown", keyDownHandler, false);
document.addEventListener("keyup", keyUpHandler, false);

// Prevent arrow keys and spacebar from scrolling the page
window.addEventListener("keydown", function(e) {
    if ([32, 37, 38, 39, 40].includes(e.keyCode)) {
      e.preventDefault();
    }
  }, false);


// --- Game Reset & Mouse Handling ---

// Get mouse position relative to canvas
function getMousePos(canvas, event) {
    var rect = canvas.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
    };
}

// Track if game over listener is active to prevent duplicates
let isGameOverListenerActive = false;

// Mouse click handler (specifically for restart)
function gameOverClickHandler(event) {
    if (!ship.alive) {
        var mousePos = getMousePos(canvas, event);
        // Define clickable area for restart text (adjust as needed)
        let textWidth = ctx.measureText("Restart ✨").width; // Measure dynamically
        let textX = canvas.width / 2;
        let textY = canvas.height / 2 + 30; // Position of the restart text
        let buttonHeight = 30; // Clickable height

        if (mousePos.x > textX - textWidth / 2 - 10 && mousePos.x < textX + textWidth / 2 + 10 &&
            mousePos.y > textY && mousePos.y < textY + buttonHeight)
        {
            restartGame();
        }
    }
}


// Restart the game state
function restartGame() {
    SCORE = 0;
    ship = { // Reset ship object completely
        x: canvas.width / 2,
        y: canvas.height / 2,
        a: -HALF_PI,
        dx: 0,
        dy: 0,
        thrusting: false,
        turningLeft: false,
        turningRight: false,
        shooting: false,
        canShoot: true,
        alive: true,
        breaking: false,
        invincible: false, // Start briefly invincible after respawn? Maybe 1 sec.
        invincibleTimer: 60 // Start with 1 second invincibility
    };
    asteroids = [];
    bullets = [];
    powerUps = [];
    glitterParticles = []; // Clear glitter too

    // Create new asteroids
    for (var i = 0; i < ASTEROID_NUM; i++) {
        createAsteroid();
    }

    // Remove the game over listener if it was active
    if (isGameOverListenerActive) {
        canvas.removeEventListener("mousedown", gameOverClickHandler);
        isGameOverListenerActive = false;
    }
    // Ensure ship starts invincible visual state correctly
    if (ship.invincibleTimer > 0) ship.invincible = true;
}

// --- Main Game Loop ---
function gameLoop() {
    // Clear canvas with Kawaii background
    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Update and Draw Glitter (Draw below everything else? Or above?) - Let's draw below asteroids/bullets
    updateGlitter();
    for (let i = 0; i < glitterParticles.length; i++) {
        drawGlitter(glitterParticles[i]);
    }

    // Update and Draw Asteroids
    for (let i = asteroids.length - 1; i >= 0; i--) { // Loop backwards if needed for collision removal
        updateAsteroid(asteroids[i]);
        drawAsteroid(asteroids[i]);
    }

    // Update and Draw Power Ups
     for (let i = powerUps.length - 1; i >= 0; i--) {
        updatePowerUp(powerUps[i]);
        drawPowerUp(powerUps[i]);
    }

     // Update and Draw Bullets (Hearts!)
    for (let i = bullets.length - 1; i >= 0; i--) {
        // Pass index for efficient removal in updateBullet if lifetime ends
        updateBullet(bullets[i], i);
        // Check if bullet still exists before drawing (might have expired)
        if (bullets[i]) {
            drawBullet(bullets[i]);
        }
    }

    // Check Collisions
    if (ship.alive) {
        checkShipCollision(); // Ship vs Asteroids
        checkPowerupCollision(); // Ship vs Powerups
    }
    checkBulletCollisions(); // Bullets vs Asteroids

    // Update and Draw Ship (if alive)
    if (ship.alive) {
        updateShip();
        drawShip();
    }


    // Spawn new asteroids occasionally
    if (ship.alive && Math.random() < ASTEROID_PROBA && asteroids.length < MAX_ASTEROIDS) {
        createAsteroid();
    }

    // Draw Score and High Score (Kawaii Style)
    ctx.fillStyle = COLOR_KAWAII_RED;
    ctx.font = "24px 'Comic Sans MS', cursive, sans-serif"; // Add fallbacks
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Score: " + SCORE + " 💖", 10, 10);

    ctx.fillStyle = COLOR_PASTEL_YELLOW; // Use a contrasting pastel
    ctx.font = "20px 'Comic Sans MS', cursive, sans-serif";
    ctx.fillText("High Score: " + HIGH_SCORE, 10, 40);

    // Draw Powerup Timer (if active)
    if (ship.invincible) {
        ctx.fillStyle = COLOR_KAWAII_GREEN;
        ctx.font = "20px 'Comic Sans MS', cursive, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        // Display timer in seconds (approx)
        ctx.fillText("✨ Shield: " + Math.ceil(ship.invincibleTimer / 60) + "s ✨", canvas.width - 10, 10);
    }

    // --- Game Over / Win Condition ---

    // Win Condition (Optional - if you want one)
    // if (asteroids.length == 0 && ship.alive) {
    //     ctx.fillStyle = COLOR_PASTEL_GREEN;
    //     ctx.font = "50px 'Comic Sans MS', cursive, sans-serif";
    //     ctx.textAlign = "center";
    //     ctx.textBaseline = "middle";
    //     ctx.fillText("You Win! 🎉", canvas.width / 2, canvas.height / 2);
    //     // Maybe stop the game loop or add a next level button?
    // }

    // Game Over
    if (!ship.alive) {
        ctx.fillStyle = COLOR_PASTEL_PINK; // Soft pink game over
        ctx.font = "48px 'Comic Sans MS', cursive, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Game Over 🥺", canvas.width / 2, canvas.height / 2 - 30);

        // Draw Restart "Button" Text
        ctx.fillStyle = COLOR_KAWAII_GREEN; // Bright green restart
        ctx.font = "28px 'Comic Sans MS', cursive, sans-serif";
        ctx.fillText("Restart ✨", canvas.width / 2, canvas.height / 2 + 30);

        // Add the click listener *only once* when game over state is entered
        if (!isGameOverListenerActive) {
            canvas.addEventListener("mousedown", gameOverClickHandler);
            isGameOverListenerActive = true;
        }
    }

    // Request the next frame
    requestAnimationFrame(gameLoop);
}

// --- Start the game ---
// Optional: Add a start screen before calling gameLoop()
restartGame(); // Initialize first game
gameLoop(); // Start the main loop
