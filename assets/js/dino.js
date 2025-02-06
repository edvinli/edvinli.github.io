const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const GROUND_LEVEL = 0.8;
const GRAVITY = 0.5;
const JUMP_STRENGTH = 20;
const BASE_OBSTACLE_SPEED = 5;
const OBSTACLE_SPAWN_RATE = 1500;

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

let obstacles = [];
const maxObstacles = 5;
let gameStarted = false;

// Set a fixed size for the canvas (adjust as needed)
canvas.width = 800;
canvas.height = 450;

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

adjustGameElements();

function createObstacle() {
    const minSpacing = dino.width * 2;
    let newObstacleX = canvas.width;

    if (obstacles.length > 0) {
        const lastObstacle = obstacles[obstacles.length - 1];
        if (lastObstacle.x + lastObstacle.width + minSpacing > canvas.width) {
            return;
        }
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

function handleJump() {
    if (!gameStarted) {
        gameStarted = true;
        obstacleSpawner();
    }
    if (dino.y + dino.height === canvas.height * GROUND_LEVEL) {
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
    obstacles = [];
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
        setTimeout(obstacleSpawner, OBSTACLE_SPAWN_RATE);
    }
}

gameLoop(); // Start the game loop
