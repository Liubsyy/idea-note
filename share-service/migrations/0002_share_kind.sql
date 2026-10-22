-- 'note' or 'folder'. Rows published before this column are filled lazily.
ALTER TABLE shares ADD COLUMN kind TEXT;
