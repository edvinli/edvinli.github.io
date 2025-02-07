const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const size = 350;
canvas.width = size;
canvas.height = size;
canvas.style.border = '1px solid black';

// --- Constants ---
const c = 30; // Speed of light (scaled down for gameplay)

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
const touchThreshold = 30;

// --- Settings ---
let settingsOpen = false;
let obstacleSpeedSetting = 9; // Initial obstacle speed

// --- Relativistic Effects ---
function lorentzFactor(v) {
    // Avoid division by zero or invalid input
    if (v >= c) {
        return Infinity; // Or a very large number
    }
    return 1 / Math.sqrt(1 - (v * v) / (c * c));
}

function relativisticLengthContraction(originalLength, v) {
    return originalLength / lorentzFactor(v);
}

function drawPlayer() {
    ctx.fillStyle = 'green';
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    ctx.fill();
}

function drawObstacle(obstacle) {
    ctx.fillStyle = 'black';
    // Apply length contraction
    const contractedWidth = relativisticLengthContraction(obstacle.width, obstacleSpeedSetting);

     //Position the obstacle correctly after contraction
    const contractedX = obstacle.x + (obstacle.width - contractedWidth)

    ctx.fillRect(contractedX, obstacle.y, contractedWidth, obstacle.height);
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
        height: height,
        originalWidth: width, // Store original width for relativistic calculations
    });
}

function updateObstacles(deltaTime) {
    for (let i = 0; i < obstacles.length; i++) {
         //Use the setting, not the actual speed (which gets modified by score)
        obstacles[i].x -= obstacleSpeedSetting * (deltaTime / 16.67);

        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
            i--;
            score++;
            if (score % 5 == 0 && score != 0) {
                 //Don't modify obstacleSpeed directly.  Increase it, but keep it relative to the setting.
                obstacleSpeed += 1 * (deltaTime/16.67);
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
        // Use contracted width for collision check.
        const contractedWidth = relativisticLengthContraction(obstacle.originalWidth, obstacleSpeedSetting);
        const contractedX = obstacle.x + (obstacle.originalWidth - contractedWidth);

        let distX = Math.abs(player.x - contractedX - contractedWidth / 2);
        let distY = Math.abs(player.y - obstacle.y - obstacle.height / 2);

        if (distX > (contractedWidth / 2 + player.radius)) { continue; }
        if (distY > (obstacle.height / 2 + player.radius)) { continue; }

        if (distX <= (contractedWidth / 2)) { return true; }
        if (distY <= (obstacle.height / 2)) { return true; }

        let dx = distX - contractedWidth / 2;
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
    obstacleSpeed = obstacleSpeedSetting; // Reset to the setting value
    score = 0;
    gameRunning = true;
    lastTime = 0;
    touchStartX = null;
    touchEndX = null;
    requestAnimationFrame(gameLoop);
}
// --- Settings UI ---
function openSettings() {
    settingsOpen = true;
    // Create settings UI elements (using DOM manipulation)
    const settingsDiv = document.createElement('div');
    settingsDiv.id = 'settings-panel';
    settingsDiv.style.position = 'absolute';
    settingsDiv.style.top = '50px';
    settingsDiv.style.left = '50px';
    settingsDiv.style.backgroundColor = 'white';
    settingsDiv.style.border = '1px solid black';
    settingsDiv.style.padding = '10px';

    const speedLabel = document.createElement('label');
    speedLabel.textContent = 'Obstacle Speed: ';
    settingsDiv.appendChild(speedLabel);

    const speedInput = document.createElement('input');
    speedInput.type = 'range';
    speedInput.min = '1';
    speedInput.max = String(c -1); // Max speed is c-1 (avoiding Infinity)
    speedInput.value = String(obstacleSpeedSetting);
    speedInput.id = 'speed-input';
    settingsDiv.appendChild(speedInput);

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.onclick = closeSettings;
    settingsDiv.appendChild(closeButton);

    document.body.appendChild(settingsDiv);

    // Update obstacle speed setting on input change
    speedInput.addEventListener('input', () => {
        obstacleSpeedSetting = parseFloat(speedInput.value);
        // console.log("Setting Speed", obstacleSpeedSetting)
    });
}

function closeSettings() {
    settingsOpen = false;
    const settingsDiv = document.getElementById('settings-panel');
    if (settingsDiv) {
        settingsDiv.remove();
    }
    //Restart the game with the new settings.
    restartGame();
}

// --- Main Game Loop ---
function gameLoop(timestamp) {
    if (!gameRunning) {
        drawGameOver();
        return;
    }
     if (settingsOpen) {
        // Don't update game logic if settings are open
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
    event.preventDefault();
    touchStartX = event.touches[0].clientX;
    touchEndX = event.touches[0].clientX;
    if (event.touches.length === 1) {
        jump();
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
            player.xVelocity = player.speed;
        } else if (deltaX < -touchThreshold) {
            player.xVelocity = -player.speed;
        } else {
            player.xVelocity = 0;
        }
    }
    touchStartX = null;
    touchEndX = null;
});

// --- Keyboard Controls ---
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'ArrowUp') {
        jump();
    }
    if (event.code === 'ArrowLeft') {
        player.xVelocity = -player.speed;
    } else if (event.code === 'ArrowRight') {
        player.xVelocity = player.speed;
    }
    // Open settings with 'S' key
    if (event.code === 'KeyS') {
        if (!settingsOpen) {
            openSettings();
        }
    }
});

document.addEventListener('keyup', (event) => {
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        player.xVelocity = 0;
    }
});
requestAnimationFrame(gameLoop);
