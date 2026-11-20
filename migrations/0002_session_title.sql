-- ゲスト画面の「DJ System」の横に出すタイトル（ホストが設定する。空なら出さない）
ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
