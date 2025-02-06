// Get the canvas element and its context
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

const dino = {
    x: 50,
    y: 200,
    width: 50,
    height: 100,
    color: 'green',
    dy: 0,
    gravity: 0.5,
    jumpStrength: 20
};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    adjustGameElements();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function adjustGameElements() {
    dino.width = canvas.width * 0.1;
    dino.height = dino.width * 2;
    dino.x = canvas.width * 0.1;
    dino.y = canvas.height * 0.6;

    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].width = canvas.width * 0.05;
        obstacles[i].height = obstacles[i].width;
        obstacles[i].y = canvas.height - obstacles[i].height;
        obstacles[i].speed = canvas.width * 0.003;
    }
}

let obstacles = [];
const maxObstacles = 5; // Limit the number of obstacles

function createObstacle() {
    const minSpacing = dino.width * 2;  // Spacing relative to dino size
    let newObstacleX = canvas.width;
    let validPosition = true;

    if (obstacles.length > 0) {
        const lastObstacle = obstacles[obstacles.length - 1];
        if (lastObstacle.x + lastObstacle.width + minSpacing > canvas.width) {
            validPosition = false; // Don't create if too close to the last one
        }
    }


    if (validPosition) {
        const obstacle = {
            x: newObstacleX,
            y: canvas.height - dino.height / 1.5, // Align with dino's bottom
            width: dino.width / 2, // Half the dino's width
            height: dino.width / 2,
            color: 'red',
            speed: dino.width * 0.005 // Speed relative to dino size
        };
        obstacles.push(obstacle);
    }
}

function handleJump() {
    if (dino.y + dino.height === canvas.height) {
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
    // Remove off-screen obstacles
    for (let i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= obstacles[i].speed;
        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
        }
    }

    // Create new obstacle if needed
    if (obstacles.length < maxObstacles && (obstacles.length === 0 || obstacles[obstacles.length - 1].x < canvas.width * 0.7)) { // Slightly earlier spawn
        createObstacle();
    }


    dino.dy += dino.gravity;
    dino.y += dino.dy;

    if (dino.y + dino.height > canvas.height) {
        dino.y = canvas.height - dino.height;
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
