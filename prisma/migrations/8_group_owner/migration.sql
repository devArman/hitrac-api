-- группы: владелец (null = админская/общая); имя больше не глобально уникально,
-- у разных клиентов могут совпадать названия личных групп
ALTER TABLE ht_groups ADD COLUMN owner_user_id INTEGER;
DROP INDEX IF EXISTS "ht_groups_name_key";
