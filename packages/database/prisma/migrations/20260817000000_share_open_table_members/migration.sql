-- D50. One physical table may back several open tables at once (two unrelated
-- parties sharing a four-top, each with its own tab). Widening: the dropped
-- index only ever REFUSED rows, so every existing row stays valid and no data
-- moves. The pair unique (openTableId, memberTableId) survives untouched — a
-- table still cannot be added twice to the same open table.

-- DropIndex
DROP INDEX "OpenTableMember_memberTableId_key";

-- CreateIndex
CREATE INDEX "OpenTableMember_memberTableId_idx" ON "OpenTableMember"("memberTableId");

