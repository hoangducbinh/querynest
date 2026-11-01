#!/bin/sh
# Disposable localhost-only PostgreSQL fixture for cargo's ignored integration test.
set -eu
container=dbplayground-pg-qa
container_id=$(docker run --rm -d --name "$container" -p 127.0.0.1:55439:5432 \
  --tmpfs /var/lib/postgresql/data:rw -e POSTGRES_PASSWORD=playground_qa_only \
  -e POSTGRES_DB=playground_qa postgres:17-alpine)
cleanup() { docker stop "$container_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
attempt=0
until docker exec "$container" pg_isready -U postgres -d playground_qa >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo "PostgreSQL did not become ready" >&2; exit 1; fi
  sleep 1
done
docker exec -i "$container" psql -U postgres -d playground_qa -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.customers(id integer PRIMARY KEY, name text NOT NULL, credit numeric(20,4), active boolean DEFAULT true);
INSERT INTO public.customers SELECT n, 'Customer ' || n, 12.3400, n % 2 = 0 FROM generate_series(1,230) n;
CREATE TABLE public.orders(id bigint PRIMARY KEY, customer_id integer REFERENCES public.customers(id), total numeric(20,4));
INSERT INTO public.orders VALUES (9007199254740993,1,123.4500);
CREATE SCHEMA sales;
CREATE TABLE sales.customers(code text PRIMARY KEY, label text);
INSERT INTO sales.customers VALUES ('S1','Sales customer');
SQL
cargo test --manifest-path src-tauri/Cargo.toml live_postgres_ -- --ignored --nocapture
