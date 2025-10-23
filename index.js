const express = require("express");
const app = express();
var cors = require("cors");
const cron = require("node-cron");
const request = require("request");
const moment = require("moment-timezone");
const { Pool } = require("pg");
const fs = require("fs");
(path = require("path")), (filePath = path.join("/", "standings.json"));

// Database configuration
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin
      // (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        var msg =
          "The CORS policy for this site does not " +
          "allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

const allowedOrigins = [
  "http://localhost:3000",
  "https://draft-bola-ao-ar.onrender.com",
];

const requestOptions = {
  uri: "https://api-nba-v1.p.rapidapi.com/standings?league=standard&season=2025",
  method: "GET",
  headers: {
    "x-rapidapi-host": "api-nba-v1.p.rapidapi.com",
    "x-rapidapi-key": process.env.API_KEY,
  },
  json: true,
};

// Initialize database table
async function initializeDatabase() {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS standings (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(createTableQuery);
    console.log("Database table initialized successfully");
  } catch (error) {
    console.error("Error initializing database:", error);
  }
}

// Initialize database on startup
initializeDatabase();

app.get("/standings", async (req, res) => {
  console.log("Requesting standings...");
  try {
    // Get the latest standings from database
    const result = await pool.query(
      'SELECT data, last_updated FROM standings ORDER BY id DESC LIMIT 1'
    );
    
    if (result.rows.length > 0) {
      const standingsData = result.rows[0].data;
      const lastUpdated = moment(result.rows[0].last_updated);
      
      // Check if data is older than 1 hour
      if (lastUpdated.add(1, "hour").isBefore(moment().tz("Europe/Lisbon"))) {
        console.log("Updating Standings...");
        const newData = await requestStandings();
        res.send(newData);
      } else {
        res.send(standingsData);
      }
    } else {
      console.log("No standings data found. Fetching new data...");
      const newData = await requestStandings();
      res.send(newData);
    }
  } catch (err) {
    console.log("Error fetching standings:", err);
    res.status(500).send({ error: "Failed to fetch standings" });
  }
});

async function requestStandings() {
  return new Promise(async (resolve, reject) => {
    request(requestOptions, async (error, response, json) => {
      if (!error && response.statusCode === 200) {
        json.lastUpdate = moment()
          .tz("Europe/Lisbon")
          .format("DD-MM-YYYY HH:mm:ss");
        
        try {
          // Save to database
          await pool.query(
            'INSERT INTO standings (data) VALUES ($1)',
            [JSON.stringify(json)]
          );
          console.log("Standings data saved to database");
          resolve(json);
        } catch (dbError) {
          console.error("Error saving to database:", dbError);
          reject(dbError);
        }
      } else {
        console.error(
          "Error:",
          error || response.statusCode,
          response && response.statusMessage
        );
        reject(error || response.statusCode);
      }
    });
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

app.listen(process.env.PORT || 3001);
