document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('canvas');
    
    // Read the JSON path from the canvas element's data attribute
    const gbgVarvetJsonPathFromData = canvas.dataset.jsonPath;

    // Ensure canvas and its context are obtained after checking canvas exists
    if (!canvas) {
        console.error("ERROR: Canvas element not found!");
        const userInfoDivNoCanvas = document.getElementById('userInfo');
        if(userInfoDivNoCanvas) userInfoDivNoCanvas.textContent = "Critical error: Canvas element missing from page.";
        return; // Stop script execution if canvas is missing
    }
    const ctx = canvas.getContext('2d');


    const filterAllButton = document.getElementById('filterAll');
    const filterMenButton = document.getElementById('filterMen');
    const filterWomenButton = document.getElementById('filterWomen');
    const userTimeInput = document.getElementById('userTimeInput');
    const plotUserTimeButton = document.getElementById('plotUserTime');
    const userInfoDiv = document.getElementById('userInfo');

    // Check if all required elements are present
    if (!filterAllButton || !filterMenButton || !filterWomenButton || !userTimeInput || !plotUserTimeButton || !userInfoDiv) {
        console.error("ERROR: One or more UI elements (buttons, input, info div) are missing!");
        if(userInfoDiv) userInfoDiv.textContent = "Critical error: UI elements missing. Check IDs.";
        // Optionally, you could disable functionality or just log the error
        // For now, we'll let it proceed but it might error later if an element is used
    }


    let allResults = [];
    let filteredResults = [];
    let currentUserTimeMinutes = null;
    let currentFilter = 'All';

    const BIN_SIZE_MINUTES = 5; // Group times into 5-minute bins
    const CHART_PADDING = 60;
    const CHART_BOTTOM_MARGIN = 70; // For x-axis labels and title
    const CHART_LEFT_MARGIN = 70;  // For y-axis labels and title

    async function fetchData() {
        try {
            console.log("Attempting to fetch data from (data-attribute):", gbgVarvetJsonPathFromData);
            const response = await fetch(gbgVarvetJsonPathFromData);

            console.log("Fetch response status:", response.status, "URL:", response.url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status} for ${response.url}`);
            }
            const rawData = await response.json();
            console.log("Raw data received (first 3 entries):", rawData.slice(0, 3));

            allResults = rawData;
            let nanCount = 0;
            let missingGenderCount = 0;
            allResults.forEach(r => {
                const originalFinishMinutes = r.Finish_Minutes;
                r.Finish_Minutes = parseFloat(originalFinishMinutes);
                if (isNaN(r.Finish_Minutes)) {
                    nanCount++;
                }
                if (typeof r['Gender Category'] === 'undefined') {
                    missingGenderCount++;
                }
            });
            if (nanCount > 0) {
                console.warn(`Found ${nanCount} entries where Finish_Minutes resulted in NaN.`);
            }
            if (missingGenderCount > 0) {
                console.warn(`Found ${missingGenderCount} entries missing 'Gender Category'.`);
            }
            console.log("Processed allResults (first 3 with parsed Finish_Minutes):", allResults.slice(0, 3));

            applyFilterAndDraw();
        } catch (error) {
            console.error("Could not load or process data:", error);
            if(userInfoDiv) {
                userInfoDiv.innerHTML = `Error loading race data. <br>Attempted to fetch from: ${gbgVarvetJsonPathFromData}. <br>Details: ${error.message}. <br>Please check the browser console.`;
            }
            if(ctx) {
                ctx.font = "16px Arial";
                ctx.textAlign = "center";
                ctx.fillText("Error loading race data. See console.", canvas.width / 2, 50);
            }
        }
    }

    function applyFilterAndDraw() {
        console.log(`Applying filter: ${currentFilter}`);
        if (currentFilter === 'All') {
            filteredResults = [...allResults];
        } else {
            filteredResults = allResults.filter(result => result['Gender Category'] === currentFilter);
        }
        console.log(`Filtered results count: ${filteredResults.length}`);
        if (filteredResults.length === 0 && allResults.length > 0) {
            console.warn(`No results for filter "${currentFilter}". Check 'Gender Category' values in JSON. Expected "Men" or "Women".`);
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
        const m = Math.round(totalMinutes % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function drawHistogram() {
        if (!ctx) return; // Can't draw if no context
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!filteredResults.length) {
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            if (allResults.length === 0 && (!userInfoDiv || !userInfoDiv.textContent.startsWith("Error loading race data"))) {
                 ctx.fillText("Loading data...", canvas.width / 2, canvas.height / 2);
            } else if (allResults.length > 0) {
                ctx.fillText(`No data for filter "${currentFilter}".`, canvas.width / 2, canvas.height / 2);
            }
            return;
        }

        const times = filteredResults.map(r => r.Finish_Minutes).filter(t => !isNaN(t));
        if (!times.length) {
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            ctx.fillText(`No valid time data for filter "${currentFilter}".`, canvas.width / 2, canvas.height / 2);
            console.warn("DrawHistogram: No valid (non-NaN) times in filteredResults.");
            return;
        }

        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        let startBin = Math.floor(minTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        let endBin = Math.ceil(maxTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        if (endBin <= startBin) endBin = startBin + BIN_SIZE_MINUTES;

        const numBins = Math.max(1, Math.round((endBin - startBin) / BIN_SIZE_MINUTES));
        const bins = new Array(numBins).fill(0);
        filteredResults.forEach(result => {
            if (isNaN(result.Finish_Minutes)) return;
            let binIndex = Math.floor((result.Finish_Minutes - startBin) / BIN_SIZE_MINUTES);
            binIndex = Math.max(0, Math.min(binIndex, numBins - 1));
            bins[binIndex]++;
        });

        const maxBinCount = Math.max(...bins, 1);
        const chartWidth = canvas.width - CHART_LEFT_MARGIN - CHART_PADDING;
        const chartHeight = canvas.height - CHART_PADDING - CHART_BOTTOM_MARGIN;
        const barWidth = Math.max(1, chartWidth / numBins);

        ctx.beginPath();
        ctx.moveTo(CHART_LEFT_MARGIN, CHART_PADDING);
        ctx.lineTo(CHART_LEFT_MARGIN, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(CHART_LEFT_MARGIN, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.lineTo(canvas.width - CHART_PADDING, canvas.height - CHART_BOTTOM_MARGIN);
        ctx.stroke();

        ctx.font = "12px Arial";
        ctx.textAlign = "right";
        ctx.fillStyle = "black";
        const yTickCount = 5;
        for (let i = 0; i <= yTickCount; i++) {
            const val = Math.round((maxBinCount / yTickCount) * i);
            const yPos = (canvas.height - CHART_BOTTOM_MARGIN) - (val / maxBinCount) * chartHeight;
            ctx.fillText(val, CHART_LEFT_MARGIN - 10, yPos + 4);
            ctx.beginPath();
            ctx.strokeStyle = "#eee";
            ctx.moveTo(CHART_LEFT_MARGIN + 1, yPos);
            ctx.lineTo(canvas.width - CHART_PADDING, yPos);
            ctx.stroke();
            ctx.strokeStyle = "black";
        }
        ctx.save();
        ctx.translate(CHART_LEFT_MARGIN / 3, CHART_PADDING + chartHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText("Number of Runners", 0, 0);
        ctx.restore();

        ctx.fillStyle = "skyblue";
        ctx.textAlign = "center";
        const maxLabels = Math.floor(chartWidth / 60);
        const labelStep = numBins <= maxLabels ? 1 : Math.ceil(numBins / maxLabels);
        for (let i = 0; i < numBins; i++) {
            const barHeight = (bins[i] / maxBinCount) * chartHeight;
            const x = CHART_LEFT_MARGIN + i * barWidth;
            const y = canvas.height - CHART_BOTTOM_MARGIN - barHeight;
            ctx.fillRect(x, y, barWidth > 1 ? barWidth - 1 : 1, barHeight);
            if (i % labelStep === 0) {
                const timeForBin = startBin + i * BIN_SIZE_MINUTES;
                ctx.fillStyle = "black";
                ctx.fillText(formatMinutesToHHMM(timeForBin), x + barWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 20);
            }
        }
        ctx.fillStyle = "black";
        ctx.fillText("Finish Time (HH:MM)", CHART_LEFT_MARGIN + chartWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 45);

        if (currentUserTimeMinutes !== null && !isNaN(currentUserTimeMinutes)) {
            const userTimeRatio = (currentUserTimeMinutes - startBin) / (endBin - startBin);
            const userTimeX = CHART_LEFT_MARGIN + userTimeRatio * chartWidth;
            if (userTimeX >= CHART_LEFT_MARGIN && userTimeX <= canvas.width - CHART_PADDING) {
                ctx.beginPath();
                ctx.strokeStyle = "red";
                ctx.lineWidth = 2;
                ctx.moveTo(userTimeX, CHART_PADDING);
                ctx.lineTo(userTimeX, canvas.height - CHART_BOTTOM_MARGIN);
                ctx.stroke();
                ctx.lineWidth = 1;
                ctx.strokeStyle = "black";
            }
        }
    }

    function calculatePercentile(userTime) {
        console.log("Calculating percentile for userTime:", userTime);
        if (userTime === null || isNaN(userTime) || !filteredResults.length) {
            console.log("Cannot calculate percentile: userTime invalid or filteredResults is empty.");
            return null;
        }
        const validTimesInFilteredResults = filteredResults.filter(r => !isNaN(r.Finish_Minutes));
        if (validTimesInFilteredResults.length === 0) {
            console.warn("No valid Finish_Minutes in filteredResults for percentile calculation.");
            return null;
        }
        console.log("Using N_valid_filtered_results for percentile:", validTimesInFilteredResults.length);
        const slowerRunners = validTimesInFilteredResults.filter(r => r.Finish_Minutes > userTime).length;
        console.log("Number of slower runners:", slowerRunners);
        const percentile = (slowerRunners / validTimesInFilteredResults.length) * 100;
        return percentile.toFixed(2);
    }

    function updateUserInfo() {
        if (!userInfoDiv) return; // Can't update if div is missing

        if (currentUserTimeMinutes !== null) {
            const percentile = calculatePercentile(currentUserTimeMinutes);
            if (percentile !== null) {
                userInfoDiv.textContent = `Your time ${formatMinutesToHHMMSS(currentUserTimeMinutes)} places you in the ${percentile}th percentile among "${currentFilter}" runners. (You were faster than ${percentile}% of this group).`;
            } else {
                userInfoDiv.textContent = `Your time: ${formatMinutesToHHMMSS(currentUserTimeMinutes)}. Could not calculate percentile (e.g., no data for current filter or issue with time values).`;
            }
        } else if (!userInfoDiv.textContent.startsWith("Error loading race data")) {
            userInfoDiv.textContent = "Enter your time to see where you rank.";
        }
    }

    // Event Listeners - Add null checks for buttons in case they are missing
    if(filterAllButton) filterAllButton.addEventListener('click', () => {
        currentFilter = 'All';
        applyFilterAndDraw();
    });
    if(filterMenButton) filterMenButton.addEventListener('click', () => {
        currentFilter = 'Men';
        applyFilterAndDraw();
    });
    if(filterWomenButton) filterWomenButton.addEventListener('click', () => {
        currentFilter = 'Women';
        applyFilterAndDraw();
    });
    if(plotUserTimeButton) plotUserTimeButton.addEventListener('click', () => {
        const timeStr = userTimeInput.value.trim(); // userTimeInput also needs to be checked if it can be null
        const parsedTime = parseTimeToMinutes(timeStr);
        if (parsedTime !== null) {
            currentUserTimeMinutes = parsedTime;
            applyFilterAndDraw();
        } else {
            currentUserTimeMinutes = null;
            applyFilterAndDraw();
            if(userInfoDiv) userInfoDiv.textContent = "Invalid time format. Please use HH:MM:SS (e.g., 01:45:30).";
            if(userTimeInput) userTimeInput.focus();
        }
    });
    if(userTimeInput) userTimeInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            if(plotUserTimeButton) plotUserTimeButton.click();
        }
    });

    // Initial data load
    if (gbgVarvetJsonPathFromData) {
        fetchData();
    } else {
        console.error("ERROR: JSON data path not found on canvas data attribute (data-json-path).");
        if(userInfoDiv) userInfoDiv.textContent = "Configuration error: Cannot find data path for results.";
    }
});
