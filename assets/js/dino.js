// Get the canvas element and its context
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;  // Full screen width
    canvas.height = window.innerHeight; // Full screen height

    // Or, for a specific aspect ratio (e.g., 16:9):
    // const aspectRatio = 16 / 9;
    // canvas.width = window.innerWidth;
    // canvas.height = window.innerWidth / aspectRatio;

    // Adjust game elements (dino, obstacles, etc.) based on new canvas size
    adjustGameElements(); // See explanation below
}

window.addEventListener('resize', resizeCanvas); // Resize on orientation change or window resize
resizeCanvas(); // Initial resize

function adjustGameElements() {
    // Example: Adjust dino size and position
    dino.width = canvas.width * 0.1; // 10% of canvas width
    dino.height = dino.width * 2;   // Maintain aspect ratio
    dino.x = canvas.width * 0.1;      // 10% from the left
    dino.y = canvas.height * 0.6;     // 60% from the top

    // Adjust obstacle sizes, positions, speeds, etc., similarly
    for(let i = 0; i < obstacles.length; i++){
        obstacles[i].width = canvas.width * 0.05;
        obstacles[i].height = obstacles[i].width;
        obstacles[i].y = canvas.height - obstacles[i].height;
        obstacles[i].speed = canvas.width * 0.003;
    }
}

canvas.addEventListener('touchstart', (event) => {
    // Get the touch position relative to the canvas
    const touch = event.touches[0];
    const touchX = touch.clientX - canvas.offsetLeft;
    const touchY = touch.clientY - canvas.offsetTop;

    // Example: Make dino jump on touch
    if (dino.y + dino.height === canvas.height) {
        dino.dy = -dino.jumpStrength;
    }

    event.preventDefault(); // Prevent default touch behavior (like scrolling)
});

const dino = {
    x: 50,
    y: 200,
    width: 50,
    height: 100, // Increased height
    color: 'green',
    dy: 0,
    gravity: 0.5,
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

const maxObstacles = 5; // Set your desired maximum number of obstacles

function update() {
    // 1. Remove obstacles that have gone off-screen (in reverse order)
    for (let i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= obstacles[i].speed;
        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
        }
    }

    // 2. Create a new obstacle *only if needed* AND below the max number
    if ((obstacles.length === 0 || obstacles[obstacles.length - 1].x > canvas.width / 2) && obstacles.length < maxObstacles) {
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

    // Check for collision with any obstacle  <-- This was missing!
    for (let i = 0; i < obstacles.length; i++) {
        if (dino.x < obstacles[i].x + obstacles[i].width &&
            dino.x + dino.width > obstacles[i].x &&
            dino.y < obstacles[i].y + obstacles[i].height &&
            dino.y + dino.height > obstacles[i].y) {
            alert('Game Over!');
            document.location.reload();
            break; // Exit the loop after collision
        }
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
