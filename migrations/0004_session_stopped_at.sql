-- 自動再開の判断用。「止まっていて曲の終わり」に見えた最初の時刻（曲の切り替わりの一瞬と区別するため）
ALTER TABLE sessions ADD COLUMN stopped_at INTEGER;
