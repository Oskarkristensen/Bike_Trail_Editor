// Kører schema.sql mod databasen i DATABASE_URL. Kaldes af `npm run db:init`.
// Skemaet køres bevidst ikke ved hver opstart: mod en serverless database er det
// spild ved hvert koldstart, og det skjuler hvornår skemaet sidst ændrede sig.
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Skema kørt mod databasen.');
}

main()
  .catch((err) => {
    console.error('db:init fejlede:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
