const { test } = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/espn-2026.json");
const legacyStandings = require("../standings.json");
const {
  parseSeason,
  normalizeStandings,
  createStandingsService,
} = require("../standings");

const now = new Date("2026-10-22T12:00:00Z");

test("preserves the website's team IDs and reads ESPN's named win totals", () => {
  const result = normalizeStandings(fixture, 2026, now);
  assert.equal(result.parameters.season, "2026");
  assert.equal(result.source, "espn");
  assert.equal(result.results, 30);
  assert.equal(new Set(result.response.map((entry) => entry.team.id)).size, 30);
  for (const entry of result.response) {
    const legacy = legacyStandings.response.find((old) => old.team.code === entry.team.code);
    assert.equal(entry.team.id, legacy.team.id, `Incorrect website ID for ${entry.team.name}`);
  }
  const detroit = result.response.find((entry) => entry.team.id === 10);
  assert.equal(detroit.team.name, "Detroit Pistons");
  assert.equal(detroit.win.total, 1);
  assert.equal(detroit.loss.total, 0);
  const okc = result.response.find((entry) => entry.team.id === 25);
  assert.equal(okc.win.total, 1);
  const boston = result.response.find((entry) => entry.team.id === 2);
  assert.equal(boston.win.total, 0);
  assert.equal(boston.loss.total, 1);
  assert.equal(result.lastUpdate, "22-10-2026 13:00:00");
});

test("rejects the wrong season, preseason, incomplete data and missing win totals", () => {
  assert.throws(() => normalizeStandings(fixture, 2025, now), /season/i);
  const preseason = structuredClone(fixture);
  preseason.children[0].standings.seasonType = 1;
  assert.throws(() => normalizeStandings(preseason, 2026, now), /regular season/i);
  const incomplete = structuredClone(fixture);
  incomplete.children[0].standings.entries.pop();
  assert.throws(() => normalizeStandings(incomplete, 2026, now), /30 teams/i);
  const missingWins = structuredClone(fixture);
  missingWins.children[0].standings.entries[0].stats =
    missingWins.children[0].standings.entries[0].stats.filter((s) => s.name !== "wins");
  assert.throws(() => normalizeStandings(missingWins, 2026, now), /wins/i);
  const duplicate = structuredClone(fixture);
  duplicate.children[0].standings.entries[1] = duplicate.children[0].standings.entries[0];
  assert.throws(() => normalizeStandings(duplicate, 2026, now), /30 teams/i);
});

test("requests historical seasons using the same starting-year contract", async () => {
  const historical = structuredClone(fixture);
  historical.season.year = 2026;
  for (const conference of historical.children) conference.standings.season = 2026;
  const pool = { async query(sql, params) {
    if (sql.startsWith("SELECT")) assert.deepEqual(params, ["espn", "2025"]);
    return { rows: [] };
  } };
  const getStandings = createStandingsService({ pool, now: () => now,
    fetchJson: async (url) => {
      assert.equal(new URL(url).searchParams.get("season"), "2026");
      return historical;
    },
  });
  const result = await getStandings(2025);
  assert.equal(result.parameters.season, "2025");
  assert.ok(result.response.every((entry) => entry.season === 2025));
});

test("accepts a season start year and rejects invalid query parameters", () => {
  assert.equal(parseSeason(undefined), 2026);
  assert.equal(parseSeason("2026"), 2026);
  assert.equal(parseSeason("2025"), 2025);
  for (const invalid of ["", "2026abc", "2026.5", ["2026"], "1900"]) {
    assert.throws(() => parseSeason(invalid), /season/i);
  }
});

function database(rows = []) {
  const saved = [];
  return {
    saved,
    async query(sql, params) {
      if (sql.startsWith("SELECT")) {
        // These predicates prevent another provider or season from satisfying this request.
        assert.match(sql, /data\s*->>\s*'source'/);
        assert.match(sql, /data\s*->\s*'parameters'\s*->>\s*'season'/);
        assert.deepEqual(params, ["espn", "2026"]);
        return { rows: rows.filter((row) => row.data.source === params[0] &&
          row.data.parameters.season === params[1]).slice(-1) };
      }
      assert.match(sql, /^INSERT INTO standings/);
      saved.push(JSON.parse(params[0]));
      return { rows: [] };
    },
  };
}

test("bypasses RapidAPI and other-season cache entries and requests ESPN's ending year", async () => {
  const pool = database([
    { data: { parameters: { season: "2026" } }, last_updated: now },
    { data: { source: "espn", parameters: { season: "2025" } }, last_updated: now },
  ]);
  const getStandings = createStandingsService({ pool, now: () => now,
    fetchJson: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "site.api.espn.com");
      assert.equal(parsed.searchParams.get("season"), "2027");
      assert.equal(parsed.searchParams.get("seasontype"), "2");
      return fixture;
    },
  });
  const result = await getStandings(2026);
  assert.equal(result.results, 30);
  assert.equal(pool.saved.length, 1);
  assert.deepEqual(pool.saved[0], result);
});

test("uses fresh ESPN cache without making another upstream request", async () => {
  const cached = normalizeStandings(fixture, 2026, now);
  const pool = database([{ data: cached, last_updated: now }]);
  const getStandings = createStandingsService({ pool, now: () => now,
    fetchJson: async () => { throw new Error("Unexpected upstream request"); },
  });
  assert.deepEqual(await getStandings(2026), cached);
  assert.equal(pool.saved.length, 0);
});

test("refreshes an hour-old cache and does not cache upstream failures or invalid data", async () => {
  const cached = normalizeStandings(fixture, 2026, now);
  const pool = database([{ data: cached, last_updated: new Date("2026-10-22T11:00:00Z") }]);
  let calls = 0;
  const getStandings = createStandingsService({ pool, now: () => now,
    fetchJson: async () => { calls++; return fixture; },
  });
  await getStandings(2026);
  assert.equal(calls, 1);
  assert.equal(pool.saved.length, 1);

  const emptyPool = database();
  for (const fetchJson of [
    async () => { throw new Error("ESPN unavailable"); },
    async () => ({ ...fixture, children: [] }),
  ]) {
    const failing = createStandingsService({ pool: emptyPool, now: () => now, fetchJson });
    await assert.rejects(failing(2026));
  }
  assert.equal(emptyPool.saved.length, 0);
});
