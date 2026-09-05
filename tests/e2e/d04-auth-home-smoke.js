/**
 * D04 minimal live E2E: local homepage over HTTP + isolated-test authentication.
 *
 * The script starts an ephemeral localhost server, serves the real index.html,
 * signs in with the existing D02 test account, verifies the authenticated user,
 * signs out, and closes the local server. It never falls back to another env.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  validateTestBoundary,
} = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const results = [];

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

function startHomepageServer() {
  const index = fs.readFileSync(path.join(root, 'index.html'));
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(index);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function main() {
  const boundary = validateTestBoundary();
  const markerCount = assertD02FixtureMarker(boundary);
  const apiOrigin = boundary.apiOrigin;
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const email = required('SAFETY_TEST_ADMIN_EMAIL');
  const password = required('SAFETY_TEST_ADMIN_PASSWORD');
  let server;
  let accessToken;

  console.log(`D04_TEST_GATE=PASS; d02_fixture_markers=${markerCount}`);
  try {
    server = await startHomepageServer();
    const address = server.address();
    const homepage = await fetch(`http://127.0.0.1:${address.port}/`, {
      signal: AbortSignal.timeout(5000),
    });
    const html = await homepage.text();
    const homepageOk = homepage.status === 200
      && html.includes('<div id="app">')
      && html.includes('js/auth.js')
      && html.includes('js/app.js');
    record('D04-E2E-01', homepageOk,
      `local homepage HTTP ${homepage.status}; app/auth entries ${homepageOk ? 'present' : 'missing'}`);

    const login = await fetch(`${apiOrigin}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
    const loginBody = await login.json().catch(() => ({}));
    accessToken = loginBody.access_token;
    const loginOk = login.status === 200 && Boolean(accessToken) && Boolean(loginBody.user?.id);
    record('D04-E2E-02', loginOk,
      `isolated auth login HTTP ${login.status}; token ${loginOk ? 'issued' : 'not issued'}`);

    let userOk = false;
    if (loginOk) {
      const currentUser = await fetch(`${apiOrigin}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      const userBody = await currentUser.json().catch(() => ({}));
      userOk = currentUser.status === 200 && userBody.id === loginBody.user.id;
      record('D04-E2E-03', userOk,
        `authenticated user HTTP ${currentUser.status}; identity ${userOk ? 'matched' : 'mismatched'}`);
    } else {
      record('D04-E2E-03', false, 'authenticated user check skipped because login failed');
    }

    if (accessToken) {
      const logout = await fetch(`${apiOrigin}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      record('D04-E2E-04', logout.status === 204,
        `isolated auth logout HTTP ${logout.status}`);
    } else {
      record('D04-E2E-04', false, 'logout skipped because login failed');
    }
  } finally {
    if (server?.listening) await closeServer(server);
  }

  const failed = results.filter(item => !item.pass);
  console.log(`RESULT ${results.length - failed.length}/${results.length} passed; local server closed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => {
  console.error(`D04 live E2E stopped: ${error.message}`);
  process.exitCode = 2;
});
