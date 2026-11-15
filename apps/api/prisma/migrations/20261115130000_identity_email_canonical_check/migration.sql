-- The canonical form of an email, enforced by the database (ADR-0010, step 2.1 security review).
--
-- Hand-written: Prisma does not model CHECK constraints. It is a NEW migration; applied migrations are never edited.
--
-- THE INVARIANT. The application canonicalizes every email with `canonicalizeEmail` (packages/contracts): surrounding whitespace removed,
-- lower-cased. Its validation (`z.email()`) then accepts only printable ASCII, so every address the application can store is ASCII,
-- lower-case and free of whitespace. The constraint says exactly that, and nothing about the *shape* of an address (that stays the
-- application's business, so a change of its email rules never needs a migration):
--
--   email ~ '^[!-~]+$'                    only printable ASCII, U+0021 to U+007E, and at least one character. That excludes the space, the tab
--                                         and every other control character, and everything outside ASCII: no-break space, the Unicode
--                                         spaces, ideographic space, the byte order mark (the characters JavaScript's trim() also strips),
--                                         and any non-ASCII text, which the application rejects anyway. A NUL byte cannot exist in text.
--   email = lower(email COLLATE "C")      no upper-case letter. COLLATE "C" makes lower() touch only A-Z, so the result does not depend on the
--                                         database's locale (a tr_TR ctype would otherwise lower-case "I" differently).
--
-- Regular-expression ranges are code point ranges in PostgreSQL (verified: '[A-Z]' does not match 'a', '[!-~]' does not match 'é').
--
-- The unique index on `email` is unchanged; together they make "one address, one account" a property of the data, not only of the
-- application: a spelling variant (`Alice@x.com`, ` alice@x.com`) can no longer be stored next to `alice@x.com`, and a row that no
-- sign-in could ever reach cannot exist.
--
-- EXISTING ROWS ARE NEVER REWRITTEN. This migration first counts rows that violate the invariant; if there is any it stops with an
-- actionable message and changes nothing. Correcting an email is an identity decision (it may merge or lock out accounts), so a
-- person makes it, not a migration.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM identity."user"
   WHERE NOT (email ~ '^[!-~]+$' AND email = lower(email COLLATE "C"));

  IF offending > 0 THEN
    RAISE EXCEPTION 'identity.user_email_canonical cannot be added: % user row(s) have an email that is not in canonical form (printable ASCII without whitespace, all lower case). Nothing was changed.', offending
      USING ERRCODE = 'check_violation',
            HINT = 'List them with: SELECT id FROM identity."user" WHERE NOT (email ~ ''^[!-~]+$'' AND email = lower(email COLLATE "C")); then correct or remove those users deliberately (this migration never rewrites an email), run "prisma migrate resolve --rolled-back 20261115130000_identity_email_canonical_check", and deploy again.';
  END IF;
END
$$;

-- == add the constraint ==
ALTER TABLE identity."user"
  ADD CONSTRAINT user_email_canonical
  CHECK (email ~ '^[!-~]+$' AND email = lower(email COLLATE "C"));
