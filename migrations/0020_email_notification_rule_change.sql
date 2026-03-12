ALTER TABLE notification_rules
RENAME COLUMN email 
ALTER COLUMN updated_by DROP NOT NULL,
ALTER COLUMN updated_by SET DEFAULT '';
