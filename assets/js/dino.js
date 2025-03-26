const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const size = 350;
canvas.width = size;
canvas.height = size;
canvas.style.border = '1px solid black';
// Optional: Disable image smoothing if you were using pixelated sprites
// ctx.imageSmoothingEnabled = false;

// --- Constants ---
const PHYSICS = {
    GRAVITY: 0.0025, // Adjusted for ms delta time
    JUMP_STRENGTH: -0.8, // Adjusted for ms delta time
    PLAYER_SPEED: 0.25, // Adjusted for ms delta time (pixels per ms)
    BASE_OBSTACLE_SPEED: 0.3, // Adjusted for ms delta time (pixels per ms)
    SPEED_INCREASE_PER_5_SCORE: 0.03, // How much speed increases
};

const RELATIVITY = {
    C: 20 // Speed of light (scaled down, pixels per ms). NOTE: Must be > max possible obstacle speed
};

const APPEARANCE = {
    GROUND_HEIGHT: 50,
    GROUND_COLOR: '#553311', // Brownish ground
    PLAYER_RADIUS: 15,
    PLAYER_COLOR: '#33cc33', // Brighter green
    PLAYER_OUTLINE: 'darkgreen',
    OBSTACLE_COLOR_HUE_START: 0, // Red
    OBSTACLE_COLOR_HUE_RANGE: 60, // Red to Yellow
    OBSTACLE_OUTLINE: '#222',
    BACKGROUND_LAYER_1_COLOR: '#add8e6', // Light blue (distant sky)
    BACKGROUND_LAYER_2_COLOR: '#87ceeb', // Sky blue (closer hills/clouds)
    BACKGROUND_LAYER_1_SPEED_FACTOR: 0.15, // Distant layer scrolls slowest (relative to obstacles)
    BACKGROUND_LAYER_2_SPEED_FACTOR: 0.4,  // Closer layer scrolls slower than obstacles, faster than layer 1
    SETTINGS_BUTTON_SIZE: 30,
    SETTINGS_BUTTON_PADDING: 5,
    TRAIL_LENGTH: 8,
    TRAIL_OPACITY_STEP: 0.1,
};

const GAMEPLAY = {
    OBSTACLE_GENERATION_PROBABILITY: 0.015, // Slightly lower chance, relies more on spacing
    MIN_OBSTACLE_SPACING: 200, // Minimum distance between obstacles
    OBSTACLE_MIN_HEIGHT: 25,
    OBSTACLE_MAX_HEIGHT: 55,
    OBSTACLE_MIN_WIDTH: 20,
    OBSTACLE_MAX_WIDTH: 40,
    JUMP_DEBOUNCE_TIME: 250, // ms
    TOUCH_THRESHOLD: 30,
    SCREEN_SHAKE_DURATION: 200, // ms
    SCREEN_SHAKE_MAGNITUDE: 5, // pixels
};

const GROUND_LEVEL = size - APPEARANCE.GROUND_HEIGHT;

// --- Game State ---
let gameState = {
    player: {
        x: 50,
        y: GROUND_LEVEL - APPEARANCE.PLAYER_RADIUS, // Start on the ground
        radius: APPEARANCE.PLAYER_RADIUS,
        yVelocity: 0,
        isJumping: false,
        xVelocity: 0,
        // Store recent positions for trail
        trail: [],
    },
    obstacles: [],
    obstaclePool: [], // Object pool
    obstacleSpeedSetting: PHYSICS.BASE_OBSTACLE_SPEED, // User-configurable base speed
    currentObstacleSpeed: PHYSICS.BASE_OBSTACLE_SPEED, // Actual speed used in game
    score: 0,
    gameRunning: true,
    lastTime: 0,
    deltaTime: 0, // Store deltaTime for use in updates/drawing
    settingsOpen: false,
    touchStartX: null,
    touchEndX: null,
    canJump: true,
    // Background layer positions
    bgLayer1Offset: 0,
    bgLayer2Offset: 0,
    // Screen Shake
    shakeTime: 0,
    shakeMagnitude: 0,
};

// --- Relativistic Effects ---
function lorentzFactor(v) {
    // Ensure speed doesn't equal or exceed C
    const safeV = Math.min(v, RELATIVITY.C * 0.999);
    if (safeV < 0) return 1; // No effect for negative speed (shouldn't happen here)
    const vSquared = safeV * safeV;
    const cSquared = RELATIVITY.C * RELATIVITY.C;
    // Add a check for vSquared >= cSquared to prevent sqrt of negative
    if (vSquared >= cSquared) return Infinity;
    return 1 / Math.sqrt(1 - vSquared / cSquared);
}

function relativisticLengthContraction(originalLength, v) {
    const factor = lorentzFactor(v);
    if (!isFinite(factor) || factor < 1) {
        return originalLength; // Avoid issues with Infinity or invalid factors
    }
    return originalLength / factor;
}

// --- Drawing Functions ---

function drawBackground() {
    // Layer 1 (Distant - moves slowest)
    const effectiveSpeedLayer1 = gameState.currentObstacleSpeed * APPEARANCE.BACKGROUND_LAYER_1_SPEED_FACTOR;
    gameState.bgLayer1Offset = (gameState.bgLayer1Offset + effectiveSpeedLayer1 * gameState.deltaTime) % size;

    // Draw Layer 1 - simple scrolling color (or could add clouds)
    ctx.fillStyle = APPEARANCE.BACKGROUND_LAYER_1_COLOR;
    // Draw two rectangles to simulate wrapping
    ctx.fillRect(-gameState.bgLayer1Offset, 0, size, size);
    ctx.fillRect(size - gameState.bgLayer1Offset, 0, size, size);


    // Layer 2 (Closer - moves faster than layer 1, slower than foreground)
    const effectiveSpeedLayer2 = gameState.currentObstacleSpeed * APPEARANCE.BACKGROUND_LAYER_2_SPEED_FACTOR;
    gameState.bgLayer2Offset = (gameState.bgLayer2Offset + effectiveSpeedLayer2 * gameState.deltaTime) % size;

    ctx.fillStyle = APPEARANCE.BACKGROUND_LAYER_2_COLOR;
    // Simple repeating pattern (e.g., hills)
    const hillHeight = 80;
    const hillWidth = size / 1.5; // Make hills wider for slower feel
    for (let i = -2; i < 3; i++) { // Draw enough hills to cover screen during movement
        const startX = i * hillWidth - gameState.bgLayer2Offset;
        ctx.beginPath();
        ctx.moveTo(startX, GROUND_LEVEL);
        ctx.quadraticCurveTo(startX + hillWidth / 2, GROUND_LEVEL - hillHeight, startX + hillWidth, GROUND_LEVEL);
        //ctx.lineTo(startX + hillWidth, size); // Fill down to bottom
        //ctx.lineTo(startX, size);
        ctx.closePath(); // Close the shape path back to start automatically
        ctx.fill();
    }

     // Draw text indicating speed C (optional visual cue) - Draw AFTER backgrounds
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'; // White, semi-transparent
    ctx.font = '12px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(`Speed c: ${RELATIVITY.C.toFixed(1)} px/ms`, size - 10, size - 10);
    ctx.textAlign = 'left'; // Reset alignment
}


function drawGround() {
    ctx.fillStyle = APPEARANCE.GROUND_COLOR;
    ctx.fillRect(0, GROUND_LEVEL, size, APPEARANCE.GROUND_HEIGHT);

    // Add some detail (optional lines)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const yPos = GROUND_LEVEL + (APPEARANCE.GROUND_HEIGHT / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, yPos);
        ctx.lineTo(size, yPos);
        ctx.stroke();
    }
}

function drawPlayerTrail() {
    const trail = gameState.player.trail;
    for (let i = 0; i < trail.length; i++) {
        const pos = trail[i];
        const opacity = 1.0 - (trail.length - 1 - i) * APPEARANCE.TRAIL_OPACITY_STEP;
        ctx.fillStyle = `rgba(51, 204, 51, ${Math.max(0, opacity)})`; // Use player color with decreasing opacity
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, gameState.player.radius * (1 - (trail.length - i) * 0.05), 0, 2 * Math.PI); // Shrink slightly
        ctx.fill();
    }
}


function drawPlayer() {
    const player = gameState.player;

    // Draw trail first so player is on top
    drawPlayerTrail();

    ctx.fillStyle = APPEARANCE.PLAYER_COLOR;
    ctx.strokeStyle = APPEARANCE.PLAYER_OUTLINE;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    // Simple "eye" - make it look right (adjust based on xVelocity)
    const eyeOffsetX = player.radius * 0.4 + (player.xVelocity !== 0 ? Math.sign(player.xVelocity) * player.radius * 0.1 : 0);
    const pupilOffsetX = player.radius * 0.5 + (player.xVelocity !== 0 ? Math.sign(player.xVelocity) * player.radius * 0.15 : 0);
    const eyeOffsetY = player.radius * -0.3;

    // White part
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(player.x + eyeOffsetX, player.y + eyeOffsetY, player.radius * 0.3, 0, Math.PI * 2);
    ctx.fill();
    // Pupil
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.arc(player.x + pupilOffsetX, player.y + eyeOffsetY, player.radius * 0.15, 0, Math.PI * 2);
    ctx.fill();
}

function drawObstacle(obstacle) {
    // Use HSL for easy color variation based on original width/height?
    const hue = APPEARANCE.OBSTACLE_COLOR_HUE_START + (obstacle.originalWidth / APPEARANCE.OBSTACLE_MAX_WIDTH) * APPEARANCE.OBSTACLE_COLOR_HUE_RANGE;
    ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
    ctx.strokeStyle = APPEARANCE.OBSTACLE_OUTLINE;
    ctx.lineWidth = 1;

    // Apply relativistic contraction
    const contractedWidth = relativisticLengthContraction(obstacle.originalWidth, gameState.currentObstacleSpeed);
    // Adjust x position so the *leading* edge (right side) remains consistent during contraction
    const contractedX = obstacle.x + (obstacle.originalWidth - contractedWidth);

    ctx.beginPath();
    ctx.rect(contractedX, obstacle.y, contractedWidth, obstacle.height);
    ctx.fill();
    ctx.stroke();
}

function drawScore() {
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.font = 'bold 24px Arial'; // Nicer font
    ctx.strokeText('Score: ' + gameState.score, 15, 35); // Outline
    ctx.fillText('Score: ' + gameState.score, 15, 35);   // Fill
}

function drawGameOver() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; // Semi-transparent overlay
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center'; // Center align text
    ctx.strokeText('Game Over', size / 2, size / 2 - 20);
    ctx.fillText('Game Over', size / 2, size / 2 - 20);

    ctx.font = 'bold 24px Arial';
    ctx.lineWidth = 2;
    ctx.strokeText('Jump to Restart', size / 2, size / 2 + 30);
    ctx.fillText('Jump to Restart', size / 2, size / 2 + 30);
    ctx.textAlign = 'left'; // Reset alignment
}

function drawSettingsButton() {
    const btnX = size - APPEARANCE.SETTINGS_BUTTON_SIZE - APPEARANCE.SETTINGS_BUTTON_PADDING;
    const btnY = APPEARANCE.SETTINGS_BUTTON_PADDING;

    ctx.fillStyle = '#aaa'; // Lighter gray
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Simple rect for button
    ctx.rect(btnX, btnY, APPEARANCE.SETTINGS_BUTTON_SIZE, APPEARANCE.SETTINGS_BUTTON_SIZE);
    ctx.fill();
    ctx.stroke();

    // Simple gear icon
    ctx.fillStyle = 'white';
    ctx.font = '22px Arial'; // Adjust size/position as needed
    ctx.textAlign = 'center';
    ctx.fillText('⚙️', btnX + APPEARANCE.SETTINGS_BUTTON_SIZE / 2, btnY + APPEARANCE.SETTINGS_BUTTON_SIZE / 1.5);
    ctx.textAlign = 'left'; // Reset
}


// --- Update Functions ---
function updatePlayer(deltaTime) {
    const player = gameState.player;

    // Apply gravity and velocity
    player.yVelocity += PHYSICS.GRAVITY * deltaTime;
    player.y += player.yVelocity * deltaTime;

    // Ground collision
    const groundPosition = GROUND_LEVEL - player.radius;
    if (player.y >= groundPosition) {
        player.y = groundPosition;
        player.yVelocity = 0;
        if (player.isJumping) {
             // Optional landing effect could go here
        }
        player.isJumping = false;
    }

    // Horizontal movement
    player.x += player.xVelocity * deltaTime;

    // Keep player within bounds
    if (player.x - player.radius < 0) {
        player.x = player.radius;
        player.xVelocity = 0;
    } else if (player.x + player.radius > size) {
        player.x = size - player.radius;
        player.xVelocity = 0;
    }

     // Update trail
    player.trail.push({ x: player.x, y: player.y });
    if (player.trail.length > APPEARANCE.TRAIL_LENGTH) {
        player.trail.shift(); // Remove the oldest position
    }
}

function generateObstacle() {
    let obstacle;
    const height = Math.floor(Math.random() * (GAMEPLAY.OBSTACLE_MAX_HEIGHT - GAMEPLAY.OBSTACLE_MIN_HEIGHT + 1)) + GAMEPLAY.OBSTACLE_MIN_HEIGHT;
    const width = Math.floor(Math.random() * (GAMEPLAY.OBSTACLE_MAX_WIDTH - GAMEPLAY.OBSTACLE_MIN_WIDTH + 1)) + GAMEPLAY.OBSTACLE_MIN_WIDTH;

    if (gameState.obstaclePool.length > 0) {
        obstacle = gameState.obstaclePool.pop();
        obstacle.height = height;
        obstacle.width = width;
        obstacle.originalWidth = width;
        obstacle.x = size; // Start off-screen right
        obstacle.y = GROUND_LEVEL - height; // Sit on the ground
    } else {
        obstacle = {
            x: size,
            y: GROUND_LEVEL - height,
            width: width,
            height: height,
            originalWidth: width, // Store original width for contraction calculation
        };
    }
    gameState.obstacles.push(obstacle);
}

function updateObstacles(deltaTime) {
    const { obstacles, obstaclePool } = gameState;

    // Dynamically adjust current speed based on score (but cap below C)
    const speedIncrease = Math.floor(gameState.score / 5) * PHYSICS.SPEED_INCREASE_PER_5_SCORE;
    gameState.currentObstacleSpeed = Math.min(
        gameState.obstacleSpeedSetting + speedIncrease,
        RELATIVITY.C * 0.995 // Ensure it never quite reaches C, slightly higher cap
    );

    let lastObstacleX = -Infinity; // Find the position of the rightmost obstacle's *start*

    for (let i = obstacles.length - 1; i >= 0; i--) { // Iterate backwards for safe removal
        const obs = obstacles[i];
        obs.x -= gameState.currentObstacleSpeed * deltaTime;

        // Track the rightmost obstacle's STARTING position (used for generation spacing)
        // Update lastObstacleX only if this obstacle is further right
        lastObstacleX = Math.max(lastObstacleX, obs.x);

        // Remove obstacles that are off-screen left
        // Check using originalWidth to ensure the whole original shape is gone
        if (obs.x + obs.originalWidth < 0) {
            obstaclePool.push(obs); // Recycle
            obstacles.splice(i, 1);
            gameState.score++;
            // Speed increase is now handled dynamically above based on score
        }
    }

    // Generate new obstacles based on probability AND spacing
    const shouldGenerate = Math.random() < GAMEPLAY.OBSTACLE_GENERATION_PROBABILITY;
    // Check if the START of the rightmost obstacle is far enough left
    // to allow a new one to spawn at `size`
    const enoughSpacing = obstacles.length === 0 || lastObstacleX < size - GAMEPLAY.MIN_OBSTACLE_SPACING;

    if (shouldGenerate && enoughSpacing) {
        generateObstacle();
    }
}


function checkCollision() {
    const player = gameState.player;
    for (let obstacle of gameState.obstacles) {
        // Calculate contracted width and position for collision check
        const contractedWidth = relativisticLengthContraction(obstacle.originalWidth, gameState.currentObstacleSpeed);
        const contractedX = obstacle.x + (obstacle.originalWidth - contractedWidth); // Leading edge x

        // Simple AABB check first (Axis-Aligned Bounding Box)
        const playerLeft = player.x - player.radius;
        const playerRight = player.x + player.radius;
        const playerTop = player.y - player.radius;
        const playerBottom = player.y + player.radius;

        const obsLeft = contractedX;
        const obsRight = contractedX + contractedWidth;
        const obsTop = obstacle.y;
        const obsBottom = obstacle.y + obstacle.height;

        if (playerRight > obsLeft && playerLeft < obsRight && playerBottom > obsTop && playerTop < obsBottom) {
            // More precise circle-rectangle collision (Manhattan distance variation)
            // Find closest point on rectangle to circle center
            const closestX = Math.max(obsLeft, Math.min(player.x, obsRight));
            const closestY = Math.max(obsTop, Math.min(player.y, obsBottom));

            // Calculate distance between circle center and closest point
            const distX = player.x - closestX;
            const distY = player.y - closestY;
            const distanceSquared = (distX * distX) + (distY * distY);

            // If distance is less than the circle's radius squared, collision occurs
            if (distanceSquared < (player.radius * player.radius)) {
                return true; // Collision detected
            }
        }
    }
    return false; // No collision
}

function triggerScreenShake(magnitude, duration) {
    gameState.shakeMagnitude = magnitude;
    gameState.shakeTime = duration;
}

// --- Settings UI ---
function openSettings() {
    gameState.settingsOpen = true;
    // Pause game updates (drawing continues in gameLoop)
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) return; // Already open

    const settingsDiv = document.createElement('div');
    settingsDiv.id = 'settings-panel';
    // Style the settings panel
    Object.assign(settingsDiv.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)', // Center it
        backgroundColor: 'rgba(240, 240, 240, 0.95)', // Slightly transparent white
        border: '2px solid #555',
        borderRadius: '10px',
        padding: '20px',
        zIndex: '10',
        boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
        minWidth: '250px',
        fontFamily: 'Arial, sans-serif',
    });


    const title = document.createElement('h3');
    title.textContent = 'Settings';
    title.style.marginTop = '0';
    title.style.textAlign = 'center';
    settingsDiv.appendChild(title);

    // Speed Setting
    const speedDiv = document.createElement('div');
    speedDiv.style.marginBottom = '15px';

    const speedLabel = document.createElement('label');
    speedLabel.textContent = `Base Obstacle Speed (${PHYSICS.BASE_OBSTACLE_SPEED.toFixed(2)} - ${(RELATIVITY.C * 0.95).toFixed(2)}): `; // Show range
    speedLabel.style.display = 'block';
    speedLabel.style.marginBottom = '5px';
    speedDiv.appendChild(speedLabel);

    const speedValueSpan = document.createElement('span');
    speedValueSpan.textContent = gameState.obstacleSpeedSetting.toFixed(2);
    speedValueSpan.style.fontWeight = 'bold';


    const speedInput = document.createElement('input');
    speedInput.type = 'range';
    speedInput.min = PHYSICS.BASE_OBSTACLE_SPEED.toString(); // Min base speed
    speedInput.max = (RELATIVITY.C * 0.95).toString(); // Max base speed (leave headroom below C)
    speedInput.step = '0.01'; // Finer control
    speedInput.value = gameState.obstacleSpeedSetting.toString();
    speedInput.id = 'speed-input';
    speedInput.style.width = '100%';
    speedDiv.appendChild(speedInput);
    speedLabel.appendChild(speedValueSpan); // Add span inside label

    settingsDiv.appendChild(speedDiv);

    // Close Button
    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close & Restart';
    closeButton.onclick = closeSettings;
    closeButton.style.display = 'block';
    closeButton.style.width = '100%';
    closeButton.style.padding = '10px';
    closeButton.style.marginTop = '10px';
    closeButton.style.backgroundColor = '#4CAF50';
    closeButton.style.color = 'white';
    closeButton.style.border = 'none';
    closeButton.style.borderRadius = '5px';
    closeButton.style.cursor = 'pointer';
    settingsDiv.appendChild(closeButton);

    document.body.appendChild(settingsDiv);

    // Update speed setting and display value on input change
    speedInput.addEventListener('input', () => {
        const newSpeed = parseFloat(speedInput.value);
        gameState.obstacleSpeedSetting = newSpeed;
        speedValueSpan.textContent = newSpeed.toFixed(2); // Update displayed value
    });
}

function closeSettings() {
    gameState.settingsOpen = false;
    const settingsDiv = document.getElementById('settings-panel');
    if (settingsDiv) {
        settingsDiv.remove();
    }
    // Restart the game with the new settings applied
    restartGame();
}

// --- Main Game Loop & Input ---

function restartGame() {
    gameState.player = {
        x: 50,
        y: GROUND_LEVEL - APPEARANCE.PLAYER_RADIUS,
        radius: APPEARANCE.PLAYER_RADIUS,
        yVelocity: 0,
        isJumping: false,
        xVelocity: 0,
        trail: [],
    };
    // Clear and reset obstacles
    gameState.obstaclePool.push(...gameState.obstacles); // Return all to pool
    gameState.obstacles = [];

    // Reset speed to the potentially new setting
    gameState.currentObstacleSpeed = gameState.obstacleSpeedSetting;

    gameState.score = 0;
    gameState.gameRunning = true;
    gameState.lastTime = performance.now(); // Use performance.now() for high-res time
    gameState.deltaTime = 0; // Reset delta time
    gameState.touchStartX = null;
    gameState.touchEndX = null;
    gameState.canJump = true;
    gameState.bgLayer1Offset = 0;
    gameState.bgLayer2Offset = 0;
    gameState.shakeTime = 0; // Reset screen shake

    // Ensure DOM settings panel is removed if somehow still present
    const settingsDiv = document.getElementById('settings-panel');
    if (settingsDiv) {
        settingsDiv.remove();
    }
    gameState.settingsOpen = false; // Ensure settings state is closed

    requestAnimationFrame(gameLoop);
}


function update(deltaTime) {
    if (deltaTime <= 0) return; // Avoid issues with zero or negative delta
    gameState.deltaTime = deltaTime; // Store for potential use elsewhere (like background)

    updatePlayer(deltaTime);
    updateObstacles(deltaTime); // Obstacles update calculates currentObstacleSpeed

    if (checkCollision()) {
        gameState.gameRunning = false;
        triggerScreenShake(GAMEPLAY.SCREEN_SHAKE_MAGNITUDE, GAMEPLAY.SCREEN_SHAKE_DURATION);
    }

    // Update screen shake timer
    if (gameState.shakeTime > 0) {
        gameState.shakeTime -= deltaTime;
        if (gameState.shakeTime <= 0) {
            gameState.shakeMagnitude = 0;
            gameState.shakeTime = 0; // Ensure it's exactly 0
        }
    }
}

function draw() {
    // Apply screen shake offset
    let shakeX = 0;
    let shakeY = 0;
    if (gameState.shakeTime > 0) {
        shakeX = (Math.random() - 0.5) * 2 * gameState.shakeMagnitude;
        shakeY = (Math.random() - 0.5) * 2 * gameState.shakeMagnitude;
        ctx.save(); // Save context state
        ctx.translate(shakeX, shakeY);
    }

    // Clear canvas (important!)
    ctx.clearRect(0, 0, size, size);

    // --- Draw game elements in order (Back to Front) ---
    drawBackground();
    drawGround();
    for (let obstacle of gameState.obstacles) {
        drawObstacle(obstacle);
    }
    drawPlayer(); // Draw player potentially over trail and obstacles
    drawScore();
    drawSettingsButton(); // Always draw the button

    // Draw semi-transparent overlay if settings are open
    if (gameState.settingsOpen) {
         ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; // Dark overlay
         ctx.fillRect(0, 0, size, size);
         // Redraw button on top of overlay so it's clickable
         drawSettingsButton();
    }


    // Restore context if shaken
    if (gameState.shakeTime > 0) {
        ctx.restore(); // Restore to pre-shake state
    }

    // Draw Game Over screen if needed (drawn last, after shake restore)
    if (!gameState.gameRunning && !gameState.settingsOpen) {
        drawGameOver();
    }
}

function gameLoop(timestamp) {
    // Ensure lastTime is valid
    if (gameState.lastTime === 0) {
        gameState.lastTime = timestamp;
    }
    const deltaTime = timestamp - gameState.lastTime;
    gameState.lastTime = timestamp;

    // If settings are open, only draw the paused state and skip updates
    if (gameState.settingsOpen) {
        // Update background offsets even when paused for visual continuity
        const tempDelta = Math.min(deltaTime, 30); // Cap delta time to prevent huge jumps if tabbed out
        gameState.deltaTime = tempDelta; // Set delta for background drawing
        const effectiveSpeedLayer1 = gameState.currentObstacleSpeed * APPEARANCE.BACKGROUND_LAYER_1_SPEED_FACTOR;
        gameState.bgLayer1Offset = (gameState.bgLayer1Offset + effectiveSpeedLayer1 * tempDelta) % size;
        const effectiveSpeedLayer2 = gameState.currentObstacleSpeed * APPEARANCE.BACKGROUND_LAYER_2_SPEED_FACTOR;
        gameState.bgLayer2Offset = (gameState.bgLayer2Offset + effectiveSpeedLayer2 * tempDelta) % size;

        draw(); // Draw the current state with overlay
        requestAnimationFrame(gameLoop); // Keep the loop going for drawing
        return;
    }

     // If game isn't running (and settings aren't open), just draw and wait for restart input
    if (!gameState.gameRunning) {
        draw(); // Draw includes Game Over screen
         // No update() call
        requestAnimationFrame(gameLoop); // Keep loop for input check via events
        return;
    }

    // --- Normal Gameplay Update & Draw ---
    // Cap deltaTime to prevent physics glitches if the tab was inactive for a long time
    const cappedDeltaTime = Math.min(deltaTime, 50); // E.g., max update step of 50ms (20 FPS min)
    update(cappedDeltaTime);
    draw();

    requestAnimationFrame(gameLoop);
}

function jump() {
    if (gameState.settingsOpen) return; // Don't jump if settings are open

    if (gameState.gameRunning && !gameState.player.isJumping && gameState.canJump) {
        // Only allow jump if on or very near the ground
        if (gameState.player.y >= GROUND_LEVEL - gameState.player.radius - 1) { // Small tolerance
            gameState.player.yVelocity = PHYSICS.JUMP_STRENGTH;
            gameState.player.isJumping = true;
            gameState.canJump = false;
            // Optional jump effect could go here

            setTimeout(() => { gameState.canJump = true; }, GAMEPLAY.JUMP_DEBOUNCE_TIME);
        }
    } else if (!gameState.gameRunning) {
        restartGame();
    }
}

// --- Event Listeners ---

function getCanvasCoordinates(event) {
  const rect = canvas.getBoundingClientRect();
  // Handle both mouse and touch events
  const clientX = event.clientX ?? event.touches?.[0]?.clientX;
  const clientY = event.clientY ?? event.touches?.[0]?.clientY;

  if (clientX === undefined || clientY === undefined) {
      // If event is touchend, touches might be empty, ignore coordinate calculation
      if(event.type === 'touchend' || event.type === 'pointerup') return null;
       console.warn("Could not get coordinates from event:", event);
      return null;
  }

  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}


function handleStart(event) {
    event.preventDefault(); // Prevent default touch actions like scrolling/selection
    const coords = getCanvasCoordinates(event);
    // If coords are null (e.g., from touchend), just return
    if (!coords) {
        // For touch start, we expect coords. If not present, log error maybe?
         if (event.type === 'touchstart') console.error("No coordinates on touchstart?");
        return;
    }

    const { x, y } = coords;

    // Check if settings button was clicked
    const btnX = size - APPEARANCE.SETTINGS_BUTTON_SIZE - APPEARANCE.SETTINGS_BUTTON_PADDING;
    const btnY = APPEARANCE.SETTINGS_BUTTON_PADDING;
    if (x >= btnX && x <= btnX + APPEARANCE.SETTINGS_BUTTON_SIZE &&
        y >= btnY && y <= btnY + APPEARANCE.SETTINGS_BUTTON_SIZE) {
        if (!gameState.settingsOpen) {
            openSettings();
        } else {
            // Optional: Close settings if button is tapped again?
             // closeSettings();
        }
    } else if (!gameState.settingsOpen) { // Only handle game input if settings are closed
        // Store touch start for potential swipe detection
         if (event.type === 'touchstart' || event.type === 'pointerdown') {
            gameState.touchStartX = coords.x;
            gameState.touchEndX = coords.x; // Initialize endX
        }
        // Perform jump action immediately on tap/click that wasn't the settings button
        jump();
    }
}

// Use pointer events if available for unified mouse/touch, otherwise fallback
if (window.PointerEvent) {
  canvas.addEventListener('pointerdown', handleStart);
  // Add pointermove/pointerup if needed for dragging/swiping mechanics later
  // Note: Swipe logic currently uses touch events only, could be adapted
} else {
  canvas.addEventListener('mousedown', handleStart);
  canvas.addEventListener('touchstart', handleStart, { passive: false });
}


// --- Horizontal Movement (Touch Swipe - Keep existing logic) ---
canvas.addEventListener('touchmove', (event) => {
    // Prevent scrolling ONLY if a touch sequence has started inside the canvas
     if (gameState.touchStartX !== null && event.touches.length > 0 && !gameState.settingsOpen) {
        event.preventDefault();
        gameState.touchEndX = event.touches[0].clientX - canvas.getBoundingClientRect().left; // Relative X
     }
}, { passive: false }); // Need passive false to be able to preventDefault

canvas.addEventListener('touchend', (event) => {
    // We might not need preventDefault here if start/move handled it
    // event.preventDefault();

     if (gameState.touchStartX !== null && gameState.touchEndX !== null && !gameState.settingsOpen) {
        const deltaX = gameState.touchEndX - gameState.touchStartX;
        const effectiveSpeed = PHYSICS.PLAYER_SPEED; // Use the adjusted speed

        if (deltaX > GAMEPLAY.TOUCH_THRESHOLD) {
            gameState.player.xVelocity = effectiveSpeed;
        } else if (deltaX < -GAMEPLAY.TOUCH_THRESHOLD) {
            gameState.player.xVelocity = -effectiveSpeed;
        }
         // Optional: Stop movement on tap (deltaX is small) ONLY if a swipe didn't happen
         // A jump happens on touchstart anyway, so maybe don't reset velocity here?
         // else if (Math.abs(deltaX) <= GAMEPLAY.TOUCH_THRESHOLD) {
             // gameState.player.xVelocity = 0; // Stop if it wasn't a clear swipe
         // }
    }
    // Reset touch tracking ALWAYS on touchend/pointerup
    gameState.touchStartX = null;
    gameState.touchEndX = null;
});

// Add pointer equivalents for swipe reset if using pointer events
if (window.PointerEvent) {
    canvas.addEventListener('pointerup', (event) => {
        // Reset swipe tracking on pointer up as well
        gameState.touchStartX = null;
        gameState.touchEndX = null;
    });
    // Optional: Add pointercancel handler too
    canvas.addEventListener('pointercancel', (event) => {
        gameState.touchStartX = null;
        gameState.touchEndX = null;
    });
}


// --- Keyboard Controls ---
document.addEventListener('keydown', (event) => {
    if (gameState.settingsOpen) return; // Ignore game input if settings open

    const effectiveSpeed = PHYSICS.PLAYER_SPEED; // Use adjusted speed

    // Use a flag to see if we handled the key, to prevent default scrolling etc.
    let handled = false;
    if (event.code === 'Space' || event.code === 'ArrowUp' || event.code === 'KeyW') {
        jump();
        handled = true;
    } else if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
        gameState.player.xVelocity = -effectiveSpeed;
        handled = true; // Arrows don't usually scroll, but good practice
    } else if (event.code === 'ArrowRight' || event.code === 'KeyD') {
        gameState.player.xVelocity = effectiveSpeed;
        handled = true;
    }

    if (handled) {
        event.preventDefault(); // Prevent default action (like spacebar scrolling page)
    }
});

document.addEventListener('keyup', (event) => {
    if (gameState.settingsOpen) return;

    // Stop horizontal movement if the corresponding key is released
    if (((event.code === 'ArrowLeft' || event.code === 'KeyA') && gameState.player.xVelocity < 0) ||
        ((event.code === 'ArrowRight' || event.code === 'KeyD') && gameState.player.xVelocity > 0)) {
        gameState.player.xVelocity = 0;
    }
});

// --- Start the game ---
// Initialize lastTime before the first loop request
gameState.lastTime = performance.now();
requestAnimationFrame(gameLoop);
