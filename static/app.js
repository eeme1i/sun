const rawOutput = document.getElementById("raw-output");
const formattedOutput = document.getElementById("formatted-output");
const locationForm = document.getElementById("location-form");
const queryInput = document.getElementById("query");
const rawToggle = document.getElementById("raw-toggle");
const docs = document.getElementById("docs");
const docsToggle = document.getElementById("docs-toggle");

const docsVisibilityKey = "sun:docs-visible";

let countdownInterval = null;
let countdownRunId = 0;

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
	const runId = ++countdownRunId;

	const sunData = data.results || data;

	function tick() {
		const now = new Date();
		const nextEvent = getNextSunEvent(sunData, now);

		if (!nextEvent && (!sunData.sunrise || !sunData.sunset)) {
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

		if (nextEvent) {
			setFormatted(
				`the sun will ${nextEvent.kind} in`,
				formatDuration(nextEvent.time - now),
			);
		} else {
			// No more events in this response; load the next UTC day.
			setFormatted("the sun has set");
			clearInterval(countdownInterval);
			countdownInterval = null;
			fetchNextSunEventDay(runId, getFollowingSunDate(data));
		}
	}

	tick();
	countdownInterval = setInterval(tick, 1000);
}

function getNextSunEvent(sunData, now) {
	const events = getOrderedSunEvents(sunData).filter((event) => event.time > now);
	events.sort((a, b) => a.time - b.time);
	return events[0] || null;
}

function getOrderedSunEvents(sunData) {
	const sunrise = parseSunEventTime(sunData.sunrise);
	const sunset = parseSunEventTime(sunData.sunset);
	const solarNoon = parseSunEventTime(sunData.solar_noon);

	if (!sunrise || !sunset) return [];
	if (!solarNoon) {
		return [
			{ kind: "rise", time: sunrise },
			{ kind: "set", time: sunset },
		];
	}

	// The API returns UTC clock times on the requested date. Around midnight UTC,
	// sunrise or sunset may need to move one day to preserve local solar order.
	if (sunrise > solarNoon) sunrise.setUTCDate(sunrise.getUTCDate() - 1);
	if (sunset < solarNoon) sunset.setUTCDate(sunset.getUTCDate() + 1);

	return [
		{ kind: "rise", time: sunrise },
		{ kind: "set", time: sunset },
	];
}

function parseSunEventTime(value) {
	if (!value) return null;

	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function getFollowingSunDate(data) {
	const resolvedDate = data.__resolvedDate || todayUTC();
	const currentDate = todayUTC();

	return currentDate > resolvedDate ? currentDate : addUtcDays(resolvedDate, 1);
}

function addUtcDays(dateStr, days) {
	const date = new Date(`${dateStr}T00:00:00+00:00`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function markResolvedDate(data, date) {
	try {
		Object.defineProperty(data, "__resolvedDate", {
			value: date,
			configurable: true,
		});
	} catch {
		// If the object cannot be marked, countdown fallback still works.
	}

	return data;
}

async function fetchNextSunEventDay(runId, dateStr) {
	const loc = state.location;
	if (!loc) return;

	const data = await fetchSunTimes(loc.coord.lat, loc.coord.lon, dateStr);
	if (runId !== countdownRunId) return;

	startCountdown(data);
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
	if (cached) return markResolvedDate(cached, resolvedDate);

	const params = new URLSearchParams({ lat, lng, date: resolvedDate });
	const res = await fetch(`/json?${params}`);
	const data = await res.json();

	if (data.status === "OK") {
		setCachedSunTimes(lat, lng, resolvedDate, data);
	}

	return markResolvedDate(data, resolvedDate);
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
