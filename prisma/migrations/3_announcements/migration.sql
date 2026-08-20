-- объявления: адресаты — все, группы или конкретные пользователи; отметки о прочтении
CREATE TABLE "ht_announcements" (
    "id" SERIAL NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "to_all" BOOLEAN NOT NULL DEFAULT false,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_announcements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ht_announcement_groups" (
    "id" SERIAL NOT NULL,
    "announcement_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,

    CONSTRAINT "ht_announcement_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_announcement_groups_announcement_id_group_id_key" ON "ht_announcement_groups"("announcement_id", "group_id");
ALTER TABLE "ht_announcement_groups" ADD CONSTRAINT "ht_announcement_groups_announcement_id_fkey"
    FOREIGN KEY ("announcement_id") REFERENCES "ht_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ht_announcement_groups" ADD CONSTRAINT "ht_announcement_groups_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "ht_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ht_announcement_users" (
    "id" SERIAL NOT NULL,
    "announcement_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "ht_announcement_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_announcement_users_announcement_id_user_id_key" ON "ht_announcement_users"("announcement_id", "user_id");
ALTER TABLE "ht_announcement_users" ADD CONSTRAINT "ht_announcement_users_announcement_id_fkey"
    FOREIGN KEY ("announcement_id") REFERENCES "ht_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ht_announcement_users" ADD CONSTRAINT "ht_announcement_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "ht_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ht_announcement_reads" (
    "id" SERIAL NOT NULL,
    "announcement_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_announcement_reads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_announcement_reads_announcement_id_user_id_key" ON "ht_announcement_reads"("announcement_id", "user_id");
ALTER TABLE "ht_announcement_reads" ADD CONSTRAINT "ht_announcement_reads_announcement_id_fkey"
    FOREIGN KEY ("announcement_id") REFERENCES "ht_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ht_announcement_reads" ADD CONSTRAINT "ht_announcement_reads_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "ht_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
