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
    const CHART_BOTTOM_MARGIN = 70; // For x-axis labels and title
    const CHART_LEFT_MARGIN = 70;  // For y-axis labels and title

    async function fetchData() {
        try {
            // gbgVarvetJsonPath is defined as a global variable in the HTML <script> tag
            console.log("Attempting to fetch data from:", gbgVarvetJsonPath);
            const response = await fetch(gbgVarvetJsonPath); // Use the path defined in HTML

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
                    // console.warn("NaN for Finish_Minutes. Original:", originalFinishMinutes, "Record:", r);
                }
                if (typeof r['Gender Category'] === 'undefined') {
                    missingGenderCount++;
                    // console.warn("Missing 'Gender Category' in record:", r);
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
            userInfoDiv.innerHTML = `Error loading race data. <br>Attempted to fetch: ${gbgVarvetJsonPath}. <br>Details: ${error.message}. <br>Please check the browser console.`;
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            ctx.fillText("Error loading race data. See console.", canvas.width / 2, 50);
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
        if (filteredResults.length > 0) {
            // console.log("First 3 filtered results:", filteredResults.slice(0,3));
        } else if (allResults.length > 0) {
            console.warn(`No results for filter "${currentFilter}". Check 'Gender Category' values in JSON. Expected "Men" or "Women".`);
        }


        drawHistogram();
        updateUserInfo(); // Update info based on current user time and new filter
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
            if (allResults.length === 0 && !userInfoDiv.textContent.startsWith("Error loading race data")) {
                 ctx.fillText("Loading data...", canvas.width / 2, canvas.height / 2);
            } else if (allResults.length > 0) {
                ctx.fillText(`No data for filter "${currentFilter}".`, canvas.width / 2, canvas.height / 2);
            }
            // If error message is already in userInfoDiv, don't overwrite with "No data"
            return;
        }

        const times = filteredResults.map(r => r.Finish_Minutes).filter(t => !isNaN(t)); // Use only valid times
        if (!times.length) {
            ctx.font = "16px Arial";
            ctx.textAlign = "center";
            ctx.fillText(`No valid time data for filter "${currentFilter}".`, canvas.width / 2, canvas.height / 2);
            console.warn("DrawHistogram: No valid (non-NaN) times in filteredResults.");
            return;
        }

        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);

        // Adjust bin calculation if minTime and maxTime are very close or same
        let startBin = Math.floor(minTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        let endBin = Math.ceil(maxTime / BIN_SIZE_MINUTES) * BIN_SIZE_MINUTES;
        if (endBin <= startBin) endBin = startBin + BIN_SIZE_MINUTES; // Ensure at least one bin range

        const numBins = Math.max(1, Math.round((endBin - startBin) / BIN_SIZE_MINUTES));

        const bins = new Array(numBins).fill(0);
        filteredResults.forEach(result => {
            if (isNaN(result.Finish_Minutes)) return; // Skip NaN times
            let binIndex = Math.floor((result.Finish_Minutes - startBin) / BIN_SIZE_MINUTES);
            binIndex = Math.max(0, Math.min(binIndex, numBins - 1)); // Clamp index
            bins[binIndex]++;
        });

        const maxBinCount = Math.max(...bins, 1);

        const chartWidth = canvas.width - CHART_LEFT_MARGIN - CHART_PADDING;
        const chartHeight = canvas.height - CHART_PADDING - CHART_BOTTOM_MARGIN;
        const barWidth = Math.max(1, chartWidth / numBins); // Ensure barWidth is at least 1

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

        // Draw bars and X-axis labels
        ctx.fillStyle = "skyblue";
        ctx.textAlign = "center";
        const maxLabels = Math.floor(chartWidth / 60); // approx one label every 60px
        const labelStep = numBins <= maxLabels ? 1 : Math.ceil(numBins / maxLabels);

        for (let i = 0; i < numBins; i++) {
            const barHeight = (bins[i] / maxBinCount) * chartHeight;
            const x = CHART_LEFT_MARGIN + i * barWidth;
            const y = canvas.height - CHART_BOTTOM_MARGIN - barHeight;
            if (barWidth > 1) {
                 ctx.fillRect(x, y, barWidth - 1, barHeight);
            } else {
                 ctx.fillRect(x, y, 1, barHeight); // Avoid negative width if barWidth is 1
            }


            if (i % labelStep === 0) {
                const timeForBin = startBin + i * BIN_SIZE_MINUTES;
                ctx.fillStyle = "black";
                ctx.fillText(formatMinutesToHHMM(timeForBin), x + barWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 20);
            }
        }
        ctx.fillStyle = "black";
        ctx.fillText("Finish Time (HH:MM)", CHART_LEFT_MARGIN + chartWidth / 2, canvas.height - CHART_BOTTOM_MARGIN + 45);

        // Draw user's time line
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
        if (currentUserTimeMinutes !== null) {
            const percentile = calculatePercentile(currentUserTimeMinutes);
            if (percentile !== null) {
                userInfoDiv.textContent = `Your time ${formatMinutesToHHMMSS(currentUserTimeMinutes)} places you in the ${percentile}th percentile among "${currentFilter}" runners. (You were faster than ${percentile}% of this group).`;
            } else {
                userInfoDiv.textContent = `Your time: ${formatMinutesToHHMMSS(currentUserTimeMinutes)}. Could not calculate percentile (e.g., no data for current filter or issue with time values).`;
            }
        } else if (!userInfoDiv.textContent.startsWith("Error loading race data")) { // Don't overwrite error message
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
            applyFilterAndDraw();
        } else {
            currentUserTimeMinutes = null;
            applyFilterAndDraw(); // Redraw without user line
            userInfoDiv.textContent = "Invalid time format. Please use HH:MM:SS (e.g., 01:45:30).";
            userTimeInput.focus();
        }
    });

    userTimeInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent form submission if it's in a form
            plotUserTimeButton.click();
        }
    });

    // Initial data load
    fetchData();
});
