-- ホストの Spotify トークン（1行だけ）
CREATE TABLE host_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  authorized_at INTEGER NOT NULL
);

-- 共有 URL 1つ = 1セッション。同時に有効なのは1つだけ
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  playlist_name TEXT NOT NULL,
  shuffle INTEGER NOT NULL DEFAULT 0,
  auto_resume INTEGER NOT NULL DEFAULT 1,
  last_seen_playing_at INTEGER,
  last_device_id TEXT,
  last_track_uri TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  track_uri TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist TEXT NOT NULL,
  image_url TEXT,
  nickname TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  played_at INTEGER
);

CREATE INDEX requests_session ON requests (session_id, played_at);
