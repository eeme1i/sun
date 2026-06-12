/**
 * Location finder — geocodes a query string into coordinates via Nominatim.
 * Results are cached in localStorage to avoid redundant API calls.
 */

/** @typedef {{ lat: number, lon: number }} Coordinate */
/** @typedef {{ city: string, country: string, displayName: string, coord: Coordinate }} Location */
/** @typedef {"idle" | "loading" | "success" | "error"} LocationStatus */

const state = {
	/** @type {Location | null} */
	location: null,
	/** @type {LocationStatus} */
	status: "idle",
	/** @type {string | null} */
	error: null,
};

// -- Cache helpers

function getCachedLocation(query) {
	let cachedQuery = null;

	try {
		cachedQuery = localStorage.getItem("location:last-query");
		if (cachedQuery !== query) return null;

		const raw = localStorage.getItem(`location:${query}`);
		if (!raw) return null;

		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function setCachedLocation(query, loc) {
	try {
		localStorage.setItem(`location:${query}`, JSON.stringify(loc));
		localStorage.setItem("location:last-query", query);
	} catch {
		// Ignore storage failures; the fetched location is still returned.
	}
}

// -- Public API

/**
 * Geocode a free-text query into a Location.
 * Returns the Location on success, or null on failure.
 * Check `location.status` and `location.error` for details.
 *
 * @param {string} query
 * @returns {Promise<Location | null>}
 */
async function fetchLocation(query) {
	query = query.trim().toLowerCase();

	if (!query) {
		state.location = null;
		state.status = "idle";
		state.error = null;
		return null;
	}

	const cached = getCachedLocation(query);
	if (cached) {
		state.location = cached;
		state.status = "success";
		state.error = null;
		return cached;
	}

	state.status = "loading";
	state.error = null;

	try {
		const res = await fetch(
			`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
		);

		if (!res.ok) {
			throw new Error(`Location API returned status: ${res.status}`);
		}

		const data = await res.json();

		if (data.length > 0) {
			const loc = {
				city: data[0].display_name.split(",")[0].trim(),
				country: data[0].display_name.split(",").slice(-1)[0].trim(),
				displayName: data[0].display_name,
				coord: {
					lat: parseFloat(data[0].lat),
					lon: parseFloat(data[0].lon),
				},
			};

			state.location = loc;
			state.status = "success";
			state.error = null;
			setCachedLocation(query, loc);
			return loc;
		} else {
			state.location = null;
			state.status = "error";
			state.error = "No location found for the given query.";
			return null;
		}
	} catch (err) {
		console.error("Error fetching location:", err);
		state.location = null;
		state.status = "error";
		state.error =
			err instanceof Error ? err.message : "Failed to fetch location.";
		return null;
	}
}

/**
 * Restore the last-used location from localStorage (if any).
 * @returns {Location | null}
 */
function restoreCachedLocation() {
	let cachedQuery = null;

	try {
		cachedQuery = localStorage.getItem("location:last-query");
	} catch {
		return null;
	}

	if (!cachedQuery) return null;

	const loc = getCachedLocation(cachedQuery);
	if (loc) {
		state.location = loc;
		state.status = "success";
		state.error = null;
	}
	return loc;
}
