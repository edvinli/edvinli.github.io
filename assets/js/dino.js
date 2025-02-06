const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const GROUND_LEVEL = 0.8;
const GRAVITY = 0.2;
const JUMP_STRENGTH = 40; 
const BASE_OBSTACLE_SPEED = 20;
const MIN_OBSTACLE_SPACING = 180;
const MAX_OBSTACLE_SPACING = 360;
const MIN_OBSTACLE_SPAWNING = 900;
const MAX_OBSTACLE_SPAWNING = 1900;

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
const maxObstacles = 5; // Variable declared but not currently used to limit max obstacles
let gameStarted = false;
let lastTime = 0;

function resizeCanvas() {
    canvas.width = Math.min(800, window.innerWidth);
    canvas.height = canvas.width;
    adjustGameElements();
}

resizeCanvas();
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
        if (newObstacleX - dino.x < 200) return;
    }

    const obstacle = {
        x: newObstacleX,
        y: canvas.height * GROUND_LEVEL - dino.width / 2, // Corrected obstacle y position calculation
        width: dino.width / 2,
        height: dino.width / 2,
        color: 'red',
        speed: BASE_OBSTACLE_SPEED * (canvas.width / 800)
    };
    obstacles.push(obstacle);
}

function handleJump(event) {
    if (!gameStarted) {
        startGame(); // Call startGame to initialize and start the game
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

function update(deltaTime) {
    if (!gameStarted) return;

    obstacles = obstacles.filter(obstacle => obstacle.x + obstacle.width > 0);

    dino.dy += dino.gravity * deltaTime;
    dino.y += dino.dy * deltaTime;

    if (dino.y + dino.height > canvas.height * GROUND_LEVEL) {
        dino.y = canvas.height * GROUND_LEVEL - dino.height;
        dino.dy = 0;
    }

    for (let obstacle of obstacles) {
        obstacle.x -= obstacle.speed * deltaTime;

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
    obstacles = []; // Corrected syntax error and cleared obstacles array
    alert("Game Over!");
    // Optionally, you could show a "Restart" button here instead of just an alert.
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawDino();
    drawObstacles();
}

function gameLoop(currentTime) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;
    update(deltaTime);
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

function startGame() {
    if (!gameStarted) {
        gameStarted = true;
        obstacles = []; // Clear any previous obstacles
        dino.y = canvas.height * GROUND_LEVEL - dino.height; // Reset dino position if needed
        dino.dy = 0; // Reset dino vertical velocity
        obstacleSpawner();
        lastTime = performance.now(); // Reset lastTime for game loop timing
        requestAnimationFrame(gameLoop); // Ensure game loop starts if not already running
    }
}

// Example of a restart function that can be triggered by a button or key press
function restartGame() {
    gameStarted = false; // Stop the game loop temporarily
    gameOver(); // Call gameOver to reset game state (clears obstacles and shows alert)
    startGame(); // Immediately start a new game
}

// You can trigger restartGame() by adding a button and event listener in your HTML,
// or by listening for another key press like 'Enter' and calling restartGame()

lastTime = performance.now();
// Game starts on first jump now, no need to start gameLoop immediately.
// gameLoop(lastTime); //  <-- Removed initial gameLoop call, game starts on first jump


// **Further improvements and considerations (comments in code):**

// 1. **Responsiveness Fine-tuning:**
//    You might need to adjust constants like GRAVITY, JUMP_STRENGTH, BASE_OBSTACLE_SPEED etc.
//    based on canvas.width to maintain consistent gameplay feel across different screen sizes.
//    For example, you could scale GRAVITY and JUMP_STRENGTH proportionally to canvas.width or canvas.height.

// 2. **Obstacle Spawning Logic:**
//    The current obstacle spawning is random within a range. For more controlled difficulty progression:
//    - Increase obstacle speed gradually over time.
//    - Decrease obstacle spacing gradually over time.
//    - Introduce different types of obstacles (e.g., varying heights or speeds).
//    - Control obstacle density more precisely instead of just random delays.

// 3. **Scorekeeping:**
//    Add a score counter that increases over time or based on distance travelled.
//    Display the score on the canvas.

// 4. **Visual Enhancements:**
//    - Add ground/background graphics.
//    - Animate the dino and obstacles (e.g., dino running animation).
//    - Improve obstacle shapes (currently just rectangles).
//    - Add visual effects for jump and collision.

// 5. **Game State Management:**
//    For a more complex game, consider using a more structured game state management approach
//    instead of just boolean flags like `gameStarted`. This can help manage different game phases
//    (e.g., menu, playing, game over, paused).

    
