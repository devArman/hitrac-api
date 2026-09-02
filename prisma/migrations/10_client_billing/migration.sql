-- индивидуальная цена трекера в месяц (драмы).
-- NULL — у клиента базовый тариф, отдельной строки в БД не держим.
ALTER TABLE "ht_users" ADD COLUMN "monthly_price" INTEGER;
