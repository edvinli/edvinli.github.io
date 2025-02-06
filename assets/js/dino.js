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
    gravity: 0.5,
    jumpStrength: 10
};

let obstacles = []; // Array to hold multiple obstacles

function createObstacle() {
    const obstacle = {
        x: canvas.width,
        y: canvas.height - 50, //
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
    // Update obstacles
    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].x -= obstacles[i].speed;
        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1); // Remove obstacle from array
            createObstacle();      // Create a new one
        }
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
