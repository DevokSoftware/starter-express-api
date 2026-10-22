const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../index");
const fixture = require("./fixtures/espn-2026.json");

async function serve(t, options) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the website receives 2026 standings with its original team IDs", async (t) => {
  const saved = [];
  const pool = { async query(sql, params) {
    if (sql.startsWith("SELECT")) {
      assert.deepEqual(params, ["espn", "2026"]);
      return { rows: [] };
    }
    saved.push(JSON.parse(params[0]));
    return { rows: [] };
  } };
  const url = await serve(t, { pool, fetchJson: async () => fixture });
  const res = await fetch(`${url}/standings?season=2026`, {
    headers: { Origin: "https://draft-bola-ao-ar.onrender.com" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://draft-bola-ao-ar.onrender.com");
  const data = await res.json();
  const websiteTeams = data.response.filter((entry) => Number(entry.season) === 2026);
  assert.equal(websiteTeams.length, 30);
  assert.equal(websiteTeams.find((entry) => entry.team.id === 10).win.total, 1);
  assert.equal(typeof data.lastUpdate, "string");
  assert.equal(saved.length, 1);
});

test("rejects malformed seasons before touching the database", async (t) => {
  const pool = { async query() { assert.fail("Database must not be called"); } };
  const url = await serve(t, { pool });
  for (const query of ["season=bad", "season=2026&season=2025", "season[year]=2026"]) {
    const res = await fetch(`${url}/standings?${query}`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /season/i);
  }
});

test("returns an error rather than fabricated zero wins when ESPN fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const pool = { async query() { return { rows: [] }; } };
  const url = await serve(t, { pool, fetchJson: async () => { throw new Error("ESPN unavailable"); } });
  const res = await fetch(`${url}/standings`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Failed to fetch standings" });
});
