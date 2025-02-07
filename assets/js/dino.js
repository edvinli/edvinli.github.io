const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const size = 350;
canvas.width = size;
canvas.height = size;
canvas.style.border = '1px solid black';

let player = {
    x: 50,
    y: size - 50,
    radius: 15,
    yVelocity: 0,
    gravity: 1.1,
    jumpStrength: -15,
    isJumping: false,
    xVelocity: 0,
    speed: 5,
};

let obstacles = [];
let obstacleSpeed = 9;
let score = 0;
let gameRunning = true;
let lastTime = 0;

// --- Touch Control Variables ---
let touchStartX = null;
let touchEndX = null;
const touchThreshold = 30; // Minimum distance for a swipe to register

function drawPlayer() {
    ctx.fillStyle = 'green';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    ctx.fill();
}

function drawObstacle(obstacle) {
    ctx.fillStyle = 'black';
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
}

function updatePlayer(deltaTime) {
    if (player.isJumping) {
        player.yVelocity += player.gravity * (deltaTime / 16.67);
        player.y += player.yVelocity * (deltaTime / 16.67);

        if (player.y > size - 50) {
            player.y = size - 50;
            player.yVelocity = 0;
            player.isJumping = false;
        }
    }

    player.x += player.xVelocity * (deltaTime / 16.67);

    if (player.x - player.radius < 0) {
        player.x = player.radius;
        player.xVelocity = 0;
    } else if (player.x + player.radius > size) {
        player.x = size - player.radius;
        player.xVelocity = 0;
    }
}

function generateObstacle() {
    const height = Math.floor(Math.random() * (50 - 20 + 1)) + 20;
    const width = Math.floor(Math.random() * (40 - 20 + 1)) + 20;
    obstacles.push({
        x: size,
        y: size - height,
        width: width,
        height: height
    });
}

function updateObstacles(deltaTime) {
    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].x -= obstacleSpeed * (deltaTime / 16.67);

        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
            i--;
            score++;
            if (score % 5 == 0 && score != 0) {
                obstacleSpeed += 1 * (deltaTime / 16.67);
            }
        }
    }
    if (obstacles.length == 0 || obstacles[obstacles.length - 1].x < size - 150) {
        if (Math.random() < 0.02) {
            generateObstacle();
        }
    }
}

function checkCollision() {
    for (let obstacle of obstacles) {
        let distX = Math.abs(player.x - obstacle.x - obstacle.width / 2);
        let distY = Math.abs(player.y - obstacle.y - obstacle.height / 2);

        if (distX > (obstacle.width / 2 + player.radius)) { continue; }
        if (distY > (obstacle.height / 2 + player.radius)) { continue; }

        if (distX <= (obstacle.width / 2)) { return true; }
        if (distY <= (obstacle.height / 2)) { return true; }

        let dx = distX - obstacle.width / 2;
        let dy = distY - obstacle.height / 2;
        return (dx * dx + dy * dy <= (player.radius * player.radius));
    }
    return false;
}

function drawScore() {
    ctx.fillStyle = 'black';
    ctx.font = '20px Arial';
    ctx.fillText('Score: ' + score, 10, 30);
}

function drawGameOver() {
    ctx.fillStyle = 'black';
    ctx.font = '40px Arial';
    ctx.fillText('Game Over', size / 4, size / 2);
    ctx.font = '20px Arial';
    ctx.fillText('Jump to Restart', size / 4 + 20, size / 2 + 40);
}

function restartGame() {
    player = {
        x: 50,
        y: size - 50,
        radius: 15,
        yVelocity: 0,
        gravity: 1.1,
        jumpStrength: -15,
        isJumping: false,
        xVelocity: 0,
        speed: 5,
    };
    obstacles = [];
    obstacleSpeed = 9;
    score = 0;
    gameRunning = true;
    lastTime = 0;
    // Reset touch variables
    touchStartX = null;
    touchEndX = null;
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    if (!gameRunning) {
        drawGameOver();
        return;
    }

    let deltaTime = timestamp - lastTime;
    lastTime = timestamp;

    ctx.clearRect(0, 0, size, size);

    updatePlayer(deltaTime);
    updateObstacles(deltaTime);

    if (checkCollision()) {
        gameRunning = false;
    }

    drawPlayer();
    for (let obstacle of obstacles) {
        drawObstacle(obstacle);
    }
    drawScore();

    requestAnimationFrame(gameLoop);
}

function jump() {
    if (gameRunning) {
        if (!player.isJumping) {
            player.yVelocity = player.jumpStrength;
            player.isJumping = true;
        }
    } else {
        restartGame();
    }
}


// --- Touch Event Handlers ---

canvas.addEventListener('touchstart', (event) => {
    event.preventDefault(); // Prevent default touch behavior (scrolling, zooming)
    touchStartX = event.touches[0].clientX;
    touchEndX = event.touches[0].clientX; // Initialize touchEndX

     // If there's no ongoing touch, consider this a potential jump
     if (event.touches.length === 1 ) {
        jump();  //Consider any touch as potential jump
    }
});

canvas.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (touchStartX !== null) {
        touchEndX = event.touches[0].clientX;
    }
});

canvas.addEventListener('touchend', (event) => {
    event.preventDefault();
    if (touchStartX !== null && touchEndX !== null) {
        const deltaX = touchEndX - touchStartX;

        if (deltaX > touchThreshold) {
            player.xVelocity = player.speed; // Move right
        } else if (deltaX < -touchThreshold) {
            player.xVelocity = -player.speed; // Move left
        } else{
            player.xVelocity = 0;
        }
    }
     // Reset touch variables for next gesture
     touchStartX = null;
     touchEndX = null;
});

// --- Keyboard Controls (Keep for PC/Debugging) ---
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'ArrowUp') {
        jump();
    }
    if (event.code === 'ArrowLeft') {
        player.xVelocity = -player.speed;
    } else if (event.code === 'ArrowRight') {
        player.xVelocity = player.speed;
    }
});

document.addEventListener('keyup', (event) => {
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        player.xVelocity = 0;
    }
});

requestAnimationFrame(gameLoop);
