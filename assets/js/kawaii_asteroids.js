// Get the canvas element and its context
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

// Define some constants
var PI = Math.PI;
var TWO_PI = 2 * PI;
var HALF_PI = PI / 2;
var SHIP_SIZE = 30; // pixels
var SHIP_THRUST = 0.1; // acceleration per frame
var SHIP_TURN_SPEED = 0.1; // radians per frame
var SHIP_FRICTION = 0.99; // speed reduction per frame
var SHIP_MAX_SPEED = 10; // pixels per frame
var BULLET_SPEED = 15; // pixels per frame
var BULLET_LIFETIME = 50; // frames
var ASTEROID_SPEED = 2; // pixels per frame
var ASTEROID_SIZE = 50; // pixels
var ASTEROID_VERTICES = 10; // number of vertices per asteroid
var ASTEROID_JAGGEDNESS = 0.5; // how jagged the asteroids are (0 to 1)
var ASTEROID_NUM = 5; // initial number of asteroids
var SCORE = 0; // score
var HIGH_SCORE = 0; // high score
var MAX_ASTEROIDS = 15; // maximum number of asteroids on screen at once
var POWERUP_PROBA = 0.05; // chance of a power up spawning when an asteroid is destroyed
var POWERUP_DURATION = 500; // frames
var POWER_UP_SIZE = 20; // pixels
var ASTEROID_PROBA = 1/400; // chance of an asteroid spawning every frame


// Define some colors
var COLOR_PASTEL_GREEN = "#98FB98";
var COLOR_NEON_PINK = "#FF69B4";

// Define some colors (More Kawaii!)
var COLOR_PASTEL_BLUE = "#A7C7E7"; // Softened blue
var COLOR_PASTEL_YELLOW = "#FFF9C4"; // Softened yellow
var COLOR_PASTEL_PINK = "#FFB6C1"; // Light pink
var COLOR_PASTEL_LAVENDER = "#E6BEEB"; // Light lavender
var COLOR_KAWAII_RED = "#FF69B4"; // Brighter pink-red
var COLOR_KAWAII_GREEN = "#90EE90"; // Light Green

// Disco colors for the ship
const DISCO_COLORS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"];
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
    x: canvas.width / 2, // x coordinate of the ship's center
    y: canvas.height / 2, // y coordinate of the ship's center
    a: -HALF_PI, // angle of the ship (0 is right, PI/2 is down)
    dx: 0, // x velocity of the ship
    dy: 0, // y velocity of the ship
    thrusting: false, // whether the ship is thrusting or not
    turningLeft: false, // whether the ship is turning left or not
    turningRight: false, // whether the ship is turning right or not
    shooting: false, // whether the ship is shooting or not
    canShoot: true, // whether the ship can shoot or not (to prevent rapid fire)
    alive: true, // whether the ship is alive or not
    breaking: false, // whether the ship is breaking or not
    invincible: false, // whether the ship is invincible or not
    invincibleTimer: 0 // timer for the invincibility
};

var bullets = []; // array of bullet objects
var asteroids = []; // array of asteroid objects
var powerUps = []; // array of power up objects
var glitterParticles = []; // Initialize as an empty array

// Create some asteroids randomly
for (var i = 0; i < ASTEROID_NUM; i++) {
    createAsteroid();
}

// Define some functions

// Create a new asteroid object and push it to the asteroids array
function createAsteroid(x, y, size) {
    x = x || Math.random() * canvas.width; // default to a random x coordinate
    y = y || Math.random() * canvas.height; // default to a random y coordinate
    size = size || ASTEROID_SIZE; // default to the initial asteroid size

    var asteroid = {
        x: x,
        y: y,
        size: size,
        dx: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1), // random x velocity with random direction
        dy: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1), // random y velocity with random direction
        a: Math.random() * TWO_PI, // random angle
        da: Math.random() * 0.02 * (Math.random() < 0.5 ? -1 : 1), // random angular velocity with random direction
        vertices: [] // array of vertex objects relative to the asteroid's center
    };

    // Create some vertices for the asteroid shape
    for (var i = 0; i < ASTEROID_VERTICES; i++) {
        var angle = i * TWO_PI / ASTEROID_VERTICES; // equally spaced angles around the circle
        var radius = size / 2 * (1 + Math.random() * ASTEROID_JAGGEDNESS); // random radius with some jaggedness
        var x = Math.cos(angle) * radius; // x coordinate of the vertex relative to the asteroid's center
        var y = Math.sin(angle) * radius; // y coordinate of the vertex relative to the asteroid's center

        var vertex = {
            x: x,
            y: y,
            angle: angle,
            radius: radius
        };
         // Push the vertex to the asteroid's vertices array
        asteroid.vertices.push(vertex);
    }
    //Push the asteroid to the asteroids array
    asteroids.push(asteroid);
}

// Create a new power up object and push it to the power ups array
function createPowerUp(x, y) {
    // Create a power up object where the asteroid was destroyed
    var powerUp = {
        x: x,
        y: y,
        size: POWER_UP_SIZE,
        dx: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1), // random x velocity with random direction
        dy: Math.random() * ASTEROID_SPEED * (Math.random() < 0.5 ? -1 : 1), // random y velocity with random direction
        a: Math.random() * TWO_PI, // random angle
        da: Math.random() * 0.02 * (Math.random() < 0.5 ? -1 : 1), // random angular velocity with random direction
        vertices: [] // array of vertex objects relative to the power up's center
    };

    // Create vertices for a triangle shape
    for (var i = 0; i < 3; i++) {
        var angle = i * TWO_PI / 3; // equally spaced angles around the circle
        var radius = POWER_UP_SIZE / 2; // radius of the vertex
        var x = Math.cos(angle) * radius; // x coordinate of the vertex relative to the power up's center
        var y = Math.sin(angle) * radius; // y coordinate of the vertex relative to the power up's center

        var vertex = {
            x: x,
            y: y,
            angle: angle,
            radius: radius
        };
        // Push the vertex to the power up's vertices array
        powerUp.vertices.push(vertex);
    }
    // Push the power up to the power ups array
    powerUps.push(powerUp);
}


// Function to create glitter particles
function createGlitter(x, y, count) {
    for (let i = 0; i < count; i++) {
        let angle = Math.random() * TWO_PI;
        let speed = Math.random() * 5 + 2; // Random speed
        let size = Math.random() * 3 + 1; // Random size
        let color = getRandomGlitterColor(); // Get a random glitter color

        glitterParticles.push({
            x: x,
            y: y,
            dx: speed * Math.cos(angle),
            dy: speed * Math.sin(angle),
            size: size,
            color: color,
            alpha: 1, // Start with full alpha
            lifetime: Math.random() * 30 + 20 // Random lifetime
        });
    }
}

// Function to get a random glitter color
function getRandomGlitterColor() {
    const glitterColors = [
        "#FFB6C1", // Light Pink
        "#FF69B4", // Hot Pink
        "#FFD700", // Gold
        "#ADFF2F", // GreenYellow
        "#87CEFA", // Light Sky Blue
        "#DA70D6", // Orchid
        "#FFA07A", // Light Salmon
        "#FFFF00", // Yellow
        "#00FF00", // Lime
        "#00FFFF", // Cyan
    ];
    return glitterColors[Math.floor(Math.random() * glitterColors.length)];
}

// Function to draw glitter particles
function drawGlitter(glitter) {
    ctx.save();
    ctx.globalAlpha = glitter.alpha; // Set alpha for fading effect
    ctx.fillStyle = glitter.color;
    ctx.beginPath();
    ctx.arc(glitter.x, glitter.y, glitter.size, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
}

// Function to update glitter particles
function updateGlitter() {
    for (let i = glitterParticles.length - 1; i >= 0; i--) { // Iterate backwards for safe removal
        let glitter = glitterParticles[i];
        glitter.x += glitter.dx;
        glitter.y += glitter.dy;
        glitter.alpha -= 0.03;  // Fade out
        glitter.lifetime--;

        if (glitter.lifetime <= 0 || glitter.alpha <= 0) {
            glitterParticles.splice(i, 1);
        }
    }
}


// Draw the ship (Kawaii Style!)
function drawShip() {
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.a);

    // Ship Body (Rounded rectangle with a cute tail)
    if (ship.invincible) {
        ctx.strokeStyle = DISCO_COLORS[discoColorIndex]; // Use disco color if invincible
        discoColorTimer++;
        if (discoColorTimer > 10) { // Change color every 10 frames
            discoColorTimer = 0;
            discoColorIndex = (discoColorIndex + 1) % DISCO_COLORS.length;
        }
    } else {
        ctx.strokeStyle = COLOR_KAWAII_RED; // Default color
    }
    ctx.lineWidth = 3; // Thicker lines
    ctx.beginPath();
    ctx.moveTo(SHIP_SIZE / 2, 0);
    ctx.lineTo(-SHIP_SIZE / 3, SHIP_SIZE / 4);
    ctx.quadraticCurveTo(-SHIP_SIZE / 2, 0, -SHIP_SIZE / 3, -SHIP_SIZE / 4); // Rounded back
    ctx.closePath();
    ctx.stroke();

    // Cute Window
    ctx.fillStyle = COLOR_PASTEL_BLUE;
    ctx.beginPath();
    ctx.arc(0, 0, SHIP_SIZE / 6, 0, TWO_PI); // Circle window
    ctx.fill();

    // Little sparkles (when thrusting)
    if (ship.thrusting || ship.breaking) {
        let flameColor = ship.thrusting? COLOR_PASTEL_YELLOW: COLOR_PASTEL_BLUE;
        for (let i = 0; i < 3; i++) {
            let angle = Math.random() * TWO_PI;
            let radius = Math.random() * SHIP_SIZE / 3;
            ctx.fillStyle = flameColor;
            ctx.beginPath();
            ctx.arc(-SHIP_SIZE/2 - radius*Math.cos(angle), radius*Math.sin(angle), 2, 0, TWO_PI);
            ctx.fill();
        }
    }

    ctx.restore();
}

// Draw a bullet (Kawaii Heart!)
function drawBullet(bullet) {
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.fillStyle = COLOR_KAWAII_RED;
    ctx.beginPath();
    let heartSize = 6; // Slightly bigger heart
    ctx.moveTo(0, -heartSize * 0.4); // Adjusted for better heart shape
    ctx.bezierCurveTo(-heartSize * 0.6, -heartSize * 0.8, -heartSize, 0, 0, heartSize * 0.4);
    ctx.bezierCurveTo(heartSize, 0, heartSize * 0.6, -heartSize * 0.8, 0, -heartSize * 0.4);
    ctx.fill();
    ctx.restore();
}


// Draw an asteroid (More Rounded)
function drawAsteroid(asteroid) {
    ctx.save();
    ctx.translate(asteroid.x, asteroid.y);
    ctx.rotate(asteroid.a);

    ctx.strokeStyle = COLOR_PASTEL_LAVENDER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(asteroid.vertices.x, asteroid.vertices.y);
    for (let i = 1; i < asteroid.vertices.length; i++) {
        ctx.lineTo(asteroid.vertices[i].x, asteroid.vertices[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
}

// Draw a power up on the canvas
function drawPowerUp(powerUp) {
    // Save the current context state
    ctx.save();

    // Translate the context to the power up's center
    ctx.translate(powerUp.x, powerUp.y);

    // Rotate the context to the power up's angle
    ctx.rotate(powerUp.a);

    // Set the stroke color to green
    ctx.strokeStyle = COLOR_PASTEL_GREEN;

    // Begin a new path
    ctx.beginPath();

    // Move to the first vertex of the power up
    ctx.moveTo(powerUp.vertices[0].x, powerUp.vertices[0].y);

    // Loop through the rest of the vertices and draw lines to them
    for (var i = 1; i < powerUp.vertices.length; i++) {
        ctx.lineTo(powerUp.vertices[i].x, powerUp.vertices[i].y);
    }

    // Close the path
    ctx.closePath();

    // Stroke the path
    ctx.stroke();

    // Restore the context state
    ctx.restore();
}

// Update the ship's position and velocity based on its state
function updateShip() {
    // If the ship is turning left, decrease its angle by the turn speed
    if (ship.turningLeft) {
        ship.a -= SHIP_TURN_SPEED;
    }

    // If the ship is turning right, increase its angle by the turn speed
    if (ship.turningRight) {
        ship.a += SHIP_TURN_SPEED;
    }

    // If the ship is thrusting, increase its velocity by the thrust amount in the direction of its angle
    if (ship.thrusting) {
        ship.dx += SHIP_THRUST * Math.cos(ship.a);
        ship.dy += SHIP_THRUST * Math.sin(ship.a);
    }

    // If the ship is breaking, decrease its velocity by the thrust amount in the direction of its angle
    if (ship.breaking) {
        ship.dx -= SHIP_THRUST * Math.cos(ship.a);
        ship.dy -= SHIP_THRUST * Math.sin(ship.a);
    }

    // Apply some friction to the ship's velocity to simulate drag
    ship.dx *= SHIP_FRICTION;
    ship.dy *= SHIP_FRICTION;

    // Limit the ship's speed to the max speed
    var speed = Math.sqrt(ship.dx * ship.dx + ship.dy * ship.dy); // calculate the speed using Pythagoras' theorem
    if (speed > SHIP_MAX_SPEED) {
        ship.dx *= SHIP_MAX_SPEED / speed; // scale down the x velocity to the max speed
        ship.dy *= SHIP_MAX_SPEED / speed; // scale down the y velocity to the max speed
    }

    // Update the ship's position by adding its velocity
    ship.x += ship.dx;
    ship.y += ship.dy;

    // Wrap the ship around the edges of the canvas
    if (ship.x < 0) {
        ship.x = canvas.width;
    }
    if (ship.x > canvas.width) {
        ship.x = 0;
    }
    if (ship.y < 0) {
        ship.y = canvas.height;
    }
    if (ship.y > canvas.height) {
        ship.y = 0;
    }

    // If the ship is shooting and can shoot, create a new bullet
    if (ship.shooting && ship.canShoot) {
        createBullet();
        ship.canShoot = false; // prevent rapid fire
    }
}

// Create a new bullet object and push it to the bullets array
function createBullet() {
    var bullet = {
        x: ship.x + Math.cos(ship.a) * SHIP_SIZE / 2, // x coordinate of the bullet's center (same as the tip of the ship)
        y: ship.y + Math.sin(ship.a) * SHIP_SIZE / 2, // y coordinate of the bullet's center (same as the tip of the ship)
        dx: Math.cos(ship.a) * BULLET_SPEED + ship.dx, // x velocity of the bullet (add the ship's velocity for realism)
        dy: Math.sin(ship.a) * BULLET_SPEED + ship.dy, // y velocity of the bullet (add the ship's velocity for realism)
        lifetime: BULLET_LIFETIME // how long the bullet should live in frames
    };
    bullets.push(bullet);
}

// Update the bullet's position and lifetime
function updateBullet(bullet) {
    // Update the bullet's position by adding its velocity
    bullet.x += bullet.dx;
    bullet.y += bullet.dy;

    // Wrap the bullet around the edges of the canvas
    if (bullet.x < 0) {
        bullet.x = canvas.width;
    }
    if (bullet.x > canvas.width) {
        bullet.x = 0;
    }
    if (bullet.y < 0) {
        bullet.y = canvas.height;
    }
    if (bullet.y > canvas.height) {
        bullet.y = 0;
    }

    // Decrease the bullet's lifetime by one
    bullet.lifetime--;

    // If the bullet's lifetime is zero, remove it from the bullets array
    if (bullet.lifetime == 0) {
        var index = bullets.indexOf(bullet); // find the index of the bullet in the array
        if (index != -1) { // if the index is valid
            bullets.splice(index, 1); // remove the bullet from the array
        }
    }
}

// Update the asteroid's position and angle
function updateAsteroid(asteroid) {
    // Update the asteroid's position by adding its velocity
    asteroid.x += asteroid.dx;
    asteroid.y += asteroid.dy;

    // Wrap the asteroid around the edges of the canvas
    if (asteroid.x < 0) {
        asteroid.x = canvas.width;
    }
    if (asteroid.x > canvas.width) {
        asteroid.x = 0;
    }
    if (asteroid.y < 0) {
        asteroid.y = canvas.height;
    }
    if (asteroid.y > canvas.height) {
        asteroid.y = 0;
    }

    // Update the asteroid's angle by adding its angular velocity
    asteroid.a += asteroid.da;
}

// Update the powerup's position and angle
function updatePowerUp(powerup) {
    // Update the powerup's position by adding its velocity
    powerup.x += powerup.dx;
    powerup.y += powerup.dy;

    // Wrap the powerup around the edges of the canvas
    if (powerup.x < 0) {
        powerup.x = canvas.width;
    }
    if (powerup.x > canvas.width) {
        powerup.x = 0;
    }
    if (powerup.y < 0) {
        powerup.y = canvas.height;
    }
    if (powerup.y > canvas.height) {
        powerup.y = 0;
    }

    // Update the powerup's angle by adding its angular velocity
    powerup.a += powerup.da;
}

// Check if the ship is colliding with an asteroid
function checkShipCollision() {
    // Loop through all the asteroids
    for (var i = 0; i < asteroids.length; i++) {
        var asteroid = asteroids[i]; // get the current asteroid

        // Calculate the distance between the ship and the asteroid
        var dx = ship.x - asteroid.x;
        var dy = ship.y - asteroid.y;
        var distance = Math.sqrt(dx * dx + dy * dy); // use Pythagoras' theorem

        // If the distance is less than the sum of their radii, they are colliding
        if (distance < SHIP_SIZE / 2 + asteroid.size / 2) {
            // Set the ship's alive flag to false
            ship.alive = false;

            // Break out of the loop
            break;
        }
    }
}

// Check if the ship is colliding with a powerup
function checkPowerupCollision() {
    // Loop through all the powerups
    for (var i = 0; i < powerUps.length; i++) {
        var powerup = powerUps[i]; // get the current powerup

        // Calculate the distance between the ship and the powerup
        var dx = ship.x - powerup.x;
        var dy = ship.y - powerup.y;
        var distance = Math.sqrt(dx * dx + dy * dy); // use Pythagoras' theorem

        // If the distance is less than the sum of their radii, they are colliding
        if (distance < SHIP_SIZE / 2 + powerup.size / 2) {

            // Set the ship's invincible flag to true
            ship.invincible = true;

            // Remove the powerup from the powerups array
            var index = powerUps.indexOf(powerup); // find the index of the powerup in the array
            if (index != -1) { // if the index is valid
                powerUps.splice(index, 1); // remove the powerup from the array
            }

            makeShipInvincible();

            // Break out of the loop
            break;
        }
    }
}

// Make ship invincible for POWERUP_DURATION frames
function makeShipInvincible() {
    // Set the ship's invincible flag to true
    ship.invincible = true;

    // Set the ship's invincibility timer to POWERUP_DURATION
    ship.invincibleTimer = POWERUP_DURATION;
}

// Update the ship's invincibility timer
function updateShipInvincibility() {
    // If the ship is invincible
    if (ship.invincible) {
        // Decrease the ship's invincibility timer by one
        ship.invincibleTimer--;

        // If the ship's invincibility timer is zero
        if (ship.invincibleTimer == 0) {
            // Set the ship's invincible flag to false
            ship.invincible = false;
        }
    }
}

// Check if a bullet is colliding with an asteroid
function checkBulletCollision(bullet) {
    // Loop through all the asteroids
    for (var i = 0; i < asteroids.length; i++) {
        var asteroid = asteroids[i]; // get the current asteroid

        // Calculate the distance between the bullet and the asteroid
        var dx = bullet.x - asteroid.x;
        var dy = bullet.y - asteroid.y;
        var distance = Math.sqrt(dx * dx + dy * dy); // use Pythagoras' theorem
        // If the distance is less than the sum of their radii, they are colliding
        if (distance < 2 + asteroid.size / 2) {
            // Remove the bullet from the bullets array
            var index = bullets.indexOf(bullet); // find the index of the bullet in the array

            // Create glitter at the asteroid's position
            createGlitter(asteroid.x, asteroid.y, 20); // 20 glitter particles
            
            if (index != -1) { // if the index is valid
                bullets.splice(index, 1); // remove the bullet from the array
            }

            // Remove the asteroid from the asteroids array
            index = asteroids.indexOf(asteroid); // find the index of the asteroid in the array
            if (index != -1) { // if the index is valid
                asteroids.splice(index, 1); // remove the asteroid from the array
            }

            // If the asteroid is large enough, create two smaller asteroids in its place
            if (asteroid.size > ASTEROID_SIZE / 4) {
                createAsteroid(asteroid.x, asteroid.y, asteroid.size / 2); // create a smaller asteroid at the same position with half the size
                createAsteroid(asteroid.x, asteroid.y, asteroid.size / 2); // create another smaller asteroid at the same position with half the size
            }

            // Create a powerup at the asteroid's position with probability POWERUP_PROBA
            if (Math.random() < POWERUP_PROBA){
                createPowerUp(asteroid.x, asteroid.y);
            }

            //Add to the score
            SCORE += 10;

            // Update the high score
            if (SCORE > HIGH_SCORE) {
                HIGH_SCORE = SCORE;
            }

            // Break out of the loop
            break;
        }
    }
}

// Handle key down events
function keyDownHandler(event) {
    var keyCode = event.keyCode; // get the key code of the pressed key

    // If the left arrow key is pressed, set the ship's turning left flag to true
    if (keyCode == KEY_LEFT) {
        ship.turningLeft = true;
    }

    // If the right arrow key is pressed, set the ship's turning right flag to true
    if (keyCode == KEY_RIGHT) {
        ship.turningRight = true;
    }

    // If the up arrow key is pressed, set the ship's thrusting flag to true
    if (keyCode == KEY_UP) {
        ship.thrusting = true;
    }

    // If the down array key is pressed, set the ship's breaking flag to true
    if (keyCode == KEY_DOWN) {
        ship.breaking = true;
    }

    // If the spacebar key is pressed, set the ship's shooting flag to true
    if (keyCode == KEY_SPACE) {
        ship.shooting = true;
    }
}

// Handle key up events
function keyUpHandler(event) {
    var keyCode = event.keyCode; // get the key code of the released key

    // If the left arrow key is released, set the ship's turning left flag to false
    if (keyCode == KEY_LEFT) {
        ship.turningLeft = false;
    }

    // If the right arrow key is released, set the ship's turning right flag to false
    if (keyCode == KEY_RIGHT) {
        ship.turningRight = false;
    }

    // If the up arrow key is released, set the ship's thrusting flag to false
    if (keyCode == KEY_UP) {
        ship.thrusting = false;
    }

    // If the down array key is released, set the ship's breaking flag to false
    if (keyCode == KEY_DOWN) {
        ship.breaking = false;
    }

    // If the spacebar key is released, set the ship's shooting flag to false and its can shoot flag to true
    if (keyCode == KEY_SPACE) {
        ship.shooting = false;
        ship.canShoot = true;
    }
}

// Add event listeners for key down and key up events
document.addEventListener("keydown", keyDownHandler, false);
document.addEventListener("keyup", keyUpHandler, false);

// Prevent the keys from scrolling the page
window.addEventListener("keydown", function(e) {
    // space and arrow keys
    if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].indexOf(e.code) > -1) {
      e.preventDefault();
    }
  }, false);

// Get mouse position
function getMousePos(canvas, event) {
    var rect = canvas.getBoundingClientRect();
    return {
        x: event.clientX - rect.left, // get the x coordinate of the mouse relative to the canvas
        y: event.clientY - rect.top // get the y coordinate of the mouse relative to the canvas
    };
}

// Restart the game
function restartGame() {
    // Reset the score
    SCORE = 0;

    // Reset ship variables
    ship.x = canvas.width / 2;
    ship.y = canvas.height / 2;
    ship.dx = 0;
    ship.dy = 0;
    ship.thrusting = false;
    ship.breaking = false;
    ship.alive = true;
    ship.a = -HALF_PI;
    ship.canShoot = true;
    ship.turningLeft = false;
    ship.turningRight = false;
    ship.shooting = false;
    ship.invincible = false;
    ship.invincibleTimer = 0;

    // Reset the asteroid array
    asteroids = [];

    // Reset the bullet array
    bullets = [];

    // Reset the powerup array
    powerUps = [];

    // Create new asteroids
    for (var i = 0; i < ASTEROID_NUM; i++) {
        createAsteroid();
    }
}

// Game Loop (Kawaii Background and Text)
function gameLoop() {
    // Clear the canvas (Softer background)
    ctx.fillStyle = COLOR_PASTEL_BLUE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // If the ship is alive, update it
    if (ship.alive) {
        drawShip();
        updateShip();
    }

    // Loop through all the bullets, draw and update them
    for (var i = 0; i < bullets.length; i++) {
        var bullet = bullets[i]; // get the current bullet
        drawBullet(bullet);
        updateBullet(bullet);
    }

    // Loop through all the asteroids, draw and update them
    for (var i = 0; i < asteroids.length; i++) {
        var asteroid = asteroids[i]; // get the current asteroid
        drawAsteroid(asteroid);
        updateAsteroid(asteroid);
    }

    // Loop through all the powerups, draw and update them
    for (var i = 0; i < powerUps.length; i++) {
        var powerUp = powerUps[i]; // get the current powerup
        drawPowerUp(powerUp);
        updatePowerUp(powerUp);
    }

    // If ship is not invincible, check for collisions between the ship and the asteroids
    if (!ship.invincible){
        checkShipCollision();
    }

    // Check for collisions between the ship and the powerups
    checkPowerupCollision();

    // Update the ship's invincibility
    updateShipInvincibility();

    // Loop through all the bullets and check for collisions with the asteroids
    for (var i = 0; i < bullets.length; i++) {
        var bullet = bullets[i]; // get the current bullet
        checkBulletCollision(bullet);
    }

    // Update and draw glitter
    updateGlitter();
    for (let i = 0; i < glitterParticles.length; i++) {
        drawGlitter(glitterParticles[i]);
    }

    // Draw the score and high score (Kawaii Font)
    ctx.fillStyle = COLOR_KAWAII_RED;
    ctx.font = "24px 'Comic Sans MS'"; // Example kawaii font (use a web-safe one)
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Score: " + SCORE, 10, 10);

    ctx.fillStyle = COLOR_PASTEL_YELLOW;
    ctx.fillText("High Score: " + HIGH_SCORE, 10, 40);

    // Draw the powerup timer
    ctx.fillStyle = COLOR_PASTEL_GREEN;
    ctx.font = "20px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("Powerup Timer: " + ship.invincibleTimer, canvas.width - 10, 10);

    // With probability create a new asteroid
    if (Math.random() < ASTEROID_PROBA) {
        //if MAX_ASTEROIDS is not reached, create a new asteroid
        if (asteroids.length < MAX_ASTEROIDS){
            createAsteroid();
        }
    }

    // If there are no more asteroids, the game is won
    if (asteroids.length == 0) {
        // Set the fill color to green
        ctx.fillStyle = COLOR_PASTEL_GREEN;

        // Fill a text at the center of the canvas saying "You win!"
        ctx.font = "50px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("You win!", canvas.width / 2, canvas.height / 2);
    }

    // If the ship is not alive, the game is over
    if (!ship.alive) {
        ctx.fillStyle = COLOR_PASTEL_PINK;
        ctx.font = "48px 'Comic Sans MS'"; // Kawaii game over text
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Game Over 🥺", canvas.width / 2, canvas.height / 2 - 20); // Added a cute emoji

        // Restart button (Kawaii Style)
        ctx.fillStyle = COLOR_KAWAII_GREEN;
        ctx.font = "24px 'Comic Sans MS'";
        ctx.fillText("Restart ✨", canvas.width / 2, canvas.height / 2 + 40); // Added sparkles

        // If the mouse is clicked
        canvas.addEventListener("mousedown", function(event) {
            // Get the mouse position
            var mousePos = getMousePos(canvas, event);

            // If the mouse is clicked on the restart button
            if (mousePos.x > canvas.width / 2 - 50 && mousePos.x < canvas.width / 2 + 50 && mousePos.y > canvas.height / 2 + 40 && mousePos.y < canvas.height / 2 + 60) {
                restartGame(); // restart the game
            }
        });
    }

    // Request the next animation frame
    requestAnimationFrame(gameLoop);
    }

    // Start the game loop
    gameLoop();
