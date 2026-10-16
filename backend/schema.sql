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
