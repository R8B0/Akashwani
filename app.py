from flask import Flask, render_template, request, jsonify
from flask import send_from_directory
import joblib
import os
import numpy as np
import urllib.request
import urllib.parse
import json
from functools import lru_cache
from datetime import datetime
import base64
import os as _os

app = Flask(__name__)

# Path to your trained model. Replace with your actual path/filename.
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'model', 'tmax_2017.pkl')

# Model holder
model = None

def load_model():
    """Attempt to load the model from MODEL_PATH into the module-level `model`.
    Returns a tuple (success: bool, message: str).
    """
    global model
    try:
        # joblib will try to unpickle objects which may require scikit-learn to be
        # importable. If scikit-learn is not present, catch ImportError and
        # fall back to demo mode.
        try:
            import sklearn  # type: ignore
        except Exception:
            raise RuntimeError('scikit-learn is not installed; skipping model load')

        model = joblib.load(MODEL_PATH)
        msg = f'Loaded model from {MODEL_PATH} (type={type(model)})'
        print(msg)
        return True, msg
    except Exception as e:
        model = None
        msg = f'Could not load model: {e}'
        print('Warning:', msg)
        return False, msg

# Try loading at startup
load_model()

# -----------------------------------------------------------------------------
# Example (commented): how to add additional models
#
# If you later want to support separate models for weather (categorical) and
# humidity numeric prediction, place them in the `model/` folder and name them
# `weather.pkl` and `humidity.pkl`. The snippet below shows a non-invasive
# pattern to load multiple models into a dictionary and call them from
# `predict()`.
#
# MODEL_DIR = os.path.join(os.path.dirname(__file__), 'model')
# MODEL_FILES = {
#     'temperature': 'tmax_2017.pkl',   # already present in this repo
#     'weather': 'weather.pkl',         # new categorical model (e.g. predicts 'sunny')
#     'humidity': 'humidity.pkl',       # new numeric model for humidity
# }
# models = {}
#
# def load_models():
#     """Load multiple models into the `models` dict. Call at startup or on reload.
#     Wrap in try/except to allow partial availability during development.
#     """
#     global models
#     for key, fname in MODEL_FILES.items():
#         path = os.path.join(MODEL_DIR, fname)
#         try:
#             models[key] = joblib.load(path)
#             print(f'Loaded {key} model from {path}')
#         except Exception as exc:
#             models[key] = None
#             print(f'Warning: could not load {key} model ({path}): {exc}')
#
# # Example usage inside predict():
# # if models.get('temperature') is not None:
# #     t_pred = models['temperature'].predict(features_for_temp)
# # else:
# #     t_pred = demo_temp
# # if models.get('humidity') is not None:
# #     h_pred = models['humidity'].predict(features_for_humidity)
# # else:
# #     h_pred = demo_humidity
# # if models.get('weather') is not None:
# #     w_pred = models['weather'].predict(features_for_weather)
# # else:
# #     w_pred = demo_weather
#
# # and then assemble the final JSON response:
# # {
# #   'prediction': {
# #       'temperature_c': float(t_pred),
# #       'humidity': float(h_pred) if h_pred is not None else None,
# #       'weather': str(w_pred) if w_pred is not None else None,
# #   }
# # }
#
# # If your training pipelines required preprocessing (scalers, encoders), save
# # a complete sklearn Pipeline (e.g. `Pipeline([('scaler', scaler), ('clf', clf)])`)
# # and pickle that. Then the web app only needs to call `pipeline.predict(X)`.
# -----------------------------------------------------------------------------


@app.route('/')
def index():
    return render_template('index.html')


# Serve geojson files located in the repo-level 'geojson' folder
@app.route('/geojson/<path:filename>')
def geojson_files(filename):
    base = os.path.join(os.path.dirname(__file__), 'geojson')
    return send_from_directory(base, filename)


# Reverse geocode proxy to OpenStreetMap Nominatim
# This endpoint accepts GET params: lat, lon
# It sets a User-Agent to comply with Nominatim usage policy and caches results locally.
@app.route('/reverse_geocode')
def reverse_geocode_proxy():
    lat = request.args.get('lat')
    lon = request.args.get('lon')
    if not lat or not lon:
        return jsonify({'error': 'Missing lat or lon'}), 400

    try:
        data = _reverse_geocode_cached(lat, lon)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@lru_cache(maxsize=1024)
def _reverse_geocode_cached(lat, lon):
    # Build Nominatim URL
    params = {
        'format': 'json',
        'lat': str(lat),
        'lon': str(lon),
        'zoom': '10',
        'addressdetails': '1'
    }
    url = 'https://nominatim.openstreetmap.org/reverse?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'sample_app/1.0 (your-email@example.com)'
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read()
        return json.loads(raw.decode('utf-8'))


@app.route('/predict', methods=['POST'])
def predict():
    """Expect JSON: {"lat": <float>, "lon": <float>} Returns JSON prediction."""
    data = request.get_json() or {}
    lat = data.get('lat')
    lon = data.get('lon')
    if lat is None or lon is None:
        return jsonify({'error': 'Missing lat and/or lon in request body'}), 400

    # validate and coerce to float
    try:
        lat = float(lat)
        lon = float(lon)
    except Exception:
        return jsonify({'error': 'lat and lon must be numeric'}), 400

    # Build feature vector to match model input. If the loaded model has
    # `feature_names_in_` or `n_features_in_`, use that order. Support a
    # 'dayofyear' feature (accepted from client as either 'dayofyear' or 'date').
    features = None
    if model is not None and hasattr(model, 'n_features_in_'):
        fnames = getattr(model, 'feature_names_in_', None)
        if fnames is None:
            # fallback: assume numeric count and try ['lat','lon',...]
            n = int(getattr(model, 'n_features_in_', 2))
            # default to lat, lon, dayofyear ordering if n==3
            if n == 3:
                fnames = ['lat', 'lon', 'dayofyear']
            else:
                # build simple numeric list of expected names
                fnames = ['lat', 'lon'] + [f'x{i}' for i in range(3, n+1)]
        # fill values according to fnames
        vals = []
        for name in fnames:
            if name.lower() == 'lat':
                vals.append(lat)
            elif name.lower() == 'lon':
                vals.append(lon)
            elif name.lower() == 'dayofyear':
                # Accept dayofyear directly or a date string from client
                doy = data.get('dayofyear')
                if doy is None:
                    date_s = data.get('date')
                    if date_s:
                        try:
                            # attempt to parse YYYY-MM-DD or full ISO
                            from datetime import datetime
                            dt = datetime.fromisoformat(date_s)
                            doy = int(dt.timetuple().tm_yday)
                        except Exception:
                            doy = None
                try:
                    vals.append(float(doy) if doy is not None else float(1))
                except Exception:
                    vals.append(float(1))
            else:
                # unknown feature: try to read from data or use zero
                v = data.get(name, data.get(name.lower(), 0))
                try:
                    vals.append(float(v))
                except Exception:
                    vals.append(0.0)
        features = np.array([vals])
    else:
        # No model metadata; use the simplest form [lat, lon]
        features = np.array([[lat, lon]])
    # If Meteomatics credentials are present, prefer the live API first even
    # when a local model is available. If the API call fails or returns no
    # useful data, fall back to the local model (if present) or to demo values.
    METEO_USER = _os.environ.get('METEOMATICS_USER')
    METEO_PASS = _os.environ.get('METEOMATICS_PASS')
    if METEO_USER and METEO_PASS:
        try:
            meteodata = _fetch_meteomatics(lat, lon, data_date=data.get('date'))
            # Accept only if we received a numeric temperature value
            if meteodata and meteodata.get('temperature_c') is not None:
                pred = {
                    'temperature_c': meteodata.get('temperature_c'),
                    'humidity': meteodata.get('humidity_percent'),
                    'prcp': meteodata.get('precipitation_mm'),
                    'precipitation_probability': meteodata.get('precipitation_probability'),
                    'radiation': meteodata.get('shortwave_radiation_wm2'),
                    'cloud': meteodata.get('cloud_cover_percent'),
                }
                return jsonify({'prediction': pred, 'source': 'meteomatics'})
        except Exception as e:
            # Log and continue to model/demo fallback
            print('Meteomatics fetch failed:', e)

    # If Meteomatics was not used or failed, try Open-Meteo (no API key required)
    try:
        openm = _fetch_open_meteo(lat, lon, data_date=data.get('date'))
        if openm and openm.get('temperature_c') is not None:
            pred = {
                'temperature_c': openm.get('temperature_c'),
                'humidity': openm.get('humidity_percent'),
                'prcp': openm.get('precipitation_mm'),
                'precipitation_probability': openm.get('precipitation_probability'),
                'radiation': openm.get('shortwave_radiation_wm2'),
                'cloud': openm.get('cloud_cover_percent'),
            }
            return jsonify({'prediction': pred, 'source': 'open-meteo'})
    except Exception as e:
        print('Open-Meteo fetch failed:', e)

    # If we reach here and a model is not loaded, return a demo prediction.
    if model is None:
        pred = {
            'temperature_c': round(25.0 + (lat % 5) - (lon % 3), 2),
            'weather': 'sunny',
            'humidity': round(50 + ((lat + lon) % 10), 1)
        }
        return jsonify({
            'prediction': pred,
            'warning': 'No trained model loaded; returning demo prediction.'
        })

    try:
        y = model.predict(features)
        # Normalize prediction to JSON serializable form
        if hasattr(y, '__iter__') and not isinstance(y, (float, int)):
            try:
                out = y.tolist()
            except Exception:
                out = [float(v) for v in y]
            # If single-row prediction, unpack first row
            if len(out) == 1:
                out = out[0]
        else:
            out = float(y)

        # Map model output to a friendly label. If the model returns an array,
        # take the first element as the temperature value.
        try:
            if isinstance(out, (list, tuple)):
                temp_val = float(out[0]) if len(out) > 0 else float(out)
            else:
                temp_val = float(out)
            prediction = {'temperature_c': round(temp_val, 3)}
            # If the model provided humidity or weather in other outputs, map them here.
            # For now set humidity to None to indicate not available from this model.
            prediction.setdefault('humidity', None)
            prediction.setdefault('weather', None)
        except Exception:
            # Fallback: return raw model output under a generic key
            prediction = {'model_output': out}

        return jsonify({'prediction': prediction})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _fetch_meteomatics(lat, lon, data_date=None):
    """Query Meteomatics API for temperature_2m:C and relative_humidity_2m:%
    Returns a simple dict {'temperature_c': float, 'humidity_percent': float}
    Requires METEOMATICS_USER and METEOMATICS_PASS env vars set.
    """
    # import requests locally to avoid hard dependency at module import time
    try:
        import requests
    except Exception:
        raise RuntimeError('The `requests` package is required to call Meteomatics. Install it or unset METEOMATICS_* env vars')

    user = _os.environ.get('METEOMATICS_USER')
    passwd = _os.environ.get('METEOMATICS_PASS')
    if not user or not passwd:
        raise RuntimeError('Meteomatics credentials not configured')

    # Meteomatics expects ISO8601 timestamp. Use requested date or now.
    if data_date:
        try:
            # Accept either full ISO or date-only (YYYY-MM-DD). If date-only,
            # interpret as midday UTC to pick a representative hourly value.
            if len(data_date.strip()) == 10 and data_date.count('-') == 2:
                dt = datetime.fromisoformat(data_date + 'T12:00:00+00:00')
            else:
                dt = datetime.fromisoformat(data_date)
        except Exception:
            dt = datetime.utcnow()
    else:
        dt = datetime.utcnow()
    timestr = dt.strftime('%Y-%m-%dT%H:%M:%SZ')

    # Try a few common parameter name combinations. Meteomatics parameter
    # identifiers vary by account/model mix; if the first attempt returns a
    # 404 for unavailable parameters, try alternatives.
    param_candidates = [
        ['temperature_2m:C', 'relative_humidity_2m:pct'],
        ['t_2m:C', 'relative_humidity_2m:pct'],
        ['temperature_2m:C', 'rh_2m:pct'],
        ['t_2m:C', 'rh_2m:pct'],
    ]

    last_error = None
    j = None
    for params_list in param_candidates:
        params = ','.join(params_list)
        url = f'https://api.meteomatics.com/{timestr}/{params}/{lat},{lon}/json'
        try:
            resp = requests.get(url, auth=(user, passwd), timeout=12)
        except Exception as ex:
            last_error = f'Network error requesting Meteomatics: {ex}'
            continue
        if resp.status_code == 200:
            try:
                j = resp.json()
            except Exception as ex:
                last_error = f'Invalid JSON from Meteomatics: {ex} '
                j = None
            break
        else:
            # Capture the response body/message to surface later
            last_error = f'Meteomatics HTTP {resp.status_code}: {resp.text[:400]}'
            # try next candidate
            continue

    if j is None:
        raise RuntimeError(last_error or 'No response from Meteomatics')
    # The structure contains 'data' -> list of variables each with 'coordinates'
    out = { 'temperature_c': None, 'humidity_percent': None, 'weather': None,
        'precipitation_mm': None, 'shortwave_radiation_wm2': None, 'cloud_cover_percent': None }
    try:
        for item in j.get('data', []):
            param_name = item.get('parameter', '') or item.get('variable', '')
            for coord in item.get('coordinates', []):
                for val in coord.get('dates', []):
                    v = val.get('value')
                    if v is None:
                        continue
                    # match a few possible parameter identifiers
                    pname = param_name.lower()
                    if 'temp' in pname or 't_2m' in pname or 'temperature_2m' in pname:
                        out['temperature_c'] = float(v)
                    if 'humid' in pname or 'relative_humidity' in pname or 'rh_2m' in pname:
                        out['humidity_percent'] = float(v)
                    if 'precip' in pname or 'precipitation' in pname or 'rain' in pname:
                        # precipitation often returned in mm
                        out['precipitation_mm'] = float(v)
                    if 'shortwave' in pname or 'radiation' in pname or 'global_radiation' in pname:
                        out['shortwave_radiation_wm2'] = float(v)
                    if 'cloud' in pname or 'cloud_cover' in pname:
                        out['cloud_cover_percent'] = float(v)
    except Exception:
        pass

    # Derive a simple weather string from temp/humidity (naive)
    try:
        t = out.get('temperature_c')
        h = out.get('humidity_percent')
        if t is not None and h is not None:
            if h > 80:
                out['weather'] = 'humid'
            elif t > 30:
                out['weather'] = 'hot'
            else:
                out['weather'] = 'moderate'
    except Exception:
        out['weather'] = None

    return out


def _fetch_open_meteo(lat, lon, data_date=None):
    """Query Open-Meteo (free, no-auth) for several hourly fields.
    Returns a dict with keys (temperature_c, humidity_percent, precipitation_mm,
    shortwave_radiation_wm2, cloud_cover_percent, weather) or None on failure.
    """
    try:
        import requests
    except Exception:
        return None

    # Determine date to query (Open-Meteo uses start_date/end_date in YYYY-MM-DD)
    try:
        if data_date:
            dt = datetime.fromisoformat(data_date.replace('Z', '+00:00'))
        else:
            dt = datetime.utcnow()
    except Exception:
        dt = datetime.utcnow()

    date_str = dt.strftime('%Y-%m-%d')
    # Request hourly fields for the date; timezone UTC for predictable indexing
    # include precipitation, shortwave_radiation and cloudcover
    url = (
        f'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}'
        f'&hourly=temperature_2m,relativehumidity_2m,precipitation,precipitation_probability,shortwave_radiation,cloudcover&start_date={date_str}&end_date={date_str}&timezone=UTC'
    )

    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code != 200:
            return None
        j = resp.json()
        hourly = j.get('hourly', {})

        temps = hourly.get('temperature_2m', [])
        hums = hourly.get('relativehumidity_2m', [])
        precs = hourly.get('precipitation', [])
        swr = hourly.get('shortwave_radiation', [])
        clouds = hourly.get('cloudcover', [])
        times = hourly.get('time', [])

        if not times:
            return None

        # Find nearest hour index to requested dt
        # times are strings like '2025-10-05T14:00'
        # Build datetime list and pick nearest
        from datetime import datetime as _dt
        dt_list = []
        for t in times:
            try:
                # open-meteo times may not include timezone; assume UTC
                dt_list.append(_dt.fromisoformat(t))
            except Exception:
                dt_list.append(None)

        best_idx = 0
        best_diff = None
        for i, t in enumerate(dt_list):
            if t is None:
                continue
            diff = abs((t - dt.replace(tzinfo=None)).total_seconds())
            if best_diff is None or diff < best_diff:
                best_diff = diff
                best_idx = i

        temp = float(temps[best_idx]) if best_idx < len(temps) and temps[best_idx] is not None else None
        hum = float(hums[best_idx]) if best_idx < len(hums) and hums[best_idx] is not None else None
        prec = float(precs[best_idx]) if best_idx < len(precs) and precs[best_idx] is not None else None
        pp = None
        try:
            pparr = hourly.get('precipitation_probability', [])
            if best_idx < len(pparr) and pparr[best_idx] is not None:
                pp = float(pparr[best_idx])
        except Exception:
            pp = None
        # If precipitation_probability is not provided, derive a simple proxy
        # by checking a small window of nearby hours for non-zero precipitation.
        if pp is None:
            try:
                window = 3
                start = max(0, best_idx - window)
                end = min(len(precs), best_idx + window + 1)
                count = 0
                total = 0
                for i in range(start, end):
                    total += 1
                    if i < len(precs) and precs[i] is not None and float(precs[i]) > 0.0:
                        count += 1
                if total > 0:
                    pp = round((count / total) * 100.0, 1)
                else:
                    pp = None
            except Exception:
                pp = None
        sw = float(swr[best_idx]) if best_idx < len(swr) and swr[best_idx] is not None else None
        cl = float(clouds[best_idx]) if best_idx < len(clouds) and clouds[best_idx] is not None else None

        # Derive a simple weather string from temp/humidity (naive)
        weather = None
        try:
            if hum is not None and temp is not None:
                if hum > 80:
                    weather = 'humid'
                elif temp > 30:
                    weather = 'hot'
                else:
                    weather = 'moderate'
        except Exception:
            weather = None

        return {
            'temperature_c': temp,
            'humidity_percent': hum,
            'precipitation_mm': prec,
            'precipitation_probability': pp,
            'shortwave_radiation_wm2': sw,
            'cloud_cover_percent': cl,
            'weather': weather
        }
    except Exception:
        return None


@app.route('/reload_model', methods=['POST'])
def reload_model():
    """Reload the model from disk. Useful during development."""
    success, msg = load_model()
    return jsonify({'success': success, 'message': msg})


@app.route('/model_info')
def model_info():
    """Return basic info about the currently loaded model."""
    if model is None:
        return jsonify({'loaded': False, 'message': 'No model loaded'})
    return jsonify({'loaded': True, 'type': str(type(model))})


@app.route('/meteomatics_probe', methods=['POST'])
def meteomatics_probe():
    """Probe Meteomatics for supported parameter names.
    POST JSON: {"params": ["temperature_2m:C","relative_humidity_2m:pct", ...]}
    Returns per-parameter status (200 OK or error message). Requires credentials.
    """
    body = request.get_json() or {}
    params_list = body.get('params')
    # default candidates to test if none provided
    if not params_list:
        params_list = [
            'temperature_2m:C', 't_2m:C',
            'relative_humidity_2m:pct', 'rh_2m:pct',
            'precipitation_1h:mm', 'precipitation:mm', 'precipitation_total:mm',
            'shortwave_radiation_surface:W/m2', 'global_radiation:W/m2', 'shortwave_radiation:W/m2',
            'cloud_cover_total:pct', 'cloud_cover:pct'
        ]

    user = _os.environ.get('METEOMATICS_USER')
    passwd = _os.environ.get('METEOMATICS_PASS')
    if not user or not passwd:
        return jsonify({'error': 'Meteomatics credentials not configured in environment'}), 403

    lat = body.get('lat') or 0.0
    lon = body.get('lon') or 0.0
    date = body.get('date')
    if not date:
        date = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

    results = {}
    import requests
    for p in params_list:
        try:
            url = f'https://api.meteomatics.com/{date}/{p}/{lat},{lon}/json'
            resp = requests.get(url, auth=(user, passwd), timeout=10)
            if resp.status_code == 200:
                results[p] = {'ok': True}
            else:
                # include a short message from the provider
                results[p] = {'ok': False, 'status': resp.status_code, 'text': resp.text[:400]}
        except Exception as ex:
            results[p] = {'ok': False, 'error': str(ex)}

    return jsonify({'results': results})


if __name__ == '__main__':
    app.run(debug=True)
