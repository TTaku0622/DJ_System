-- 今流れている曲のリクエスト（デフォルト曲などリクエストでない曲が流れている間は NULL）
ALTER TABLE sessions ADD COLUMN current_request_id INTEGER;
-- 曲の追加を1件ずつ順番に行うための印（追加している間だけ時刻が入る）
ALTER TABLE sessions ADD COLUMN adding_at INTEGER;
