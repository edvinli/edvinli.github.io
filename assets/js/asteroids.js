// Get the canvas element and its context
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

// Define some constants
var PI = Math.PI;
var TWO_PI = 2 * PI;
var HALF_PI = PI / 2;
var SHIP_SIZE = 20; // pixels
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

// Define some colors
var COLOR_BLACK = "black";
var COLOR_WHITE = "white";
var COLOR_RED = "red";
var COLOR_GREEN = "green";
var COLOR_BLUE = "blue";

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
    breaking: false // whether the ship is breaking or not
};

var bullets = []; // array of bullet objects

var asteroids = []; // array of asteroid objects

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

// Draw the ship on the canvas
function drawShip() {
    // Save the current context state
    ctx.save();

    // Translate the context to the ship's center
    ctx.translate(ship.x, ship.y);

    // Rotate the context to the ship's angle
    ctx.rotate(ship.a);

    // Set the stroke color to white
    ctx.strokeStyle = COLOR_WHITE;

    // Begin a new path
    ctx.beginPath();

    // Move to the tip of the ship
    ctx.moveTo(SHIP_SIZE / 2, 0);

    // Draw a line to the bottom right of the ship
    ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 3);

    // Draw a line to the bottom left of the ship
    ctx.lineTo(-SHIP_SIZE / 2, -SHIP_SIZE / 3);

    // Close the path
    ctx.closePath();

    // Stroke the path
    ctx.stroke();

    // If the ship is thrusting, draw a flame behind it
    if (ship.thrusting) {
        // Set the stroke color to red
        ctx.strokeStyle = COLOR_RED;

        // Begin a new path
        ctx.beginPath();

        // Move to the bottom left of the ship
        ctx.moveTo(-SHIP_SIZE / 2, -SHIP_SIZE / 3);

        // Draw a line to a random point behind the ship
        ctx.lineTo(-SHIP_SIZE / 2 - Math.random() * SHIP_SIZE / 2, 0);

        // Draw a line to the bottom right of the ship
        ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 3);

        // Close the path
        ctx.closePath();

        // Stroke the path
        ctx.stroke();
    }

    // If the ship is breaking, draw a blue flame behind it (instead of red)
    if (ship.breaking) {
        // Set the stroke color to blue
        ctx.strokeStyle = COLOR_BLUE;

        // Begin a new path
        ctx.beginPath();

        // Move to the bottom left of the ship
        ctx.moveTo(-SHIP_SIZE / 2, -SHIP_SIZE / 3);

        // Draw a line to a random point behind the ship
        ctx.lineTo(-SHIP_SIZE / 2 - Math.random() * SHIP_SIZE / 2, 0);

        // Draw a line to the bottom right of the ship
        ctx.lineTo(-SHIP_SIZE / 2, SHIP_SIZE / 3);

        // Close the path
        ctx.closePath();

        // Stroke the path
        ctx.stroke();
    }

    // Restore the context state
    ctx.restore();
}

// Draw a bullet on the canvas
function drawBullet(bullet) {
    // Set the fill color to white
    ctx.fillStyle = COLOR_WHITE;

    // Fill a circle at the bullet's position with a radius of 2 pixels
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, 2, 0, TWO_PI);
    ctx.fill();
}

// Draw an asteroid on the canvas
function drawAsteroid(asteroid) {
    // Save the current context state
    ctx.save();

    // Translate the context to the asteroid's center
    ctx.translate(asteroid.x, asteroid.y);

    // Rotate the context to the asteroid's angle
    ctx.rotate(asteroid.a);

    // Set the stroke color to white
    ctx.strokeStyle = COLOR_WHITE;

    // Begin a new path
    ctx.beginPath();

    // Move to the first vertex of the asteroid
    ctx.moveTo(asteroid.vertices[0].x, asteroid.vertices[0].y);

    // Loop through the rest of the vertices and draw lines to them
    for (var i = 1; i < asteroid.vertices.length; i++) {
        ctx.lineTo(asteroid.vertices[i].x, asteroid.vertices[i].y);
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

// The main game loop
function gameLoop() {
    // Clear the canvas
    ctx.fillStyle = COLOR_BLACK;
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
    
        // Check for collisions between the ship and the asteroids
        checkShipCollision();
    
        // Loop through all the bullets and check for collisions with the asteroids
        for (var i = 0; i < bullets.length; i++) {
            var bullet = bullets[i]; // get the current bullet
            checkBulletCollision(bullet);
        }
    
        // If there are no more asteroids, the game is won
        if (asteroids.length == 0) {
            // Set the fill color to green
            ctx.fillStyle = COLOR_GREEN;
    
            // Fill a text at the center of the canvas saying "You win!"
            ctx.font = "50px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("You win!", canvas.width / 2, canvas.height / 2);
        }
    
        // If the ship is not alive, the game is over
        if (!ship.alive) {
            // Set the fill color to red
            ctx.fillStyle = COLOR_RED;
    
            // Fill a text at the center of the canvas saying "Game over"
            ctx.font = "50px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Game over", canvas.width / 2, canvas.height / 2);
        }
    
        // Request the next animation frame
        requestAnimationFrame(gameLoop);
    }
    
    // Start the game loop
    gameLoop();