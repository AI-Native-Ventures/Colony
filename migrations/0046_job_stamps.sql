-- 0045: execution stamps on finished jobs -- which seat ran the work and on
-- what provider and model.
--
-- Phase 3 (docs/design/company-employees.html): the same employee may be
-- executed by different members' seats, and the head must say which provider
-- and model produced the result instead of hiding the difference. The worker
-- sends provider/model on the outcome; the relay keeps them on the row and
-- republishes them as head tags next to the lease-holder that already names
-- the member.
ALTER TABLE jobs ADD COLUMN provider TEXT;
ALTER TABLE jobs ADD COLUMN model TEXT;
