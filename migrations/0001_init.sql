-- Migration: initial schema
-- Tables: users, sessions, bookings

CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT    NOT NULL UNIQUE,
  password_hash    TEXT    NOT NULL,
  studio_name      TEXT    NOT NULL DEFAULT 'My Studio',
  booking_slug     TEXT    NOT NULL UNIQUE,
  deposit_cents    INTEGER NOT NULL DEFAULT 5000,
  plan             TEXT    NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL  -- epoch ms
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name       TEXT    NOT NULL,
  client_email      TEXT    NOT NULL,
  client_phone      TEXT,
  description       TEXT    NOT NULL,
  preferred_date    TEXT    NOT NULL,
  duration_minutes  INTEGER NOT NULL DEFAULT 120,
  status            TEXT    NOT NULL DEFAULT 'pending',
  deposit_cents     INTEGER NOT NULL,
  deposit_paid_at   TEXT,
  consent_signed_at TEXT,
  consent_name      TEXT,
  appointment_date  TEXT,
  aftercare_day3_at  TEXT,
  aftercare_day14_at TEXT,
  client_ip         TEXT,
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookings_user   ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);
