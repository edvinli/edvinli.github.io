const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const dino = {
    x: 50,
    y: 200,
    width: 50,
    height: 50,
    color: 'green',
    dy: 0,
    gravity: 0.5,
    jumpStrength: 10
};

const obstacle = {
    x: canvas.width,
    y: 200,
    width: 50,
    height: 50,
    color: 'red',
    speed: 3
};

function drawDino() {
    ctx.fillStyle = dino.color;
    ctx.fillRect(dino.x, dino.y, dino.width, dino.height);
}

function drawObstacle() {
    ctx.fillStyle = obstacle.color;
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
}

function update() {
    // Move obstacle
    obstacle.x -= obstacle.speed;
    if (obstacle.x + obstacle.width < 0) {
        obstacle.x = canvas.width;
    }

    // Apply gravity to dino
    dino.dy += dino.gravity;
    dino.y += dino.dy;

    // Prevent dino from falling through the ground
    if (dino.y + dino.height > canvas.height) {
        dino.y = canvas.height - dino.height;
        dino.dy = 0;
    }

    // Check for collision
    if (dino.x < obstacle.x + obstacle.width &&
        dino.x + dino.width > obstacle.x &&
        dino.y < obstacle.y + obstacle.height &&
        dino.y + dino.height > obstacle.y) {
        alert('Game Over!');
        document.location.reload();
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDino();
    drawObstacle();
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

gameLoop();
