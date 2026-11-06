-- The lease of the one server copy that runs realtime (see realtime/leader.ts).
CREATE TABLE realtime_leader (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder text NOT NULL,
  expires_at timestamptz NOT NULL
);
