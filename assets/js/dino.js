const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const size = 400;
canvas.width = size;
canvas.height = size;
canvas.style.border = '1px solid black';
document.body.appendChild(canvas);

let player = {
    x: 50,
    y: size - 50,
    radius: 15,
    yVelocity: 0,
    gravity: 0.6,
    jumpStrength: -15,
    isJumping: false
};

let obstacles = [];
let obstacleSpeed = 5;
let score = 0;
let gameRunning = true;

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

function updatePlayer() {
    if (player.isJumping) {
        player.yVelocity += player.gravity;
        player.y += player.yVelocity;

        if (player.y > size - 50) {
            player.y = size - 50;
            player.yVelocity = 0;
            player.isJumping = false;
        }
    }
}
function generateObstacle() {
    const height = Math.floor(Math.random() * (50 - 20 + 1)) + 20; // Random height between 20 and 50
    const width = Math.floor(Math.random() * (40-20 +1)) + 20;
    obstacles.push({
        x: size,
        y: size - height,
        width: width,
        height: height
    });
}

function updateObstacles() {
    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].x -= obstacleSpeed;

        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
            i--;
            score++;
            if (score % 5 == 0 && score !=0){
                obstacleSpeed+=1;
            }
        }
    }
    if (obstacles.length == 0 || obstacles[obstacles.length -1].x < size - 150){
      if (Math.random() < 0.02) { // Adjust probability for obstacle frequency
          generateObstacle();
      }
    }
}

function checkCollision() {
    for (let obstacle of obstacles) {
        // Simplified circle-rectangle collision
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
function drawGameOver(){
     ctx.fillStyle = 'black';
    ctx.font = '40px Arial';
    ctx.fillText('Game Over', size/4, size/2);
}

function gameLoop() {
    if (!gameRunning) {
        drawGameOver();
        return;
    }

    ctx.clearRect(0, 0, size, size);

    updatePlayer();
    updateObstacles();

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
    if (!player.isJumping) {
        player.yVelocity = player.jumpStrength;
        player.isJumping = true;
    }
}
// Event Listeners (Keyboard and Touch)
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'ArrowUp') {
        jump();
    }
});

canvas.addEventListener('touchstart', (event) => {
    event.preventDefault();  // Prevent default touch behavior (like scrolling)
    jump();
});

// Start the game
gameLoop();
