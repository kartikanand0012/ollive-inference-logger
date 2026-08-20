-- 0005_assistant.sql
-- Stored history for the analytics copilot ("explain my numbers"). Threaded by
-- a browser-session id so a user's Q&A persists and stays useful across visits.
CREATE TABLE assistant_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  text NOT NULL,
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_assistant_thread ON assistant_messages (thread_id, created_at);
