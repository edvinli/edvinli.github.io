// Get the canvas element and its context
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

const dino = {
    x: 50,
    y: 200,
    width: 50,
    height: 100, // Increased height
    color: 'green',
    dy: 0,
    gravity: 0.6,
    jumpStrength: 20
};

let obstacles = []; // Array to hold multiple obstacles

function createObstacle() {
    const minSpacing = 150; // Minimum distance between obstacles (adjust as needed)

    let newObstacleX;
    let validPosition = false;

    // Try generating positions until a valid one is found
    while (!validPosition) {
        newObstacleX = canvas.width;  // Start at the right edge
        validPosition = true; // Assume valid until proven otherwise

        for (let i = 0; i < obstacles.length; i++) {
            const existingObstacle = obstacles[i];
            const distance = Math.abs(newObstacleX - existingObstacle.x);
            if (distance < minSpacing) {
                validPosition = false; // Overlap detected, try again
                break; // No need to check other obstacles
            }
        }
    }

    const obstacle = {
        x: newObstacleX, // Use the valid x position
        y: canvas.height - 50,
        width: 50,
        height: 50,
        color: 'red',
        speed: 3
    };
    obstacles.push(obstacle);
}


function drawDino() {
    ctx.fillStyle = dino.color;
    ctx.fillRect(dino.x, dino.y, dino.width, dino.height);
}

function drawObstacles() {  // Draw all obstacles
    for (let i = 0; i < obstacles.length; i++) {
        ctx.fillStyle = obstacles[i].color;
        ctx.fillRect(obstacles[i].x, obstacles[i].y, obstacles[i].width, obstacles[i].height);
    }
}

function update() {
    // 1. Remove obstacles that have gone off-screen (in reverse order)
    for (let i = obstacles.length - 1; i >= 0; i--) {  // Iterate backwards!
        obstacles[i].x -= obstacles[i].speed;
        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1); // Remove obstacle
        }
    }

    // 2. Create a new obstacle *only if needed*
    if (obstacles.length === 0 || obstacles[obstacles.length - 1].x > canvas.width / 2) { // Check if no obstacles or if the last one is far enough
        createObstacle();
    }

    // Apply gravity to dino
    dino.dy += dino.gravity;
    dino.y += dino.dy;

    // Prevent dino from falling through the ground
    if (dino.y + dino.height > canvas.height) {
        dino.y = canvas.height - dino.height;
        dino.dy = 0;
    }

    // Check for collision with any obstacle
    for (let i = 0; i < obstacles.length; i++) {
        // ... (collision code remains the same)
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDino();
    drawObstacles(); // Draw all obstacles
}

function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
}

document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && dino.y + dino.height === canvas.height) {
        dino.dy = -dino.jumpStrength;
    }
});

// Initialize obstacles with a random delay
setTimeout(createObstacle, Math.random() * 2000 + 1000); // First obstacle after 1-3 seconds
setInterval(createObstacle, Math.random() * 3000 + 1500); // Create new obstacles every 1.5-4.5 seconds

gameLoop();
