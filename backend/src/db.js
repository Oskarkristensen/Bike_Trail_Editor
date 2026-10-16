const { Pool } = require('pg');

// Fejl her frem for en kryptisk connect-fejl ved første forespørgsel.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL mangler. Kopiér backend/.env.example til backend/.env og indsæt '
    + 'Neons *pooled* connection string.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

// Uden denne lytter vælter en baggrundsfejl på en idle klient hele processen.
pool.on('error', (err) => {
  console.error('Uventet fejl på idle databaseklient:', err);
});

module.exports = pool;
