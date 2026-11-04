#!/bin/sh
# Disposable localhost-only fixtures for native PostgreSQL integration tests.
set -eu
keep=false
case "${1:-}" in
  "") ;;
  --keep) keep=true ;;
  *) echo "Usage: $0 [--keep]" >&2; exit 2 ;;
esac
containers=""
cleanup() {
  for container_id in $containers; do
    docker stop "$container_id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM
start() {
  name=$1
  port=$2
  password=$3
  database=$4
  container_id=$(docker run --rm -d --name "$name" -p "127.0.0.1:$port:5432" \
    --tmpfs /var/lib/postgresql/data:rw -e "POSTGRES_PASSWORD=$password" \
    -e "POSTGRES_DB=$database" postgres:17-alpine)
  containers="$containers $container_id"
  attempt=0
  until docker exec "$name" pg_isready -U postgres -d "$database" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then echo "PostgreSQL did not become ready: $name" >&2; exit 1; fi
    sleep 1
  done
}
start dbplayground-pg-qa 55439 playground_qa_only playground_qa
start dbplayground-pg-multidb-qa 55440 multidb_qa_only postgres
docker exec -i dbplayground-pg-qa psql -U postgres -d playground_qa -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.customers(id integer PRIMARY KEY, name text NOT NULL, credit numeric(20,4), active boolean DEFAULT true);
INSERT INTO public.customers SELECT n, 'Customer ' || n, 12.3400, n % 2 = 0 FROM generate_series(1,230) n;
CREATE TABLE public.orders(id bigint PRIMARY KEY, customer_id integer REFERENCES public.customers(id), total numeric(20,4));
INSERT INTO public.orders VALUES (9007199254740993,1,123.4500);
CREATE SCHEMA sales;
CREATE TABLE sales.customers(code text PRIMARY KEY, label text);
INSERT INTO sales.customers VALUES ('S1','Sales customer');
SQL
docker exec dbplayground-pg-multidb-qa psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE analytics_qa'
docker exec dbplayground-pg-multidb-qa psql -U postgres -d analytics_qa -v ON_ERROR_STOP=1 -c 'CREATE TABLE public.database_marker(id integer PRIMARY KEY); INSERT INTO public.database_marker VALUES (1)'
cargo test --manifest-path src-tauri/Cargo.toml live_postgres_ -- --ignored --nocapture
if "$keep"; then
  trap - EXIT INT TERM
  echo "Fixtures retained for desktop QA: dbplayground-pg-qa, dbplayground-pg-multidb-qa"
  echo "Stop these two containers after testing."
fi
