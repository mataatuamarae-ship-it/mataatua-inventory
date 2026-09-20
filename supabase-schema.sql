-- Mataatua Marae Inventory — Supabase schema
-- Run this in the SQL editor of your mataatua.marae@gmail.com Supabase project
-- (same project used for the Koha Tracker / Marae Shopping List, just a new table)

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  subcategory text default '',
  name text not null,
  quantity integer not null default 0,
  condition text not null default 'good'
    check (condition in ('good', 'needs_repair', 'damaged', 'missing')),
  notes text default '',
  photo_url text,
  updated_at timestamptz not null default now()
);

-- If you already created this table before photos/sub-categories were
-- added, this picks up the new columns without touching your existing rows.
alter table inventory_items add column if not exists photo_url text;
alter table inventory_items add column if not exists subcategory text default '';

create index if not exists inventory_items_category_idx on inventory_items (category);

-- Keep updated_at current on every edit
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists inventory_items_set_updated_at on inventory_items;
create trigger inventory_items_set_updated_at
  before update on inventory_items
  for each row execute function set_updated_at();

-- Open access via the anon key (same approach as the other marae apps —
-- this is a small closed-community tool, not a public product).
alter table inventory_items enable row level security;

drop policy if exists "public read" on inventory_items;
create policy "public read" on inventory_items for select using (true);

drop policy if exists "public insert" on inventory_items;
create policy "public insert" on inventory_items for insert with check (true);

drop policy if exists "public update" on inventory_items;
create policy "public update" on inventory_items for update using (true);

drop policy if exists "public delete" on inventory_items;
create policy "public delete" on inventory_items for delete using (true);

-- Enable realtime so multiple devices see edits live (safe to re-run)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_items'
  ) then
    alter publication supabase_realtime add table inventory_items;
  end if;
end $$;

-- Quantity history — a log of every quantity change, shown in the app's
-- "History" view grouped by month. Rows are written whenever an item's
-- quantity changes, and can be deleted individually or a whole month at a
-- time from that same view.
create table if not exists inventory_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid,
  item_name text not null,
  category text,
  subcategory text default '',
  old_quantity integer not null default 0,
  new_quantity integer not null default 0,
  changed_at timestamptz not null default now()
);

create index if not exists inventory_history_changed_at_idx on inventory_history (changed_at desc);

alter table inventory_history enable row level security;

drop policy if exists "public read" on inventory_history;
create policy "public read" on inventory_history for select using (true);

drop policy if exists "public insert" on inventory_history;
create policy "public insert" on inventory_history for insert with check (true);

drop policy if exists "public delete" on inventory_history;
create policy "public delete" on inventory_history for delete using (true);
