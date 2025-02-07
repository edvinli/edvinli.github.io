const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const size = 350;
canvas.width = size;
canvas.height = size;
canvas.style.border = '1px solid black';

// --- Constants ---
const c = 30; // Speed of light (scaled down)
const GROUND_LEVEL = size - 50;
const PLAYER_RADIUS = 15;
const OBSTACLE_GENERATION_PROBABILITY = 0.02;
const OBSTACLE_SPACING = 150;
const targetFrameTime = 1000 / 60; // 60 FPS target
const touchThreshold = 30;
const JUMP_DEBOUNCE_TIME = 250;
const SETTINGS_BUTTON_SIZE = 30; // Size of the settings button
const SETTINGS_BUTTON_PADDING = 5; // Padding around the button

// --- Game State ---
let gameState = {
    player: {
        x: 50,
        y: GROUND_LEVEL,
        radius: PLAYER_RADIUS,
        yVelocity: 0,
        gravity: 1.1,
        jumpStrength: -15,
        isJumping: false,
        xVelocity: 0,
        speed: 5,
    },
    obstacles: [],
    obstaclePool: [], // Object pool
    obstacleSpeed: 9,
    obstacleSpeedSetting: 9, // Initial obstacle speed setting
    score: 0,
    gameRunning: true,
    lastTime: 0,
    settingsOpen: false,
    touchStartX: null,
    touchEndX: null,
    canJump: true,
};

// --- Relativistic Effects ---
function lorentzFactor(v) {
    if (v >= c) {
        return Infinity;
    }
    return 1 / Math.sqrt(1 - (v * v) / (c * c));
}

function relativisticLengthContraction(originalLength, v) {
    return originalLength / lorentzFactor(v);
}

// --- Drawing Functions ---
function drawPlayer() {
    ctx.fillStyle = 'green';
    ctx.beginPath();
    ctx.arc(gameState.player.x, gameState.player.y, gameState.player.radius, 0, 2 * Math.PI);
    ctx.fill();
}

function drawObstacle(obstacle) {
    ctx.fillStyle = 'black';
    const contractedWidth = relativisticLengthContraction(obstacle.originalWidth, gameState.obstacleSpeedSetting);
    const contractedX = obstacle.x + (obstacle.originalWidth - contractedWidth);
    ctx.fillRect(contractedX, obstacle.y, contractedWidth, obstacle.height);
}

function drawScore() {
    ctx.fillStyle = 'black';
    ctx.font = '20px Arial';
    ctx.fillText('Score: ' + gameState.score, 10, 30);
}

function drawGameOver() {
    ctx.fillStyle = 'black';
    ctx.font = '40px Arial';
    ctx.fillText('Game Over', size / 4, size / 2);
    ctx.font = '20px Arial';
    ctx.fillText('Jump to Restart', size / 4 + 20, size / 2 + 40);
}

function drawSettingsButton() {
    ctx.fillStyle = 'gray';
    ctx.fillRect(
        size - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_PADDING,
        SETTINGS_BUTTON_PADDING,
        SETTINGS_BUTTON_SIZE,
        SETTINGS_BUTTON_SIZE
    );
    // Draw a simple gear icon (you can customize this)
    ctx.fillStyle = 'white';
    ctx.font = '20px Arial';
    ctx.fillText('⚙️', size - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_PADDING + 5, SETTINGS_BUTTON_PADDING + 22);
}


// --- Update Functions ---
function updatePlayer(deltaTime) {
    const player = gameState.player; // Shorter reference

    if (player.isJumping) {
        player.yVelocity += player.gravity * deltaTime;
        player.y += player.yVelocity * deltaTime;

        if (player.y > GROUND_LEVEL) {
            player.y = GROUND_LEVEL;
            player.yVelocity = 0;
            player.isJumping = false;
        }
    }

    player.x += player.xVelocity * deltaTime;

    if (player.x - player.radius < 0) {
        player.x = player.radius;
        player.xVelocity = 0;
    } else if (player.x + player.radius > size) {
        player.x = size - player.radius;
        player.xVelocity = 0;
    }
}

function generateObstacle() {
    let obstacle;
    if (gameState.obstaclePool.length > 0) {
        obstacle = gameState.obstaclePool.pop();
        obstacle.height = Math.floor(Math.random() * (50 - 20 + 1)) + 20;
        obstacle.width = Math.floor(Math.random() * (40 - 20 + 1)) + 20;
        obstacle.originalWidth = obstacle.width;
        obstacle.x = size;
        obstacle.y = size - obstacle.height;
    } else {
        const height = Math.floor(Math.random() * (50 - 20 + 1)) + 20;
        const width = Math.floor(Math.random() * (40 - 20 + 1)) + 20;
        obstacle = {
            x: size,
            y: size - height,
            width: width,
            height: height,
            originalWidth: width,
        };
    }
    gameState.obstacles.push(obstacle);
}

function updateObstacles(deltaTime) {
    const { obstacles, obstaclePool } = gameState; // Destructuring for brevity

    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].x -= gameState.obstacleSpeedSetting * deltaTime;

        if (obstacles[i].x + obstacles[i].width < 0) {
            obstaclePool.push(obstacles[i]);
            obstacles.splice(i, 1);
            i--;
            gameState.score++;
            if (gameState.score % 5 == 0 && gameState.score != 0) {
                gameState.obstacleSpeed += 1; // Fixed increment
            }
        }
    }
    if (obstacles.length == 0 || obstacles[obstacles.length - 1].x < size - OBSTACLE_SPACING) {
        if (Math.random() < OBSTACLE_GENERATION_PROBABILITY) {
            generateObstacle();
        }
    }
}

function checkCollision() {
    for (let obstacle of gameState.obstacles) {
        const contractedWidth = relativisticLengthContraction(obstacle.originalWidth, gameState.obstacleSpeedSetting);
        const contractedX = obstacle.x + (obstacle.originalWidth - contractedWidth);

        let distX = Math.abs(gameState.player.x - contractedX - contractedWidth / 2);
        let distY = Math.abs(gameState.player.y - obstacle.y - obstacle.height / 2);

        if (distX > (contractedWidth / 2 + gameState.player.radius)) { continue; }
        if (distY > (obstacle.height / 2 + gameState.player.radius)) { continue; }

        if (distX <= (contractedWidth / 2)) { return true; }
        if (distY <= (obstacle.height / 2)) { return true; }

        let dx = distX - contractedWidth / 2;
        let dy = distY - obstacle.height / 2;
        return (dx * dx + dy * dy <= (gameState.player.radius * gameState.player.radius));
    }
    return false;
}

// --- Settings UI ---
function openSettings() {
    gameState.settingsOpen = true;
    // Create settings UI elements (using DOM manipulation)
    const settingsDiv = document.createElement('div');
    settingsDiv.id = 'settings-panel';
    settingsDiv.style.position = 'absolute';
    settingsDiv.style.top = '50px';
    settingsDiv.style.left = '50px';
    settingsDiv.style.backgroundColor = 'white';
    settingsDiv.style.border = '1px solid black';
    settingsDiv.style.padding = '10px';
    settingsDiv.style.zIndex = '10'; // Make sure it's on top

    const speedLabel = document.createElement('label');
    speedLabel.textContent = 'Obstacle Speed: ';
    settingsDiv.appendChild(speedLabel);

    const speedInput = document.createElement('input');
    speedInput.type = 'range';
    speedInput.min = '1';
    speedInput.max = String(c - 1); // Max speed is c-1 (avoiding Infinity)
    speedInput.value = String(gameState.obstacleSpeedSetting);
    speedInput.id = 'speed-input';
    settingsDiv.appendChild(speedInput);

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.onclick = closeSettings;
    settingsDiv.appendChild(closeButton);

    document.body.appendChild(settingsDiv);

    // Update obstacle speed setting on input change
    speedInput.addEventListener('input', () => {
        gameState.obstacleSpeedSetting = parseFloat(speedInput.value);
        // console.log("Setting Speed", gameState.obstacleSpeedSetting)
    });
}

function closeSettings() {
    gameState.settingsOpen = false;
    const settingsDiv = document.getElementById('settings-panel');
    if (settingsDiv) {
        settingsDiv.remove();
    }
    //Restart the game with the new settings.
    restartGame();
}

// --- Main Game Loop & Input ---

function restartGame() {
    gameState.player = {
        x: 50,
        y: GROUND_LEVEL,
        radius: PLAYER_RADIUS,
        yVelocity: 0,
        gravity: 1.1,
        jumpStrength: -15,
        isJumping: false,
        xVelocity: 0,
        speed: 5,
    };
    gameState.obstacles = [];
    gameState.obstacleSpeed = gameState.obstacleSpeedSetting; // Reset to the setting value
    gameState.score = 0;
    gameState.gameRunning = true;
    gameState.lastTime = 0;
    gameState.touchStartX = null;
    gameState.touchEndX = null;
    gameState.canJump = true;
    requestAnimationFrame(gameLoop);
}


function update(deltaTime) {
    updatePlayer(deltaTime);
    updateObstacles(deltaTime);
}

function draw() {
    ctx.clearRect(0, 0, size, size);
    drawPlayer();
    for (let obstacle of gameState.obstacles) {
        drawObstacle(obstacle);
    }
    drawScore();
    drawSettingsButton(); // Draw the settings button
}

function gameLoop(timestamp) {
    if (!gameState.gameRunning) {
        drawGameOver();
        return;
    }

    //Do NOT skip the drawSettingsButton() call!  We always draw it.
    if (gameState.settingsOpen) {
      //Settings UI is handled by the openSettings() function.
      //Don't update/draw game, *but* must return to keep the loop going.
       return;
    }

    let deltaTime = (timestamp - gameState.lastTime) / targetFrameTime;  //NORMALIZE
    gameState.lastTime = timestamp;

    update(deltaTime); // Call the update function

    if (checkCollision()) {
        gameState.gameRunning = false;
    }
    draw(); // Call the draw function.

    requestAnimationFrame(gameLoop);
}

function jump() {
    if (gameState.gameRunning && !gameState.player.isJumping && gameState.canJump) {
        gameState.player.yVelocity = gameState.player.jumpStrength;
        gameState.player.isJumping = true;
        gameState.canJump = false;
        setTimeout(() => { gameState.canJump = true; }, JUMP_DEBOUNCE_TIME);
    } else if (!gameState.gameRunning) {
        restartGame();
    }
}

// --- Event Listeners ---

// Helper function to get canvas-relative coordinates
function getCanvasCoordinates(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}


// --- Consolidated Mouse and Touch Event Handling ---

function handleStart(x, y) {
    if (x >= size - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_PADDING &&
        x <= size - SETTINGS_BUTTON_PADDING &&
        y >= SETTINGS_BUTTON_PADDING &&
        y <= SETTINGS_BUTTON_SIZE + SETTINGS_BUTTON_PADDING) {
        if (!gameState.settingsOpen) {
            openSettings();
        }
    } else if (gameState.gameRunning) {
      jump();
    }
}


canvas.addEventListener('mousedown', (event) => {
  const { x, y } = getCanvasCoordinates(event);
  handleStart(x, y);
});

canvas.addEventListener('touchstart', (event) => {
    event.preventDefault();
    if (event.touches.length > 0) { // Ensure there's at least one touch
        const { x, y } = getCanvasCoordinates(event.touches[0]);
        handleStart(x, y);
    }
});

// Keep the touchmove and touchend events (for X movement)
canvas.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (gameState.touchStartX !== null) {
        gameState.touchEndX = event.touches[0].clientX;
    }
});

canvas.addEventListener('touchend', (event) => {
    event.preventDefault();
    if (gameState.touchStartX !== null && gameState.touchEndX !== null) {
        const deltaX = gameState.touchEndX - gameState.touchStartX;

        if (deltaX > touchThreshold) {
            gameState.player.xVelocity = gameState.player.speed;
        } else if (deltaX < -touchThreshold) {
            gameState.player.xVelocity = -gameState.player.speed;
        } else {
            gameState.player.xVelocity = 0;
        }
    }
    gameState.touchStartX = null;
    gameState.touchEndX = null;
});
// Keyboard Controls
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'ArrowUp') {
        jump();
    }
    if (event.code === 'ArrowLeft') {
        gameState.player.xVelocity = -gameState.player.speed;
    } else if (event.code === 'ArrowRight') {
        gameState.player.xVelocity = gameState.player.speed;
    }
    // Open settings with 'S' key (removed to favor button)
    // if (event.code === 'KeyS') {
    //     if (!gameState.settingsOpen) {
    //         openSettings();
    //     }
    // }
});

document.addEventListener('keyup', (event) => {
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        gameState.player.xVelocity = 0;
    }
});
requestAnimationFrame(gameLoop);
