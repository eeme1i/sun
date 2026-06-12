const rawOutput = document.getElementById("raw-output");
const formattedOutput = document.getElementById("formatted-output");
const locationForm = document.getElementById("location-form");
const queryInput = document.getElementById("query");
const rawToggle = document.getElementById("raw-toggle");
const docs = document.getElementById("docs");
const docsToggle = document.getElementById("docs-toggle");

const docsVisibilityKey = "sun:docs-visible";

let countdownInterval = null;

locationForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const query = queryInput.value;
	const loc = await fetchLocation(query);
	if (loc) {
		const data = await fetchSunTimes(loc.coord.lat, loc.coord.lon, "today");
		showResults(data);
	} else {
		formattedOutput.textContent = state.error || "Could not determine location.";
		rawOutput.textContent = "";
	}
});

rawToggle.addEventListener("click", () => {
	const isHidden = getComputedStyle(rawOutput).display === "none";
	rawOutput.style.display = isHidden ? "flex" : "none";
	rawToggle.textContent = isHidden ? "hide raw" : "show raw";
});

docsToggle.addEventListener("click", () => {
	setDocsVisible(docs.hidden);
});

// -- Display helpers

function setDocsVisible(isVisible) {
	docs.hidden = !isVisible;
	docsToggle.textContent = isVisible ? "hide docs" : "show docs";
	docsToggle.setAttribute("aria-expanded", String(isVisible));

	try {
		localStorage.setItem(docsVisibilityKey, isVisible ? "true" : "false");
	} catch {
		// Ignore storage failures; the toggle should still work for this page load.
	}
}

function restoreDocsVisibility() {
	let isVisible = true;

	try {
		isVisible = localStorage.getItem(docsVisibilityKey) !== "false";
	} catch {
		isVisible = true;
	}

	setDocsVisible(isVisible);
}

restoreDocsVisibility();

function showResults(data) {
	rawOutput.textContent = JSON.stringify(data, null, 2);
	startCountdown(data);
}

function startCountdown(data) {
	if (countdownInterval) clearInterval(countdownInterval);

	const sunData = data.results || data;
	const sunrise = sunData.sunrise ? new Date(sunData.sunrise) : null;
	const sunset = sunData.sunset ? new Date(sunData.sunset) : null;

	function tick() {
		const now = new Date();

		if (!sunrise || !sunset) {
			// Polar condition
			if (sunData.polar_condition === "POLAR_DAY") {
				setFormatted("☀️ the sun won't set today");
			} else if (sunData.polar_condition === "POLAR_NIGHT") {
				setFormatted("🌑 the sun won't rise today");
			} else {
				setFormatted("—");
			}
			return;
		}

		if (now < sunrise) {
			// Before sunrise — it's night, sun will rise
			const diff = sunrise - now;
			setFormatted("the sun will rise in", formatDuration(diff));
		} else if (now < sunset) {
			// Between sunrise and sunset — it's day, sun will set
			const diff = sunset - now;
			setFormatted("the sun will set in", formatDuration(diff));
		} else {
			// After sunset — need tomorrow's sunrise
			setFormatted("the sun has set");
			clearInterval(countdownInterval);
			countdownInterval = null;
			fetchTomorrowSunrise();
		}
	}

	tick();
	countdownInterval = setInterval(tick, 1000);
}

async function fetchTomorrowSunrise() {
	const loc = state.location;
	if (!loc) return;

	const tomorrow = new Date();
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	const dateStr = tomorrow.toISOString().slice(0, 10);

	const data = await fetchSunTimes(loc.coord.lat, loc.coord.lon, dateStr);
	const sunData = data.results || data;
	const sunrise = sunData.sunrise ? new Date(sunData.sunrise) : null;

	if (!sunrise) return;

	// Restart countdown targeting tomorrow's sunrise
	if (countdownInterval) clearInterval(countdownInterval);

	function tick() {
		const now = new Date();
		const diff = sunrise - now;
		if (diff <= 0) {
			setFormatted("the sun is rising ☀️");
			clearInterval(countdownInterval);
			countdownInterval = null;
			return;
		}
		setFormatted("the sun will rise in", formatDuration(diff));
	}

	tick();
	countdownInterval = setInterval(tick, 1000);
}

function setFormatted(label, timer) {
	if (timer !== undefined) {
		formattedOutput.innerHTML =
			`<span class="label">${label} </span><span class="timer">${timer}</span>`;
	} else {
		formattedOutput.innerHTML = `<span class="label">${label}</span>`;
	}
}

function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// -- Sun times cache (localStorage, keyed by rounded coords + date)

function sunCacheKey(lat, lng, date) {
	// Round to ~1m precision, matching the server-side cache key
	const latR = Math.round(lat * 1e5);
	const lngR = Math.round(lng * 1e5);
	return `sun:${latR}:${lngR}:${date}`;
}

function getCachedSunTimes(lat, lng, date) {
	try {
		const raw = localStorage.getItem(sunCacheKey(lat, lng, date));
		if (!raw) return null;
		const entry = JSON.parse(raw);
		// Only use the cache if it was saved for the same date
		if (entry.cachedDate === date) return entry.data;
		return null;
	} catch {
		return null;
	}
}

function setCachedSunTimes(lat, lng, date, data) {
	const key = sunCacheKey(lat, lng, date);
	try {
		localStorage.setItem(key, JSON.stringify({ cachedDate: date, data }));
	} catch {
		// Ignore storage failures; fetching fresh data still keeps the app usable.
	}
}

function todayUTC() {
	return new Date().toISOString().slice(0, 10);
}

async function fetchSunTimes(lat, lng, date) {
	const resolvedDate = date === "today" ? todayUTC() : date;

	const cached = getCachedSunTimes(lat, lng, resolvedDate);
	if (cached) return cached;

	const params = new URLSearchParams({ lat, lng, date: resolvedDate });
	const res = await fetch(`/json?${params}`);
	const data = await res.json();

	if (data.status === "OK") {
		setCachedSunTimes(lat, lng, resolvedDate, data);
	}

	return data;
}

// Restore last-used location from cache, or default to a query
async function init() {
	let loc = restoreCachedLocation();

	if (!loc) {
		loc = await fetchLocation("new york");
	}

	if (!loc) {
		formattedOutput.textContent = state.error || "Could not determine location.";
		return;
	}

	queryInput.value = loc.city;

	const data = await fetchSunTimes(loc.coord.lat, loc.coord.lon, "today");
	showResults(data);
}

init().catch((err) => {
	formattedOutput.textContent = `Error: ${err.message}`;
});
