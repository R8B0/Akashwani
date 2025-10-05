// Initialize Leaflet inside '#leaflet-wrapper' if present; otherwise use 'map'
let _mapTargetId = 'map';
const wrapper = document.getElementById('leaflet-wrapper');
if (wrapper) {
	// create an inner div to host leaflet so we can hide/show wrapper safely
	let inner = document.getElementById('leaflet-map');
	if (!inner) {
		inner = document.createElement('div');
		inner.id = 'leaflet-map';
		inner.style.width = '100%';
		inner.style.height = '100%';
		wrapper.appendChild(inner);
	}
	_mapTargetId = 'leaflet-map';
}
const map = L.map(_mapTargetId).setView([20.5937, 78.9629], 5); // centered on India by default
// Expose the map instance so callers can trigger resize or destroy it
try { window.__leaflet_map = map; } catch (e) {}

// Provide a destroy helper to clean up Leaflet when toggling views
window.__destroyLeafletMap = function() {
	try {
		if (window.__leaflet_map) {
			window.__leaflet_map.remove();
			window.__leaflet_map = null;
		}
	} catch (e) { /* ignore */ }
}


const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	maxZoom: 19,
	attribution: '© OpenStreetMap'
}).addTo(map);

// Report tile loading errors to the diagnostic overlay if available
try {
	tileLayer.on('tileerror', function(err) {
		try { if (window.diag) window.diag('Tile load error: ' + (err && err.error ? err.error : err)); } catch (e) { console.warn('Tile error', e); }
	});
} catch (e) {}

// Ensure map recalculates size after initial load
try {
	map.whenReady(() => {
		try { map.invalidateSize(); } catch (e) {}
		setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 120);
		setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 400);
	});
} catch (e) {}

// If a shared selection already exists (from globe), place marker now
try {
	if (window.sharedSelection && window.sharedSelection.lat && window.__setSelectedFromExternal) {
		window.__setSelectedFromExternal(window.sharedSelection.lat, window.sharedSelection.lon);
	}
} catch (e) {}


let marker = null;
// Use sharedSelection (created by globe index.js) so both map and globe sync
window.sharedSelection = window.sharedSelection || { lat: null, lon: null };
let selected = window.sharedSelection;

// Allow external callers (for example the globe) to set the selected location
window.__setSelectedFromExternal = function(lat, lon) {
	selected.lat = lat;
	selected.lon = lon;
	try { window.sharedSelection.lat = lat; window.sharedSelection.lon = lon; } catch (e) {}
	const latlng = L.latLng(lat, lon);
	if (marker) marker.setLatLng(latlng); else marker = L.marker(latlng).addTo(map);
	map.setView(latlng, 12);
	const latEl = document.getElementById('lat');
	const lonEl = document.getElementById('lon');
	if (latEl) { if (latEl.tagName === 'INPUT' || latEl.tagName === 'TEXTAREA') latEl.value = lat.toFixed(6); else latEl.innerText = lat.toFixed(6); }
	if (lonEl) { if (lonEl.tagName === 'INPUT' || lonEl.tagName === 'TEXTAREA') lonEl.value = lon.toFixed(6); else lonEl.innerText = lon.toFixed(6); }
	const predictBtn = document.getElementById('predictBtn'); if (predictBtn) predictBtn.disabled = false;
}

const latEl = document.getElementById('lat');
const lonEl = document.getElementById('lon');
const copyBtn = document.getElementById('copyBtn');
const predictBtn = document.getElementById('predictBtn');
const spinner = document.getElementById('spinner');
const predictionEl = document.getElementById('prediction');
const predWeatherEl = document.getElementById('pred-weather');
const predTempEl = document.getElementById('pred-temp');
const predHumidityEl = document.getElementById('pred-humidity');
const manualInput = document.getElementById('manualLocation');
const searchBtn = document.getElementById('searchBtn');


map.on('click', function(e) {
	const { lat, lng } = e.latlng;
	selected.lat = lat;
	selected.lon = lng;

	if (marker) marker.setLatLng(e.latlng);
	else marker = L.marker(e.latlng).addTo(map);

	const latText = lat.toFixed(6);
	const lonText = lng.toFixed(6);
	if (latEl && (latEl.tagName === 'INPUT' || latEl.tagName === 'TEXTAREA')) latEl.value = latText; else if (latEl) latEl.innerText = latText;
	if (lonEl && (lonEl.tagName === 'INPUT' || lonEl.tagName === 'TEXTAREA')) lonEl.value = lonText; else if (lonEl) lonEl.innerText = lonText;
	predictBtn.disabled = false;

	// Reverse geocode to get a nearby human-readable place and fill the manual input
	(async () => {
		if (!manualInput) return;
		spinner.classList.remove('hidden');
		try {
			const r = await reverseGeocode(lat, lng);
			spinner.classList.add('hidden');
			if (r && r.display_name) {
				// prefer a concise name (first part of display_name)
				manualInput.value = r.display_name.split(',')[0];
				showCopyFeedback(manualInput.value);
			} else {
				showCopyFeedback('No nearby place found');
			}
		} catch (err) {
			spinner.classList.add('hidden');
			showCopyFeedback('Reverse geocode failed');
		}
	})();
});

// Reverse geocode using Nominatim
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10&addressdetails=1`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Reverse geocoding failed');
  const data = await res.json();
  return data;
}

// Format prediction object into the requested display format
function formatPrediction(pred) {
	// If pred is a string, try to parse JSON-like content, otherwise return it
	if (typeof pred === 'string') {
		const s = pred.trim();
		if ((s.startsWith('{') || s.startsWith('['))) {
			try { pred = JSON.parse(s); } catch (e) { return pred; }
		} else {
			return pred;
		}
	}

	// Helper to find a reasonable value from multiple possible keys
	const pick = (obj, keys) => {
		for (const k of keys) {
			if (!obj) continue;
			if (k in obj && obj[k] != null) return obj[k];
		}
		return null;
	};

	const weather = pick(pred, ['weather', 'forecast', 'condition', 'summary']);
	const temp = pick(pred, ['temperature_c', 'temp', 'temperature', 't', 'air_temperature', 'model_output']);
	const humidity = pick(pred, ['humidity', 'hum', 'rh', 'relative_humidity']);

	const fmt = v => {
		if (v == null) return 'N/A';
		if (typeof v === 'object') {
			// if it's an object with 'value' or 'probability', try to use that
			if ('value' in v) return v.value;
			if ('probability' in v) return v.probability;
			return JSON.stringify(v);
		}
		return String(v);
	};

	const lines = [];
	lines.push(`Rain: ${fmt(rain)}`);
	lines.push(`Temp: ${fmt(temp)}`);
	lines.push(`Wind: ${fmt(wind)}`);
	lines.push(`Sun Radiation: ${fmt(solar)}`);
	return lines.join('\n');
}

// Populate individual prediction fields with the object
function populatePredictionFields(pred) {
	// If pred is a string try to parse
	if (typeof pred === 'string') {
		const s = pred.trim();
		if ((s.startsWith('{') || s.startsWith('['))) {
			try { pred = JSON.parse(s); } catch (e) { pred = null; }
		} else { pred = null; }
	}

	const pick = (obj, keys) => {
		if (!obj) return null;
		for (const k of keys) if (k in obj && obj[k] != null) return obj[k];
		return null;
	};

	const rain = pick(pred, ['prcp', 'rain', 'rain_chance', 'precipitation_probability', 'precip', 'probability', 'rain_probability']);
	const temp = pick(pred, ['temp', 'temperature', 't', 'air_temperature']);
	const wind = pick(pred, ['wind', 'wind_speed', 'wind_kph', 'wind_m_s']);
	const solar = pick(pred, ['solar', 'sun', 'sun_radiation', 'solar_radiation', 'insolation']);

	const fmt = v => {
		if (v == null) return 'N/A';
		if (typeof v === 'object') {
			if ('value' in v) return v.value;
			if ('probability' in v) return v.probability;
			return JSON.stringify(v);
		}
		return String(v);
	};

	if (predWeatherEl) predWeatherEl.innerText = fmt(weather);
	if (predTempEl) predTempEl.innerText = fmt(temp);
	if (predHumidityEl) predHumidityEl.innerText = fmt(humidity);
}

	// Helper: place marker and update state
	function setMarkerAndCoords(lat, lon) {
		selected.lat = lat;
		selected.lon = lon;
		const latText = lat.toFixed(6);
		const lonText = lon.toFixed(6);
		if (latEl && (latEl.tagName === 'INPUT' || latEl.tagName === 'TEXTAREA')) latEl.value = latText; else if (latEl) latEl.innerText = latText;
		if (lonEl && (lonEl.tagName === 'INPUT' || lonEl.tagName === 'TEXTAREA')) lonEl.value = lonText; else if (lonEl) lonEl.innerText = lonText;
		const latlng = L.latLng(lat, lon);
		if (marker) marker.setLatLng(latlng); else marker = L.marker(latlng).addTo(map);
		map.setView(latlng, 12);
		predictBtn.disabled = false;
	}

	// Geocode using Nominatim (OpenStreetMap)
	async function geocode(q) {
		const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
		const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
		if (!res.ok) throw new Error('Geocoding failed');
		const data = await res.json();
		return data[0];
	}

	searchBtn.addEventListener('click', async () => {
		const q = manualInput.value && manualInput.value.trim();
		if (!q) { showCopyFeedback('Type a place name'); return; }
		spinner.classList.remove('hidden');
		try {
			const r = await geocode(q);
			spinner.classList.add('hidden');
			if (!r) { showCopyFeedback('No results'); return; }
			const lat = parseFloat(r.lat);
			const lon = parseFloat(r.lon);
			setMarkerAndCoords(lat, lon);
			showCopyFeedback(r.display_name.split(',')[0]);
		} catch (err) {
			spinner.classList.add('hidden');
			showCopyFeedback('Geocode error');
		}
	});

	// allow Enter key in manual input to trigger search
	manualInput.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter') { ev.preventDefault(); searchBtn.click(); }
	});


// Copy coordinates to clipboard with small feedback
copyBtn.addEventListener('click', async () => {
	if (!selected.lat) {
		showCopyFeedback('Pick a location first');
		return;
	}
	const text = `${selected.lat.toFixed(6)}, ${selected.lon.toFixed(6)}`;
	try {
		await navigator.clipboard.writeText(text);
		showCopyFeedback('Copied!');
	} catch (err) {
		// fallback: create a temporary textarea
		const ta = document.createElement('textarea');
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); showCopyFeedback('Copied!'); } catch (e) { showCopyFeedback('Copy failed'); }
		ta.remove();
	}
});

function showCopyFeedback(text) {
	let fb = document.querySelector('.copy-feedback');
	if (!fb) {
		fb = document.createElement('div');
		fb.className = 'copy-feedback';
		document.querySelector('.coord-actions').appendChild(fb);
	}
	fb.innerText = text;
	fb.style.opacity = '1';
	setTimeout(() => { fb.style.opacity = '0'; }, 1600);
}


// Send coordinates to backend
predictBtn.addEventListener('click', async () => {
	if (!selected.lat) return;
	predictionEl.innerText = '';
	spinner.classList.remove('hidden');
	predictBtn.disabled = true;

	try {
		const res = await fetch('/predict', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ lat: selected.lat, lon: selected.lon })
		});
		const json = await res.json();
		spinner.classList.add('hidden');
		predictBtn.disabled = false;
		if (!res.ok) {
			predictionEl.innerText = `Error ${res.status}: ${json.error || JSON.stringify(json)}`;
			return;
		}
			// show human-readable prediction when available
				// populate the new structured fields when possible
				if (json.prediction) {
					try {
						populatePredictionFields(json.prediction);
						if (predictionEl) predictionEl.innerText = '';
					} catch (e) {
						if (predictionEl) predictionEl.innerText = typeof json.prediction === 'string' ? json.prediction : JSON.stringify(json.prediction, null, 2);
					}
				} else if (json) {
					try {
						populatePredictionFields(json);
						if (predictionEl) predictionEl.innerText = '';
					} catch (e) {
						if (predictionEl) predictionEl.innerText = JSON.stringify(json, null, 2);
					}
				} else {
					if (predictionEl) predictionEl.innerText = JSON.stringify(json, null, 2);
				}
	} catch (err) {
		spinner.classList.add('hidden');
		predictBtn.disabled = false;
		predictionEl.innerText = 'Error: ' + err.message;
	}
});