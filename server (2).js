// SafeTrack server. Run: node server.js
// Keep this file next to index.html. No npm install is needed.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = __dirname;

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function save(file, value) {
  fs.writeFile(
    path.join(DATA_DIR, file),
    JSON.stringify(value, null, 2),
    err => {
      if (err) console.error('Could not save ' + file + ':', err.message);
    }
  );
}

let history = load('history.json', []);
let alerts = load('alerts.json', []);
let config = load('config.json', { zones: [], route: [], lim: 40, dev: 50 });
let latest = history.length ? history[history.length - 1] : null;

function send(res, status, data, contentType = 'application/json') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(
    typeof data === 'string' || Buffer.isBuffer(data)
      ? data
      : JSON.stringify(data)
  );
}

function readBody(req, res, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 200000) {
      send(res, 413, 'request body too large', 'text/plain');
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      callback(JSON.parse(body || '{}'));
    } catch {
      callback(null);
    }
  });
}

const server = http.createServer((req, res) => {
  // Browser preflight for requests from GitHub Pages / another origin.
  if (req.method === 'OPTIONS') return send(res, 204, '');

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, 'bad request', 'text/plain');
  }

  // Dashboard HTML served by this server.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return fs.readFile(path.join(DATA_DIR, 'index.html'), (err, html) => {
      if (err) {
        return send(
          res,
          404,
          'index.html must be in the same folder as server.js',
          'text/plain'
        );
      }
      send(res, 200, html, 'text/html; charset=utf-8');
    });
  }

  // Optional health check.
  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      service: 'SafeTrack',
      hasTelemetry: !!latest,
      lastTelemetryAt: latest && latest.t ? latest.t : null
    });
  }

  // Telemetry posted by the LILYGO browser serial connection.
  if (req.method === 'POST' && pathname === '/api/telemetry') {
    return readBody(req, res, data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return send(res, 400, 'invalid JSON object', 'text/plain');
      }

      const lat = data.lat == null ? null : Number(data.lat);
      const lon = data.lon == null ? null : Number(data.lon);

      // Reject malformed coordinates when a GPS fix is claimed.
      if (Number(data.fix) === 1 &&
          (!Number.isFinite(lat) || !Number.isFinite(lon) ||
           lat < -90 || lat > 90 || lon < -180 || lon > 180)) {
        return send(res, 400, 'invalid GPS coordinates', 'text/plain');
      }

      const item = {
        ...data,
        t: Date.now()
      };

      latest = item;
      history.push(item);
      if (history.length > 5000) history = history.slice(-5000);
      save('history.json', history);

      console.log(new Date().toLocaleTimeString(), 'telemetry:', JSON.stringify(item));
      send(res, 200, { ok: true, t: item.t });
    });
  }

  // Latest position and historical locations.
  if (req.method === 'GET' && pathname === '/api/live') {
    return send(res, 200, latest || {});
  }
  if (req.method === 'GET' && pathname === '/api/history') {
    return send(res, 200, history);
  }

  // Shared geofence configuration, planned route, and limits.
  if (pathname === '/api/config') {
    if (req.method === 'GET') return send(res, 200, config);
    if (req.method === 'POST') {
      return readBody(req, res, data => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return send(res, 400, 'invalid configuration', 'text/plain');
        }
        config = data;
        save('config.json', config);
        send(res, 200, config);
      });
    }
  }

  // Alerts.
  if (req.method === 'GET' && pathname === '/api/alerts') {
    return send(res, 200, alerts);
  }

  if (req.method === 'POST' && pathname === '/api/alerts/ack') {
    alerts.forEach(alert => { alert.ack = true; });
    save('alerts.json', alerts);
    return send(res, 200, 'ok', 'text/plain');
  }

  if (req.method === 'POST' && pathname === '/api/alerts') {
    return readBody(req, res, data => {
      if (!data || typeof data !== 'object') {
        return send(res, 400, 'invalid alert', 'text/plain');
      }
      alerts.unshift({
        type: String(data.type || 'info').slice(0, 30),
        text: String(data.text || '').slice(0, 300),
        t: Number(data.t) || Date.now(),
        ack: data.type === 'info'
      });
      alerts = alerts.slice(0, 300);
      save('alerts.json', alerts);
      send(res, 200, 'ok', 'text/plain');
    });
  }

  send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SafeTrack server running on http://localhost:' + PORT);
});
