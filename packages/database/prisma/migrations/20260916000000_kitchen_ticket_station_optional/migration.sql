-- D147 — a round produces ONE kitchen ticket, so a ticket no longer belongs
-- to a station.
--
-- Additive and reversible: the column keeps every value it holds, and the
-- foreign key is unchanged. Only the NOT NULL goes, so tickets cut before
-- this change keep the station they were genuinely routed to while every
-- ticket written after it stores NULL.
ALTER TABLE "KitchenTicket" ALTER COLUMN "stationId" DROP NOT NULL;
