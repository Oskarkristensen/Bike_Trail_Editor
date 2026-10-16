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
