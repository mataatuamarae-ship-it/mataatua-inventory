# Mataatua Inventory

Offline-first stock + condition tracker for Mataatua marae — kitchenware,
bedding, and anything else you add. Same pattern as the Koha Tracker and
Marae Shopping List: a static site on GitHub Pages, backed by Supabase for
live sync, works fine with no internet.

## What it does

- Every item has a category, name, quantity, condition (Good / Needs repair
  / Damaged / Missing) and free-text notes.
- Quick +/- buttons to adjust counts; click a row to edit everything or
  delete it.
- Add a photo to any item — take one with your phone camera or pick from
  your gallery. Photos are compressed automatically and stored right on the
  item, so they sync and work offline like everything else (no separate
  file storage to set up).
- Search, and filter by category, sub-category, condition, or "needs
  attention only".
- **History** button shows every quantity change (from the +/- buttons or
  the edit form), grouped by month, so you can see what changed and when.
- Summary bar: total items, total units, how many need attention.
- Print button gives a clean printable stock list.
- Works fully offline — edits save locally and sync to Supabase (and to
  every other device open on the app) as soon as you're back online.

It's pre-loaded with the counts from your kitchen/bedding stock take so you
don't have to re-type them.

## Setup (one-time)

1. **Supabase tables.** In your `mataatua.marae@gmail.com` Supabase project
   (the same one behind the Koha Tracker and Shopping List), open the SQL
   editor and run `supabase-schema.sql` from this folder. This creates the
   `inventory_items` table and the `inventory_history` table (used by the
   History view) — it does not touch your other tables. It's safe to
   re-run any time you get a newer copy of this file (e.g. after the
   History feature was added) — it only adds what's missing.

2. **Connect the app to it.** In Supabase, go to Project Settings → API and
   copy the **Project URL** and **anon public** key. Paste them into
   `config.js`:

   ```js
   window.SUPABASE_CONFIG = {
     url: "https://xxxxxxxx.supabase.co",
     anonKey: "eyJhbGci...",
   };
   ```

3. **Deploy to GitHub Pages** the same way as your other apps — push this
   folder to a repo and turn on Pages for it (or the `docs/` folder /
   `gh-pages` branch, whichever you've been using).

4. Open the site. The first time it loads with an empty table, it seeds the
   stock take automatically — after that, `seed-data.js` is never touched
   again and everything lives in Supabase.

## Notes

- If you skip step 2, the app still works — it just runs local-only (no
  sync between devices) and shows "offline (not configured)".
- To add a whole new area of inventory (e.g. "Linen" or "Tables & chairs"),
  just add an item with that category name in the Add item dialog — no code
  changes needed.
- The Supabase table uses open read/write policies via the anon key, same
  as the other marae apps — anyone with the site link can edit. Tell me if
  you'd rather lock it down with a login.
- The Supabase client library ships as a local file (`vendor-supabase.js`)
  rather than being fetched from a CDN each time, so the only network
  dependency for syncing is reaching your Supabase project — nothing else
  in between that a firewall or ad-blocker could interfere with.
