const https = require("node:https");

// ESPN IDs differ from the IDs already stored in the website's season picks.
const teams = {
  1: [1, "ATL"], 2: [2, "BOS"], 3: [23, "NOP"], 4: [6, "CHI"],
  5: [7, "CLE"], 6: [8, "DAL"], 7: [9, "DEN"], 8: [10, "DET"],
  9: [11, "GSW"], 10: [14, "HOU"], 11: [15, "IND"], 12: [16, "LAC"],
  13: [17, "LAL"], 14: [20, "MIA"], 15: [21, "MIL"], 16: [22, "MIN"],
  17: [4, "BKN"], 18: [24, "NYK"], 19: [26, "ORL"], 20: [27, "PHI"],
  21: [28, "PHX"], 22: [29, "POR"], 23: [30, "SAC"], 24: [31, "SAS"],
  25: [25, "OKC"], 26: [40, "UTA"], 27: [41, "WAS"], 28: [38, "TOR"],
  29: [19, "MEM"], 30: [5, "CHA"],
};

function parseSeason(value) {
  if (value === undefined) return 2026;
  if (typeof value !== "string" || !/^\d{4}$/.test(value) || Number(value) < 1946) {
    throw new Error("season must be a four-digit season start year (for example, 2026)");
  }
  return Number(value);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`ESPN returned HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("ESPN returned invalid JSON"));
        }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("ESPN request timed out")));
    request.on("error", reject);
  });
}

function lastUpdate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function record(stats, name) {
  const match = /^(\d+)-(\d+)$/.exec(stats[name]?.summary || stats[name]?.displayValue || "");
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
}

function normalizeStandings(data, season, now = new Date()) {
  // ESPN names seasons by their ending year; our website uses the starting year.
  if (data?.season?.year !== season + 1) {
    throw new Error("ESPN returned standings for a different season");
  }
  const response = (data.children || []).flatMap((conference) => {
    const standings = conference.standings;
    if (standings?.season !== season + 1 || standings.seasonType !== 2) {
      throw new Error("ESPN did not return the requested regular season");
    }
    return (standings.entries || []).map((entry) => {
      const mapping = teams[entry.team.id];
      if (!mapping) throw new Error(`Unknown ESPN team ID: ${entry.team.id}`);
      const stats = Object.fromEntries(entry.stats.map((stat) => [stat.name, stat]));
      const wins = stats.wins?.value;
      const losses = stats.losses?.value;
      if (!Number.isInteger(wins) || wins < 0 || !Number.isInteger(losses) || losses < 0) {
        throw new Error(`ESPN returned invalid wins or losses for ${entry.team.displayName}`);
      }
      const home = record(stats, "Home");
      const away = record(stats, "Road");
      const lastTen = record(stats, "Last Ten Games");
      const games = wins + losses;
      const streak = stats.streak?.value;
      return {
        league: "standard",
        season,
        team: {
          id: mapping[0], name: entry.team.displayName, nickname: entry.team.name,
          code: mapping[1], logo: entry.team.logos?.[0]?.href || null,
        },
        conference: {
          name: conference.abbreviation.toLowerCase(), rank: stats.playoffSeed?.value ?? null,
          win: wins, loss: losses,
        },
        win: {
          home: home[0], away: away[0], total: wins,
          percentage: (games ? wins / games : 0).toFixed(3), lastTen: lastTen[0],
        },
        loss: {
          home: home[1], away: away[1], total: losses,
          percentage: (games ? losses / games : 0).toFixed(3), lastTen: lastTen[1],
        },
        gamesBehind: stats.gamesBehind?.value ?? null,
        streak: typeof streak === "number" ? Math.abs(streak) : null,
        winStreak: typeof streak === "number" ? streak > 0 : null,
        tieBreakerPoints: null,
      };
    });
  });
  if (response.length !== 30 || new Set(response.map((entry) => entry.team.id)).size !== 30) {
    throw new Error("ESPN standings must contain all 30 teams exactly once");
  }
  return {
    get: "standings/", parameters: { league: "standard", season: String(season) },
    errors: [], results: response.length, response, source: "espn", lastUpdate: lastUpdate(now),
  };
}

function createStandingsService({ pool, fetchJson: loadJson = fetchJson, now = () => new Date() }) {
  return async function getStandings(season) {
    const result = await pool.query(
      `SELECT data, last_updated FROM standings
       WHERE data->>'source' = $1 AND data->'parameters'->>'season' = $2
       ORDER BY id DESC LIMIT 1`,
      ["espn", String(season)]
    );
    const cached = result.rows[0];
    if (cached && now().getTime() - new Date(cached.last_updated).getTime() < 60 * 60 * 1000) {
      console.log("[standings] Serving cached standings", {
        season, lastUpdate: cached.data.lastUpdate,
      });
      return cached.data;
    }
    const url = `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=${season + 1}&seasontype=2`;
    console.log("[standings] Fetching ESPN standings", {
      season, espnSeason: season + 1, reason: cached ? "cache expired" : "no cached data",
    });
    const data = normalizeStandings(await loadJson(url), season, now());
    await pool.query("INSERT INTO standings (data) VALUES ($1)", [JSON.stringify(data)]);
    console.log("[standings] Saved ESPN standings", {
      season, teams: data.results, lastUpdate: data.lastUpdate,
    });
    return data;
  };
}

module.exports = { parseSeason, normalizeStandings, createStandingsService };
