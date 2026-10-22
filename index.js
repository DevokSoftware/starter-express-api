const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { parseSeason, createStandingsService } = require("./standings");

const allowedOrigins = [
  "http://localhost:3000",
  "https://draft-bola-ao-ar.onrender.com",
];

function createApp({ pool, fetchJson, now }) {
  const app = express();
  const getStandings = createStandingsService({ pool, fetchJson, now });

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("The CORS policy for this site does not allow access from the specified Origin."));
    },
  }));

  app.get("/standings", async (req, res) => {
    const startedAt = Date.now();
    console.log("[standings] Request received", { season: req.query.season ?? 2026 });
    res.once("finish", () => {
      console.log("[standings] Request completed", {
        season: req.query.season ?? 2026,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    let season;
    try {
      season = parseSeason(req.query.season);
    } catch (error) {
      return res.status(400).send({ error: error.message });
    }
    try {
      res.send(await getStandings(season));
    } catch (error) {
      console.error("[standings] Request failed", { season }, error);
      res.status(500).send({ error: "Failed to fetch standings" });
    }
  });

  return app;
}

async function start() {
  const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS standings (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database table initialized successfully");
  } catch (error) {
    console.error("Error initializing database:", error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const server = createApp({ pool }).listen(process.env.PORT || 3001);
  async function shutdown() {
    console.log("Shutting down gracefully...");
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) start();

module.exports = { createApp };
