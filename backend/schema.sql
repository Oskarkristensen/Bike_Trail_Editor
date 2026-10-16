-- Skemaet for Bike Trail Editor. Kør med: npm run db:init
--
-- id er INTEGER, ikke BIGINT, med vilje: node-postgres leverer int8 som *streng*
-- for ikke at miste præcision, og frontendens SavedRoute.id er et number. int4
-- rækker rigeligt til et hobbyprojekt og undgår den type-uoverensstemmelse.
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  waypoints_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CHECK på lower(): "Oskar" og "oskar" kan ikke blive to brugere, selv hvis
-- normaliseringen i auth.js en dag glemmes.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessionstabellen til connect-pg-simple. Svarer til pakkens table.sql, men idempotent
-- og uden dens forældede WITH (OIDS=FALSE). Kolonnenavne og typer skal matche pakken.
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Hver rute ejes af en bruger (fase 3). ALTER og ikke en kolonne i CREATE TABLE ovenfor:
-- routes fandtes allerede før brugerne, og CREATE TABLE IF NOT EXISTS springer en
-- eksisterende tabel helt over. Står efter users, som fremmednøglen peger på.
-- NOT NULL fejler hvis tabellen indeholder ruter uden ejer — med vilje: så skal de
-- slettes eller tildeles en bruger først, ikke stille efterlades uden ejer.
-- CASCADE: sletter man en bruger, forsvinder ruterne med.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE;

-- Præcis den forespørgsel listen laver: én brugers ruter, nyeste først
CREATE INDEX IF NOT EXISTS routes_user_created_idx ON routes (user_id, created_at DESC);
