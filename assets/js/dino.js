const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const GROUND_LEVEL = 0.8;
const GRAVITY = 0.5;
const JUMP_STRENGTH = 20;
const BASE_OBSTACLE_SPEED = 5;
const MIN_OBSTACLE_SPACING = 200;
const MAX_OBSTACLE_SPACING = 500;
const MIN_OBSTACLE_SPAWNING = 500;
const MAX_OBSTACLE_SPAWNING = 1500;

let dino = {
    x: 50,
    y: 0,
    width: 50,
    height: 100,
    color: 'green',
    dy: 0,
    gravity: GRAVITY,
    jumpStrength: JUMP_STRENGTH
};

let obstacles = []; // Initialize as an empty array
const maxObstacles = 5;
let gameStarted = false;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const aspectRatio = 16 / 9;
    canvas.height = Math.min(canvas.height, canvas.width / aspectRatio);

    adjustGameElements(); // Crucial: Call AFTER resize
}

resizeCanvas(); // Call initially
window.addEventListener('orientationchange', resizeCanvas);
window.addEventListener('resize', resizeCanvas);

function adjustGameElements() {
    dino.width = canvas.width * 0.05;
    dino.height = dino.width * 2;
    dino.x = canvas.width * 0.1;
    dino.y = canvas.height * GROUND_LEVEL - dino.height;

    for (let obstacle of obstacles) {
        obstacle.width = canvas.width * 0.03;
        obstacle.height = obstacle.width;
        obstacle.y = canvas.height * GROUND_LEVEL - obstacle.height;
    }
}

function createObstacle() {
    let newObstacleX = canvas.width;

    if (obstacles.length > 0) {
        const lastObstacle = obstacles[obstacles.length - 1];
        newObstacleX = lastObstacle.x + lastObstacle.width + MIN_OBSTACLE_SPACING + Math.random() * (MAX_OBSTACLE_SPACING - MIN_OBSTACLE_SPACING);
        if (newObstacleX - dino.x < 200) return; // Don't create if too close to dino
        if (newObstacleX > canvas.width) return; // Don't create if off-screen
    }

    const obstacle = {
        x: newObstacleX,
        y: canvas.height * GROUND_LEVEL - dino.height / 1.5,
        width: dino.width / 2,
        height: dino.width / 2,
        color: 'red',
        speed: BASE_OBSTACLE_SPEED
    };
    obstacles.push(obstacle);
}

function handleJump(event) {
    if (!gameStarted) {
        gameStarted = true;
        obstacleSpawner();
    }
    if (dino.y + dino.height === canvas.height * GROUND_LEVEL) {
        dino.dy = -dino.jumpStrength;
    }

    if (event) {
        event.preventDefault();
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
    if (!gameStarted) return;

    obstacles = obstacles.filter(obstacle => obstacle.x + obstacle.width > 0);

    dino.dy += dino.gravity;
    dino.y += dino.dy;

    if (dino.y + dino.height > canvas.height * GROUND_LEVEL) {
        dino.y = canvas.height * GROUND_LEVEL - dino.height;
        dino.dy = 0;
    }

    for (let obstacle of obstacles) {
        obstacle.x -= obstacle.speed;

        if (dino.x < obstacle.x + obstacle.width &&
            dino.x + dino.width > obstacle.x &&
            dino.y < obstacle.y + obstacle.height &&
            dino.y + dino.height > obstacle.y) {
            gameOver();
            return;
        }
    }
}

function gameOver() {
    gameStarted = false;
    obstacles =; // Clear the obstacles array
    alert("Game Over!"); // Replace with a game over screen
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

function obstacleSpawner() {
    if (gameStarted) {
        createObstacle();
        const randomDelay = Math.random() * (MAX_OBSTACLE_SPAWNING - MIN_OBSTACLE_SPAWNING) + MIN_OBSTACLE_SPAWNING;
        setTimeout(obstacleSpawner, randomDelay);
    }
}

gameLoop(); // Start the game loop
