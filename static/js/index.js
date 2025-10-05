import * as THREE from "three";
import { OrbitControls } from 'jsm/controls/OrbitControls.js';
import getStarfield from "./src/getStarfield.js";
import { drawThreeGeo } from "./src/threeGeoJSON.js";

// Mount renderer into #map instead of document.body
const mapEl = document.getElementById('map') || document.body;
// shared selection object so map and globe stay in sync
window.sharedSelection = window.sharedSelection || { lat: null, lon: null };
const w = mapEl.clientWidth || window.innerWidth;
const h = Math.max(mapEl.clientHeight || window.innerHeight, 360);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.3);
const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
camera.position.z = 5;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(w, h);
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
mapEl.innerHTML = '';
mapEl.appendChild(renderer.domElement);
mapEl.style.position = 'relative';

// Diagnostic overlay to help debug why Leaflet may not load in some browsers
function createDiagnosticOverlay() {
  if (document.getElementById('diag-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'diag-panel';
  panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;background:rgba(0,0,0,0.75);color:#fff;padding:8px 10px;border-radius:6px;max-width:320px;font-family:monospace;font-size:12px;line-height:1.2;display:none;';
  panel.innerHTML = '<strong>Map diagnostic</strong><div id="diag-content">Initializing...</div><div style="margin-top:6px;text-align:right;"><button id="diag-close" style="background:#fff;color:#000;border-radius:4px;padding:4px 6px;border:none;cursor:pointer">Close</button></div>';
  document.body.appendChild(panel);
  document.getElementById('diag-close').addEventListener('click', () => panel.remove());
}
function diag(msg) { createDiagnosticOverlay(); const el = document.getElementById('diag-content'); if (!el) return; const p = document.createElement('div'); p.textContent = msg; el.appendChild(p); }
function diagClear(){ const el=document.getElementById('diag-content'); if(el) el.innerHTML=''; }

// Capture global errors to the diagnostic panel
window.addEventListener('error', function(evt){ try { diag('Error: '+(evt && evt.message ? evt.message : evt)); } catch(e){} });
window.addEventListener('unhandledrejection', function(evt){ try { diag('Promise rejection: '+(evt && evt.reason ? evt.reason : evt)); } catch(e){} });

// Diagnostic toggle button (hidden by default). Click to open diagnostics.
function createDiagToggle() {
  if (document.getElementById('diag-toggle')) return;
  const btn = document.createElement('button');
  btn.id = 'diag-toggle';
  btn.textContent = 'Diag';
  btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:100000;background:#ffffff;color:#000;padding:8px 10px;border-radius:6px;border:none;cursor:pointer;font-weight:700;';
  btn.title = 'Toggle diagnostic panel';
  btn.addEventListener('click', () => {
    const panel = document.getElementById('diag-panel');
    if (!panel) {
      createDiagnosticOverlay();
      return;
    }
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.body.appendChild(btn);
}

createDiagToggle();

// Raycaster and pointer for clicking the globe
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let marker = null;
let selected = { lat: null, lon: null };
let countriesGeo = null;
let popPlaces = null; // loaded populated places points
let landContainer = null;
let indiaStatesGeo = null; // optional admin-1 polygons for India

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const geometry = new THREE.SphereGeometry(2, 64, 64);
const lineMat = new THREE.LineBasicMaterial({ 
  color: 0xffffff,
  transparent: true,
  opacity: 0.4, 
});
const edges = new THREE.EdgesGeometry(geometry, 1);
const line = new THREE.LineSegments(edges, lineMat);
scene.add(line);

const stars = getStarfield({ numStars: 1000, fog: false });
scene.add(stars);


// helper: convert 3D position to lon/lat
function posToLonLat(pos) {
  const x = pos.x;
  const y = pos.y;
  const z = pos.z;
  const r = Math.sqrt(x * x + y * y + z * z);
  const lat = Math.asin(z / r) * 180 / Math.PI;
  const lon = Math.atan2(y, x) * 180 / Math.PI;
  return { lon, lat };
}

function placeMarker(position) {
  if (marker) scene.remove(marker);
  const mkGeo = new THREE.SphereGeometry(0.03, 12, 12);
  const mkMat = new THREE.MeshBasicMaterial({ color: 0x00FFFF });
  marker = new THREE.Mesh(mkGeo, mkMat);
  marker.position.copy(position);
  scene.add(marker);
}

// Convert lon/lat (degrees) to 3D vector on sphere of given radius
function lonLatToVector3(lon, lat, radius = 2) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

// Allow external callers to position the globe marker and recenter the camera
window.__setGlobeFromExternal = function(lat, lon) {
  try {
    const pos = lonLatToVector3(lon, lat, 2);
    placeMarker(pos);
    // point camera at the selected location
    try {
      // set OrbitControls target and move camera to a good distance along normal
      controls.target.copy(new THREE.Vector3(0,0,0));
    } catch (e) {}
    // compute a camera offset along the vector direction (back away from the point)
    try {
      const dir = pos.clone().normalize();
      const camDist = 3.5; // distance from origin
      camera.position.copy(dir.clone().multiplyScalar(camDist));
      controls.target.copy(new THREE.Vector3(0,0,0));
      // then orbit so that the selected point is near center: look at origin and set a small offset
      controls.update();
    } catch (e) {}
    // store selection
    try { window.sharedSelection.lat = lat; window.sharedSelection.lon = lon; } catch (e) {}
  } catch (e) { console.warn('Failed to set globe position', e); }
}

function onPointerDown(event) {
  // normalize pointer coords relative to renderer.domElement
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  // intersect with sphere centered at origin radius ~2
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.01);
  const intersects = raycaster.ray.intersectSphere(sphere, new THREE.Vector3());
  if (intersects) {
    placeMarker(intersects);
    // If landContainer was rotated (drawThreeGeo applied rotation), apply inverse
    // so lon/lat align with the geojson coordinate space used for lookups.
    let lookupPoint = intersects.clone();
    if (landContainer && landContainer.rotation) {
      // apply inverse X rotation (drawThreeGeo sets rotation.x = -Math.PI * 0.5)
      const invMat = new THREE.Matrix4().makeRotationX(-landContainer.rotation.x);
      lookupPoint.applyMatrix4(invMat);
    }
    const { lon, lat } = posToLonLat(lookupPoint);

    // Fill the form fields in the page if present (compat with map.js UI)
    const latEl = document.getElementById('lat');
    const lonEl = document.getElementById('lon');
    const predictBtn = document.getElementById('predictBtn');
    if (latEl) {
      if (latEl.tagName === 'INPUT' || latEl.tagName === 'TEXTAREA') latEl.value = lat.toFixed(6); else latEl.innerText = lat.toFixed(6);
    }
    if (lonEl) {
      if (lonEl.tagName === 'INPUT' || lonEl.tagName === 'TEXTAREA') lonEl.value = lon.toFixed(6); else lonEl.innerText = lon.toFixed(6);
    }
    if (predictBtn) predictBtn.disabled = false;
  // mirror selection into shared object so map can read it
  try { window.sharedSelection.lat = lat; window.sharedSelection.lon = lon; } catch (e) {}
    // store selected coords for the predict handler
    selected.lat = lat;
    selected.lon = lon;
    // Update manualLocation using the lat/lon (refactored helper)
    updateManualFromLatLon(lat, lon);
  }
}

renderer.domElement.style.touchAction = 'none';
renderer.domElement.addEventListener('pointerdown', onPointerDown, false);

// fetch geojson from server-rooted path
fetch('/geojson/ne_110m_land.json')
  .then(response => response.text())
  .then(text => {
    const data = JSON.parse(text);
    landContainer = drawThreeGeo({
      json: data,
      radius: 2,
      // Use cyan for land (matches border color) and make it slightly translucent
      materialOptions: {
        color: 0x00FFFF,
        opacity: 0.28,
        transparent: true,
      },
    });
    scene.add(landContainer);
  }).catch(() => {});

// country boundaries (thin white lines)
fetch('/geojson/countries_states.geojson')
  .then(response => response.text())
  .then(text => {
    const data = JSON.parse(text);
    countriesGeo = data;
    const borders = drawThreeGeo({
      json: data,
      radius: 2.001, // slightly above the land so borders are visible
      materialOptions: {
        color: 0x00FFFF,
        opacity: 0.8,
        linewidth: 1
      },
    });
    scene.add(borders);
  }).catch(() => {});

// load populated places (points) to enable nearest-place lookup
fetch('/geojson/pop_places.geojson')
  .then(r => r.json())
  .then(j => {
    if (j && j.features) {
      popPlaces = j.features.map(f => {
        const coords = f.geometry && f.geometry.coordinates;
        const props = f.properties || {};
        return {
          lon: coords ? coords[0] : null,
          lat: coords ? coords[1] : null,
          name: props.NAME || props.NAMEASCII || props.LS_NAME || props.GN_ASCII || null,
          pop: props.POP_MAX || props.GN_POP || null
        };
      }).filter(p => p.lat != null && p.lon != null);
    }
  }).catch(() => { popPlaces = null; });

// Try to load an optional India admin-1 GeoJSON (place a file named india_states.geojson in geojson/ to enable)
fetch('/geojson/india_states.geojson')
  .then(r => r.json())
  .then(j => { indiaStatesGeo = j; })
  .catch(() => { indiaStatesGeo = null; });

// point-in-polygon helpers (2D lon/lat)
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, polygon) {
  if (!polygon || polygon.length === 0) return false;
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false;
  }
  return true;
}

function featureContains(feature, lon, lat) {
  const geom = feature.geometry;
  if (!geom) return false;
  if (geom.type === 'Polygon') {
    return pointInPolygon(lon, lat, geom.coordinates);
  } else if (geom.type === 'MultiPolygon') {
    for (let i = 0; i < geom.coordinates.length; i++) {
      if (pointInPolygon(lon, lat, geom.coordinates[i])) return true;
    }
    return false;
  }
  return false;
}

function findLocationName(lon, lat) {
  if (!countriesGeo || !countriesGeo.features) return null;
  for (let i = 0; i < countriesGeo.features.length; i++) {
    const f = countriesGeo.features[i];
    try {
      if (featureContains(f, lon, lat)) {
        const props = f.properties || {};
        const name = props.name || props.NAME || props.admin || props.ADMIN || null;
        const admin = props.admin || props.ADMIN || null;
        if (name && admin && String(name).toLowerCase() !== String(admin).toLowerCase()) {
          return `${name}, ${admin}`;
        } else if (name) {
          return `${name}`;
        } else if (admin) {
          return `${admin}`;
        } else {
          return 'Unknown';
        }
      }
    } catch (e) {
    }
  }
  return null;
}

// Reverse geocode using Nominatim (OpenStreetMap)
async function reverseGeocode(lat, lon) {
  const url = `/reverse_geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Reverse geocoding failed');
  const data = await res.json();
  return data;
}

// Small feedback helper used by the old map.js (keeps UI consistent)
function showCopyFeedback(text) {
  let fb = document.querySelector('.copy-feedback');
  if (!fb) {
    fb = document.createElement('div');
    fb.className = 'copy-feedback';
    const actions = document.querySelector('.coord-actions');
    if (actions) actions.appendChild(fb); else document.body.appendChild(fb);
  }
  fb.innerText = text;
  fb.style.opacity = '1';
  setTimeout(() => { fb.style.opacity = '0'; }, 1600);
}

// Pick a human-friendly name from Nominatim address object
function pickAddressField(address) {
  if (!address) return null;
  const prefer = ['city', 'town', 'village', 'hamlet', 'locality', 'municipality', 'county', 'state_district', 'state', 'region', 'country'];
  for (const k of prefer) {
    if (k in address && address[k]) return address[k];
  }
  // fallback to display_name parts if available
  return null;
}

// Update the manualLocation input using lat/lon; shows spinner and feedback
async function updateManualFromLatLon(lat, lon) {
  const manualInput = document.getElementById('manualLocation');
  const spinner = document.getElementById('spinner');
  const searchBtn = document.getElementById('searchBtn');
  if (manualInput) manualInput.value = 'Loading...';
  if (spinner) spinner.classList.remove('hidden');
  if (searchBtn) searchBtn.disabled = true;
  try {
    // Prefer nearest populated place from local dataset (more precise for cities/towns)
    let name = null;
    try {
      if (popPlaces && popPlaces.length) {
        const nearest = findNearestPlace(lat, lon, 10); // 10 km threshold
        if (nearest) name = nearest;
      }
    } catch (e) {
      // fall through to polygon or remote
    }
    // fallback to local polygon (country/region)
    if (!name) name = findLocationName(lon, lat);

    // If India local admin-1 GeoJSON is available, prefer that for accurate state lookup
    if (!name && indiaStatesGeo) {
      try {
        // indiaStatesGeo is expected to be a FeatureCollection with state polygons
        for (let i = 0; i < (indiaStatesGeo.features || []).length; i++) {
          const f = indiaStatesGeo.features[i];
          if (featureContains(f, lon, lat)) {
            const props = f.properties || {};
            const stateName = props.name || props.NAME || props.NAME_1 || props.st_nm || props.STATE || null;
            if (stateName) {
              name = `${stateName}, India`;
              break;
            }
          }
        }
      } catch (e) {
        // ignore and fall back to other methods
      }
    }

    // If we found India as the country (or above didn't run), try to get the Admin-1 (state) via reverse geocode if not already set
    if ((!name || /\bIndia\b/i.test(String(name))) && !/, India$/.test(String(name))) {
      try {
        const rState = await reverseGeocode(lat, lon);
        if (rState && rState.address) {
          const state = rState.address.state || rState.address.state_district || rState.address.region || rState.address.county;
          if (state) name = `${state}, India`;
        }
      } catch (e) {
        // ignore and fall back to country name
      }
    }

    // final fallback: remote reverse geocode for everything else
    if (!name) {
      const r = await reverseGeocode(lat, lon);
      if (r && r.address) {
        name = pickAddressField(r.address) || (r.display_name ? r.display_name.split(',')[0] : null);
      } else if (r && r.display_name) {
        name = r.display_name.split(',')[0];
      }
    }
    if (manualInput) {
      manualInput.value = name || '';
      if (name) showCopyFeedback(name);
    }
  } catch (e) {
    if (manualInput) manualInput.value = '';
    showCopyFeedback('Reverse geocode failed');
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (searchBtn) searchBtn.disabled = false;
  }
}

// Find nearest populated place from loaded popPlaces within maxDistanceKm
function findNearestPlace(lat, lon, maxDistanceKm = 50) {
  if (!popPlaces || !popPlaces.length) return null;
  // quick bbox prefilter (rough): compute roughly degrees for maxDistanceKm
  const degPerKm = 1 / 111; // ~1 degree ~111 km
  const dDeg = maxDistanceKm * degPerKm;
  const minLat = lat - dDeg;
  const maxLat = lat + dDeg;
  const minLon = lon - dDeg;
  const maxLon = lon + dDeg;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < popPlaces.length; i++) {
    const p = popPlaces[i];
    if (p.lat < minLat || p.lat > maxLat || p.lon < minLon || p.lon > maxLon) continue;
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (best && bestDist <= maxDistanceKm) return best.name || null;
  return null;
}

// Haversine distance (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // earth radius km
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*toRad) * Math.cos(lat2*toRad) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// subtle cyan halo/highlight around the globe
{
  const haloGeo = new THREE.SphereGeometry(2.02, 64, 64);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x00FFFF,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  scene.add(halo);
}

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  controls.update();
}

animate();

function handleWindowResize () {
  const w2 = mapEl.clientWidth || window.innerWidth;
  const h2 = Math.max(mapEl.clientHeight || window.innerHeight, 360);
  camera.aspect = w2 / h2;
  camera.updateProjectionMatrix();
  renderer.setSize(w2, h2);
  // Ensure the canvas CSS fills the container after a programmatic size change.
  try {
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
  } catch (e) {}
}
window.addEventListener('resize', handleWindowResize, false);

// Toggle between globe (three.js) and Leaflet map
let usingLeaflet = false;
let leafletModule = null;
let leafletContainer = null;
const toggleBtn = document.getElementById('toggleMapGlobeBtn');
if (toggleBtn) {
  toggleBtn.addEventListener('click', async () => {
    if (!usingLeaflet) {
      // switch to leaflet map view
      try {
        // hide three.js canvas
        renderer.domElement.style.display = 'none';
        // dynamically load the existing map.js logic by inserting the script
        // Note: map.js expects elements with ids used in the legacy UI. We
        // will append a small wrapper to initialize it.
        if (!leafletContainer) {
          leafletContainer = document.createElement('div');
          leafletContainer.id = 'leaflet-wrapper';
          leafletContainer.style.position = 'absolute';
          leafletContainer.style.top = '0';
          leafletContainer.style.left = '0';
          leafletContainer.style.right = '0';
          leafletContainer.style.bottom = '0';
          mapEl.appendChild(leafletContainer);
        }
        // Load Leaflet CSS and JS first (if not present), then load map.js.
        // Wait for CSS and JS to be ready before initializing the map to avoid
        // rendering artifacts (tiles appearing as blocks).
        const ensureLeaflet = () => new Promise((resolve, reject) => {
          let cssReady = false;
          let jsReady = false;

          function maybeResolve() {
            if (cssReady && jsReady) resolve();
          }

          // CSS
          if (!document.getElementById('leaflet-css')) {
            diag('Loading Leaflet CSS...');
            const lcss = document.createElement('link');
            lcss.id = 'leaflet-css';
            lcss.rel = 'stylesheet';
            lcss.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            lcss.crossOrigin = '';
            lcss.onload = () => { cssReady = true; diag('Leaflet CSS loaded'); maybeResolve(); };
            lcss.onerror = (e) => { cssReady = true; diag('Leaflet CSS failed to load: '+e); maybeResolve(); };
            document.head.appendChild(lcss);
          } else {
            cssReady = true;
            diag('Leaflet CSS already present');
          }

          // JS
          if (window.L) {
            jsReady = true;
            diag('Leaflet already loaded');
            maybeResolve();
          } else if (!document.getElementById('leaflet-js')) {
            diag('Loading Leaflet JS...');
            const ljs = document.createElement('script');
            ljs.id = 'leaflet-js';
            ljs.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            ljs.defer = true;
            ljs.crossOrigin = '';
            ljs.onload = () => { jsReady = true; diag('Leaflet JS loaded'); maybeResolve(); };
            ljs.onerror = (e) => { jsReady = true; diag('Leaflet JS failed to load: '+e); maybeResolve(); };
            document.body.appendChild(ljs);
          } else {
            diag('Leaflet JS script element already present, waiting for load');
            const existing = document.getElementById('leaflet-js');
            existing.addEventListener('load', () => { jsReady = true; diag('Leaflet JS loaded (existing)'); maybeResolve(); });
          }
        });

  if (!document.getElementById('mapjs-loader')) {
          try {
            await ensureLeaflet();
          } catch (e) {
            console.warn('Leaflet failed to load', e);
          }
          // ensure the wrapper fills the map element
          if (!leafletContainer) {
            leafletContainer = document.createElement('div');
            leafletContainer.id = 'leaflet-wrapper';
            leafletContainer.style.position = 'absolute';
            leafletContainer.style.inset = '0px';
            leafletContainer.style.width = '100%';
            leafletContainer.style.height = '100%';
            leafletContainer.style.zIndex = '1';
            mapEl.appendChild(leafletContainer);
          }
          // ensure the parent map element has a concrete height (helps Leaflet)
          try {
            const currentHeight = renderer.domElement && renderer.domElement.clientHeight ? renderer.domElement.clientHeight : mapEl.clientHeight || 360;
            mapEl.style.minHeight = currentHeight + 'px';
          } catch (e) {}
          diag('Injecting map.js');
          const s = document.createElement('script');
          s.id = 'mapjs-loader';
          s.src = '/static/js/map.js';
          s.defer = true;
          document.body.appendChild(s);
          // after the script loads, forward selection and force Leaflet to reflow
          s.addEventListener('load', () => {
            diag('map.js loaded');
            try { if (window.__setSelectedFromExternal && selected && selected.lat) window.__setSelectedFromExternal(selected.lat, selected.lon); } catch (e) { diag('forward selection failed: '+e); }
            try { if (window.__leaflet_map && typeof window.__leaflet_map.invalidateSize === 'function') window.__leaflet_map.invalidateSize(); } catch (e) { diag('invalidateSize failed: '+e); }
            // call invalidateSize a couple more times with small delays to help
            // the browser layout stabilize and avoid tile 'squares' artifacts
            setTimeout(() => { try { if (window.__leaflet_map) window.__leaflet_map.invalidateSize(); window.dispatchEvent(new Event('resize')); } catch (e) { diag('invalidateSize delayed1 failed: '+e); } }, 120);
            setTimeout(() => { try { if (window.__leaflet_map) window.__leaflet_map.invalidateSize(); window.dispatchEvent(new Event('resize')); } catch (e) { diag('invalidateSize delayed2 failed: '+e); } }, 400);
            // ensure wrapper above canvas
            try { if (leafletContainer) { leafletContainer.style.zIndex = 20; leafletContainer.style.display = ''; } } catch(e){ diag('show wrapper failed: '+e); }
            try { renderer.domElement.style.zIndex = 0; renderer.domElement.style.display = 'none'; } catch(e){ diag('hide canvas failed: '+e); }
          });
        } else {
          // map.js already present; show existing wrapper and forward selection
          try { if (leafletContainer) { leafletContainer.style.display = ''; leafletContainer.style.zIndex = 20; } } catch (e) {}
          try { renderer.domElement.style.display = 'none'; renderer.domElement.style.zIndex = 0; } catch(e){}
          // If the underlying Leaflet instance was destroyed we need to reload map.js
          if (!window.__leaflet_map) {
            const s2 = document.createElement('script');
            s2.id = 'mapjs-loader';
            s2.src = '/static/js/map.js';
            s2.defer = true;
            document.body.appendChild(s2);
            s2.addEventListener('load', () => {
              try { if (window.__setSelectedFromExternal && selected && selected.lat) window.__setSelectedFromExternal(selected.lat, selected.lon); } catch (e) {}
              try { if (window.__leaflet_map && typeof window.__leaflet_map.invalidateSize === 'function') window.__leaflet_map.invalidateSize(); } catch (e) {}
            });
          } else {
            try { if (window.__setSelectedFromExternal && selected && selected.lat) window.__setSelectedFromExternal(selected.lat, selected.lon); } catch (e) {}
            try { if (window.__leaflet_map && typeof window.__leaflet_map.invalidateSize === 'function') window.__leaflet_map.invalidateSize(); } catch (e) {}
            setTimeout(() => { try { if (window.__leaflet_map) window.__leaflet_map.invalidateSize(); } catch (e) {} }, 120);
          }
        }
        toggleBtn.innerText = 'Use Globe';
        usingLeaflet = true;
      } catch (e) {
        console.warn('Failed to load leaflet map', e);
      }
    } else {
      // switch back to globe
      try {
        // show three.js canvas
        try { renderer.domElement.style.display = ''; renderer.domElement.style.zIndex = 10; } catch (e) {}
        // hide the leaflet wrapper instead of removing it so the map instance
        // remains available (prevents re-init issues when toggling back).
        try { if (leafletContainer) { leafletContainer.style.display = 'none'; leafletContainer.style.zIndex = 0; } } catch (e) {}
        // after hiding leaflet, ensure globe centers on shared selection
        try {
          if (window.sharedSelection && window.sharedSelection.lat && window.__setGlobeFromExternal) {
            window.__setGlobeFromExternal(window.sharedSelection.lat, window.sharedSelection.lon);
          }
        } catch (e) {}
        toggleBtn.innerText = 'Use Map';
        usingLeaflet = false;
      } catch (e) {
        console.warn('Failed to hide leaflet map', e);
      }
    }
  });
}

// Prediction UI wiring: send selected lat/lon to backend /predict and populate fields
try {
  const predictBtnEl = document.getElementById('predictBtn');
  const spinnerEl = document.getElementById('spinner');
  const predictionEl = document.getElementById('prediction');

  function populatePredictionFields(pred) {
    // minimal version of the helper in map.js
    if (typeof pred === 'string') {
      try { pred = JSON.parse(pred); } catch (e) { pred = null; }
    }
    const pick = (obj, keys) => { if (!obj) return null; for (const k of keys) if (k in obj && obj[k] != null) return obj[k]; return null; };
  const prcp = pick(pred, ['prcp', 'rain', 'precipitation_mm', 'precipitation', 'precip_mm']);
  const prcpProb = pick(pred, ['precipitation_probability', 'prcp_prob', 'prcp_prob_percent', 'precipitation_probability_percent']);
  const temp = pick(pred, ['temperature_c', 'temp', 'temperature', 't', 'air_temperature', 'model_output']);
  const radiation = pick(pred, ['radiation', 'shortwave_radiation_wm2', 'global_radiation']);
  const cloud = pick(pred, ['cloud', 'cloud_cover_percent', 'cloud_cover']);
    const fmt = v => {
      if (v == null) return 'N/A';
      if (typeof v === 'object') {
        if ('value' in v) return v.value;
        if ('probability' in v) return v.probability;
        return JSON.stringify(v);
      }
      return String(v);
    };
    const fmtWithUnit = (v, unit) => {
      const s = fmt(v);
      if (s === 'N/A') return s;
      return `${s} ${unit}`;
    };
  const predPrcpEl = document.getElementById('pred-prcp');
  const predPrcpProbEl = document.getElementById('pred-prcp-prob');
  const predTempEl = document.getElementById('pred-temp');
  const predRadiationEl = document.getElementById('pred-radiation');
  const predCloudEl = document.getElementById('pred-cloud');
  if (predPrcpEl) predPrcpEl.innerText = fmtWithUnit(prcp, 'mm');
  if (predPrcpProbEl) predPrcpProbEl.innerText = prcpProb == null ? 'N/A' : (parseFloat(prcpProb).toFixed(0) + ' %');
  if (predTempEl) predTempEl.innerText = fmtWithUnit(temp, '°C');
  if (predRadiationEl) predRadiationEl.innerText = fmtWithUnit(radiation, 'W/m²');
  if (predCloudEl) predCloudEl.innerText = fmtWithUnit(cloud, '%');
    if (predictionEl) predictionEl.innerText = '';
  }

  if (predictBtnEl) {
    predictBtnEl.addEventListener('click', async () => {
      if (!selected.lat) return;
      if (predictionEl) predictionEl.innerText = '';
      if (spinnerEl) spinnerEl.classList.remove('hidden');
      predictBtnEl.disabled = true;
      try {
          // include optional date/dayofyear from the date input if present
          const dateInput = document.getElementById('dateInput');
          const sel = (window.sharedSelection && window.sharedSelection.lat) ? window.sharedSelection : selected;
          const bodyObj = { lat: sel.lat, lon: sel.lon };
        if (dateInput && dateInput.value) {
          // combine selected date with current local time so backend picks the
          // hour nearest to when the user clicked 'CHECK WEATHER'
          const now = new Date();
          const timePart = now.toTimeString().split(' ')[0]; // HH:MM:SS
          const combined = `${dateInput.value}T${timePart}Z`;
          bodyObj.date = new Date(combined).toISOString();
        } else {
          // send full ISO datetime for 'now'
          bodyObj.date = new Date().toISOString();
        }
        const res = await fetch('/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyObj)
        });
        const json = await res.json();
        if (spinnerEl) spinnerEl.classList.add('hidden');
        predictBtnEl.disabled = false;
        if (!res.ok) {
          if (predictionEl) predictionEl.innerText = `Error ${res.status}: ${json.error || JSON.stringify(json)}`;
          return;
        }
        if (json.prediction) {
          populatePredictionFields(json.prediction);
        } else {
          populatePredictionFields(json);
        }
      } catch (err) {
        if (spinnerEl) spinnerEl.classList.add('hidden');
        predictBtnEl.disabled = false;
        if (predictionEl) predictionEl.innerText = 'Error: ' + err.message;
      }
    });
  }
} catch (e) {
  // non-fatal: ignore
}

// Fullscreen controls: add an enter/fullscreen button (bottom-right) and an exit button shown while fullscreen.
(function addFullscreenControls() {
  try {
    const fsEnter = document.createElement('button');
    const fsExit = document.createElement('button');

    // Simple SVG icons (expand / collapse) so there are no external deps
    fsEnter.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9V3h6" />
        <path d="M21 15v6h-6" />
        <path d="M21 3L14 10" />
        <path d="M3 21l7-7" />
      </svg>`;
    fsExit.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 3H3v6" />
        <path d="M15 21h6v-6" />
        <path d="M3 3l18 18" />
      </svg>`;

    fsEnter.title = 'Enter fullscreen';
    fsExit.title = 'Exit fullscreen';
    fsEnter.setAttribute('aria-label', 'Enter fullscreen');
    fsExit.setAttribute('aria-label', 'Exit fullscreen');

    const baseStyle = 'position:absolute;bottom:12px;right:12px;z-index:10000;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:8px;border:none;background:rgba(0,0,0,0.45);color:#00FFFF;cursor:pointer;padding:6px;';
    fsEnter.style.cssText = baseStyle;
    fsExit.style.cssText = baseStyle + 'display:none;';

    // Slight hover effect
    fsEnter.addEventListener('mouseenter', () => fsEnter.style.background = 'rgba(0,0,0,0.6)');
    fsEnter.addEventListener('mouseleave', () => fsEnter.style.background = 'rgba(0,0,0,0.45)');
    fsExit.addEventListener('mouseenter', () => fsExit.style.background = 'rgba(0,0,0,0.6)');
    fsExit.addEventListener('mouseleave', () => fsExit.style.background = 'rgba(0,0,0,0.45)');

    // Append to map element (mapEl is defined earlier and points to #map or document.body)
    if (mapEl && mapEl.appendChild) {
      mapEl.appendChild(fsEnter);
      mapEl.appendChild(fsExit);
    }

    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    }

    function enterFullscreen() {
      const el = mapEl || document.documentElement;
      if (el.requestFullscreen) return el.requestFullscreen();
      if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
      if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
      if (el.msRequestFullscreen) return el.msRequestFullscreen();
      return Promise.resolve();
    }

    function exitFullscreen() {
      if (document.exitFullscreen) return document.exitFullscreen();
      if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
      if (document.msExitFullscreen) return document.msExitFullscreen();
      return Promise.resolve();
    }

    fsEnter.addEventListener('click', () => {
      enterFullscreen().catch(() => {});
    });
    fsExit.addEventListener('click', () => {
      exitFullscreen().catch(() => {});
    });

    // Toggle button visibility and call the renderer resize helper when fullscreen changes
    function onFsChange() {
      const fs = isFullscreen();
      fsEnter.style.display = fs ? 'none' : 'flex';
      fsExit.style.display = fs ? 'flex' : 'none';
      // Allow the browser to finish the fullscreen layout before resizing renderer
      // Give a little more time to ensure exiting fullscreen layout is stable.
      setTimeout(() => {
        try { handleWindowResize(); } catch (e) { /* ignore */ }
      }, 150);
    }

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('mozfullscreenchange', onFsChange);
    document.addEventListener('MSFullscreenChange', onFsChange);

    // If the page starts in fullscreen for some reason, sync state
    if (isFullscreen()) onFsChange();
  } catch (e) {
    // Non-fatal; keep app working without fullscreen UI
    console.warn('Fullscreen controls not available', e);
  }
})();
