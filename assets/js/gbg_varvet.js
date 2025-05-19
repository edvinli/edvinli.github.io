document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    const filterAllButton = document.getElementById('filterAll');
    const filterMenButton = document.getElementById('filterMen');
    const filterWomenButton = document.getElementById('filterWomen');
    const userTimeInput = document.getElementById('userTimeInput');
    const plotUserTimeButton = document.getElementById('plotUserTime');
    const userInfoDiv = document.getElementById('userInfo');

    let allResults = [];
    let filteredResults = [];
    let currentUserTimeMinutes = null;
    let currentFilter = 'All';

    const BIN_SIZE_MINUTES = 5; // Group times into 5-minute bins
    const CHART_PADDING = 60;
    const CHART_BOTTOM_MARGIN = 70; // For x-axis labels
    const CHART_LEFT_MARGIN = 70;  // For y-axis labels

    async function fetchData() {
        try {
            // The script is in assets/js/, data is in assets/data/
            const response = await fetch('../data/goteborgsvarvet_2025_results.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            allResults = await response.json();
            // Ensure Finish_Minutes is a number
            allResults.forEach(r => r.Finish_Minutes = parseFloat(r.Finish_Minutes));
            applyFilterAndDraw();
        } catch (error) {
            console.error("Could not load data:", error);
            userInfoDiv.textContent = "Error loading race data.";
            ctx.font = "16px Arial";
            ctx.fillText("Error loading race data. See console for details.", 10, 50);
        }
    }

    function applyFilterAndDraw() {
        if (currentFilter === 'All') {
            filteredResults = [...allResults];
        } else {
            filteredResults = allResults.filter(result => result['Gender Category'] === currentFilter);
        }
        drawHistogram();
        updateUserInfo();
    }

    function parseTimeToMinutes(timeStr) {
        if (!timeStr || !/^\d{2}:\d{2}:\d{2}$/.test(timeStr)) {
            return null;
        }
        const parts = timeStr.split(':');
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseInt(parts[2], 10);
        if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) ||
            hours < 0 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
            return null;
        }
        return hours * 60 + minutes + seconds / 60;
    }

    function formatMinutesToHHMMSS(totalMinutes) {
        if (totalMinutes === null || isNaN(totalMinutes)) return "N/A";
        const sign = totalMinutes < 0 ? "-" : "";
        const absMinutes = Math.abs(totalMinutes);
        const h = Math.floor(absMinutes / 60);
        const m = Math.floor(absMinutes % 60);
        const s = Math.round((absMinutes * 60) % 60);
        return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
     function formatMinutesToHHMM(totalMinutes) {
        if (totalMinutes === null || isNaN(totalMinutes)) return "N/A";
        const h = Math.floor(totalMinutes / 60);
        const m = Math.round(totalMinutes % 60); // Round to nearest minute for display
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }


    function drawHistogram() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!filteredResults.length) {
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            ctx.fillText("No data for this filter.", canvas.width / 2, canvas.height / 2);
            return;
        }

        const times = filteredResults.map(r => r.Finish_Minutes);
        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);

        const startBin = Math.floor(minTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        const endBin = Math.ceil(maxTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        const numBins = Math.max(1, Math.round((endBin - startBin) / BIN_SIZE_MINUTES)); // Ensure at least 1 bin

        const bins = new Array(numBins).fill(0);
        filteredResults.forEach(result => {
            let binIndex = Math.floor((result.Finish_Minutes - startBin) / BIN_SIZE_MINUTES);
            binIndex = Math.max(0, Math.min(binIndex, numBins - 1)); // Clamp index
            bins[binIndex]++;
        });

        const maxBinCount = Math.max(...bins, 1); // Avoid division by zero if all bins are empty

        const chartWidth = canvas.width - CHART_LEFT_MARGIN - CHART_PADDING;
        const chartHeight = canvas.height - CHART_PADDING - CHART_BOTTOM_MARGIN;
        const barWidth = chartWidth / numBins;

        // Draw Y-axis (Number of Runners)
        ctx.beginPath();
        ctx.moveTo(CHART_LEFT_MARGIN, CHART_PADDING);
        ctx.lineTo(CHART_LEFT_MARGIN, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.stroke();

        // Draw X-axis (Finish Time)
        ctx.beginPath();
        ctx.moveTo(CHART_LEFT_MARGIN, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.lineTo(canvas.width - CHART_PADDING, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.stroke();

        // Y-axis labels and grid lines
        ctx.font = "12px Arial";
        ctx.textAlign = "right";
        ctx.fillStyle = "black";
        const yTickCount = 5;
        for (let i = 0; i <= yTickCount; i++) {
            const val = Math.round((maxBinCount / yTickCount) * i);
            const yPos = (canvas.height - CHART_BOTTOM_MARGIN) - (val / maxBinCount) * chartHeight;
            ctx.fillText(val, CHART_LEFT_MARGIN - 10, yPos + 4); // +4 for vertical alignment

            ctx.beginPath();
            ctx.strokeStyle = "#eee"; // Light grey for grid lines
            ctx.moveTo(CHART_LEFT_MARGIN + 1, yPos);
            ctx.lineTo(canvas.width - CHART_PADDING, yPos);
            ctx.stroke();
            ctx.strokeStyle = "black"; // Reset stroke style
        }
        ctx.save();
        ctx.translate(CHART_LEFT_MARGIN / 3, canvas.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText("Number of Runners", 0, 0);
        ctx.restore();


        // Draw bars and X-axis labels
        ctx.fillStyle = "skyblue";
        ctx.textAlign = "center";
        for (let i = 0; i < numBins; i++) {
            const barHeight = (bins[i] / maxBinCount) * chartHeight;
            const x = CHART_LEFT_MARGIN + i * barWidth;
            const y = canvas.height - CHART_BOTTOM_MARGIN - barHeight;
            ctx.fillRect(x, y, barWidth - 1, barHeight); // -1 for small gap

            // X-axis labels (show fewer labels if too many bins)
            const timeForBin = startBin + i * BIN_SIZE_MINUTES;
            const maxLabels = Math.floor(chartWidth / 60); // approx one label every 60px
            if (numBins <= maxLabels || i % Math.ceil(numBins / maxLabels) === 0) {
                ctx.fillStyle = "black";
                ctx.fillText(formatMinutesToHHMM(timeForBin), x + barWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 20);
            }
        }
        ctx.fillStyle = "black";
        ctx.fillText("Finish Time (HH:MM)", CHART_LEFT_MARGIN + chartWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 45);


        // Draw user's time line
        if (currentUserTimeMinutes !== null) {
            const userTimeX = CHART_LEFT_MARGIN + ((currentUserTimeMinutes - startBin) / BIN_SIZE_MINUTES) * barWidth;
            if (userTimeX >= CHART_LEFT_MARGIN && userTimeX <= canvas.width - CHART_PADDING) {
                ctx.beginPath();
                ctx.strokeStyle = "red";
                ctx.lineWidth = 2;
                ctx.moveTo(userTimeX, CHART_PADDING);
                ctx.lineTo(userTimeX, canvas.height - CHART_BOTTOM_MARGIN);
                ctx.stroke();
                ctx.lineWidth = 1; // Reset
                ctx.strokeStyle = "black"; // Reset
            }
        }
    }

    function calculatePercentile(userTime) {
        if (userTime === null || !filteredResults.length) return null;
        // Percentile: percentage of runners you are faster than (i.e., who had a SLOWER time)
        const slowerRunners = filteredResults.filter(r => r.Finish_Minutes > userTime).length;
        const percentile = (slowerRunners / filteredResults.length) * 100;
        return percentile.toFixed(2);
    }

    function updateUserInfo() {
        if (currentUserTimeMinutes !== null) {
            const percentile = calculatePercentile(currentUserTimeMinutes);
            if (percentile !== null) {
                userInfoDiv.textContent = `Your time ${formatMinutesToHHMMSS(currentUserTimeMinutes)} places you in the ${percentile}th percentile among "${currentFilter}" runners. (You were faster than ${percentile}% of this group).`;
            } else {
                userInfoDiv.textContent = `Your time: ${formatMinutesToHHMMSS(currentUserTimeMinutes)}. Could not calculate percentile (no data for current filter?).`;
            }
        } else {
            userInfoDiv.textContent = "Enter your time to see where you rank.";
        }
    }

    // Event Listeners
    filterAllButton.addEventListener('click', () => {
        currentFilter = 'All';
        applyFilterAndDraw();
    });
    filterMenButton.addEventListener('click', () => {
        currentFilter = 'Men';
        applyFilterAndDraw();
    });
    filterWomenButton.addEventListener('click', () => {
        currentFilter = 'Women';
        applyFilterAndDraw();
    });

    plotUserTimeButton.addEventListener('click', () => {
        const timeStr = userTimeInput.value.trim();
        const parsedTime = parseTimeToMinutes(timeStr);
        if (parsedTime !== null) {
            currentUserTimeMinutes = parsedTime;
            applyFilterAndDraw(); // This will redraw and update info
        } else {
            currentUserTimeMinutes = null; // Clear previous time if new one is invalid
            applyFilterAndDraw(); // Redraw without user line
            userInfoDiv.textContent = "Invalid time format. Please use HH:MM:SS (e.g., 01:45:30).";
            userTimeInput.focus();
        }
    });
    
    userTimeInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            plotUserTimeButton.click();
        }
    });

    // Initial data load
    fetchData();
});
