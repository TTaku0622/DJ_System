-- デフォルト曲（ホストが選んだ曲）。Spotify のプレイリストは使わず、アプリの中だけに持つ
CREATE TABLE default_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_uri TEXT NOT NULL UNIQUE,
  track_name TEXT NOT NULL,
  artist TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
