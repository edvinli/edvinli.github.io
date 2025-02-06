const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let dino = {
    x: 50,
    y: 0, // Initial y will be set in resizeCanvas
    width: 50,
    height: 100,
    color: 'green',
    dy: 0,
    gravity: 0.5,
    jumpStrength: 20
};

let obstacles = [];
const maxObstacles = 5;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    adjustGameElements();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Call initially

function adjustGameElements() {
    const aspectRatio = 16 / 9; // Example aspect ratio
    canvas.height = Math.min(canvas.height, canvas.width / aspectRatio); // Maintain aspect ratio
    dino.width = canvas.width * 0.05;
    dino.height = dino.width * 2;
    dino.x = canvas.width * 0.1;
    dino.y = canvas.height * 0.7 - dino.height; // Adjusted y for consistent ground level

    for (let obstacle of obstacles) {
        obstacle.width = canvas.width * 0.03;  // Adjust obstacle size
        obstacle.height = obstacle.width;
        obstacle.y = canvas.height * 0.7 - obstacle.height; // Match dino's ground level
        obstacle.speed = canvas.width * 0.005;
    }
}

function createObstacle() {
    const minSpacing = dino.width * 2;
    let newObstacleX = canvas.width;

    if (obstacles.length > 0) {
        const lastObstacle = obstacles[obstacles.length - 1];
        if (lastObstacle.x + lastObstacle.width + minSpacing > canvas.width) {
            return; // Don't create if too close
        }
    }

    const obstacle = {
        x: newObstacleX,
        y: canvas.height * 0.7 - dino.height / 1.5, // Consistent ground for obstacles
        width: dino.width / 2,
        height: dino.width / 2,
        color: 'red',
        speed: dino.width * 0.005
    };
    obstacles.push(obstacle);
}

function handleJump() {
    if (dino.y + dino.height === canvas.height * 0.7) { // Check against adjusted ground
        dino.dy = -dino.jumpStrength;
    }
}

function drawDino() {
    ctx.fillStyle = dino.color;
    ctx.fillRect(dino.x, dino.y, dino.width, dino.height);
}

function drawObstacles() {
    for (let obstacle of obstacles) {
        ctx.fillStyle = obstacle.color;
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
    }
}

function update() {
    // Remove off-screen obstacles (more efficient loop)
    obstacles = obstacles.filter(obstacle => obstacle.x + obstacle.width > 0);

    // Create new obstacle (improved logic)
    if (obstacles.length < maxObstacles) {
        if (obstacles.length === 0 || obstacles[obstacles.length - 1].x < canvas.width * 0.6) {
            createObstacle();
        }
    }

    dino.dy += dino.gravity;
    dino.y += dino.dy;

    if (dino.y + dino.height > canvas.height * 0.7) { // Adjusted ground check
        dino.y = canvas.height * 0.7 - dino.height; // Set to ground level
        dino.dy = 0;
    }

    // Collision detection
    for (let obstacle of obstacles) {
        if (dino.x < obstacle.x + obstacle.width &&
            dino.x + dino.width > obstacle.x &&
            dino.y < obstacle.y + obstacle.height &&
            dino.y + dino.height > obstacle.y) {
            alert('Game Over!');
            document.location.reload();
            return; // Important: Exit update after collision
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDino();
    drawObstacles();
}

function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
}

canvas.addEventListener('touchstart', handleJump);
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
        handleJump();
    }
});

// Initial obstacle creation and interval
setTimeout(createObstacle, 1000); // Initial delay
setInterval(createObstacle, 2000); // Interval

gameLoop();
