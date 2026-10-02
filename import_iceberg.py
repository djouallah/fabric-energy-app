# Run first, in a cell of its own (the catalog needs the pre-release duckdb):
#   !pip install -q duckdb --pre --upgrade
#   notebookutils.session.restartPython()
import duckdb, datetime, glob, os, shutil
from azure.identity import DeviceCodeCredential

# Builds the dashboard's files in Files/data from the analytics-as-code OneLake Iceberg catalog.
# The tables are the ones analytics-as-code's scripts/cache_catalog.py builds, so the same
# dashboard SQL reads them. There is no file-size limit here, so the 5-minute history is one
# file instead of half-year files:
#   dim_<ts>.duckdb    dim_calendar, dim_duid
#   today_<ts>.duckdb  scada_today, price_today (the last RECENT_DAYS days), interconnector_today
#   agg_<ts>.duckdb    scada_daily, price_daily, scada_hourly, price_hourly, month_days
#   data_<ts>.duckdb   scada, price: all history at 5 minutes (the dashboard range-reads it)
#   latest.txt         the current data_<ts>.duckdb; the other names follow from its <ts>
ENDPOINT = 'https://onelake.table.fabric.microsoft.com/iceberg'
WAREHOUSE = '6f966b71-c396-462d-8783-e95224906cef/34a7601b-e1bb-423b-b60e-1c5c69c219a8'  # power / nem
DATA = '/lakehouse/default/Files/data'
TMP = '/tmp/import_iceberg'
SOURCES = ('mart.dim_calendar', 'mart.dim_duid', 'landing.fct_scada', 'landing.fct_price',
           'landing.fct_scada_today', 'landing.fct_price_today', 'landing.fct_regionsum_today',
           'landing.fct_interconnector_today')
FIRST_YEAR = 2018
RECENT_DAYS = 14
LAYOUT = 2  # bump when the files or their tables change: forces a rebuild on an unchanged source

# The catalog lives in another tenant than this notebook, so the notebook's own token is refused
# there (the catalog answers 404). Sign in once with an account of that tenant: the device-code
# link and code are printed under the cell on the first catalog call. The credential is kept
# across re-runs of the cell and renews its token by itself.
TENANT = 'organizations'  # the account's home tenant; put the catalog's tenant id here for a guest account
if '_credential' not in globals():
    _credential = DeviceCodeCredential(tenant_id=TENANT)

# The .duckdb files are read by the dashboard's DuckDB-WASM (the 1.5 line), so they are written
# in a storage version it opens, whatever duckdb is installed here.
STORAGE = "STORAGE_VERSION 'v1.4.0'"


# Runs the statements against the attached catalog and returns the last one's rows. The catalog
# vends no storage credentials (access_delegation_mode 'none'), so the azure secret is what
# authorises the data-file reads. TimeZone must be UTC: SETTLEMENTDATE is AEMO's wall clock
# stored as TIMESTAMPTZ labelled UTC. A connection per call, with the signed-in user's token:
# it lasts about an hour and a duckdb secret doesn't refresh, which is also why the facts are
# exported a year at a time.
def catalog(*sql):
    token = _credential.get_token('https://storage.azure.com/.default').token
    con = duckdb.connect()
    con.install_extension('iceberg')
    con.load_extension('iceberg')
    con.execute(f"CREATE SECRET onelake_storage (TYPE azure, PROVIDER access_token, ACCESS_TOKEN '{token}')")
    con.execute(f"ATTACH '{WAREHOUSE}' AS catalog "
                f"(TYPE ICEBERG, ENDPOINT '{ENDPOINT}', TOKEN '{token}', ACCESS_DELEGATION_MODE 'none')")
    con.execute("SET TimeZone = 'UTC'")
    rows = []
    for q in sql:
        rows = con.execute(q).fetchall()
    con.close()
    return rows


# Rebuild only when the source changed: the current snapshot id of every source table, kept in
# source_version.txt next to the files.
def source_version():
    rows = catalog(' UNION ALL '.join(
        f"SELECT '{t}', arg_max(snapshot_id, timestamp_ms) FROM iceberg_snapshots(catalog.{t})"
        for t in SOURCES))
    return f'layout={LAYOUT} ' + ' '.join(f'{t}={s}' for t, s in sorted(rows))


def to_parquet(query, name):
    return f"COPY ({query}) TO '{TMP}/{name}.parquet' (FORMAT PARQUET)"


# One row per unit (region) and interval: the facts are insert-only merges keyed by file, so an
# interval can be there more than once.
def copy_scada(table, where, name):
    return to_parquet(
        f"SELECT DUID, CAST(SETTLEMENTDATE AS TIMESTAMP) AS ts, "
        f"CAST(ANY_VALUE(INITIALMW) AS REAL) AS mw FROM catalog.landing.{table} "
        f"WHERE INITIALMW <> 0 AND {where} GROUP BY ALL", name)


# Price, operational demand and net interchange (positive = the region exports), all from the
# DREGION rows of the next-day files.
def copy_price(where, name):
    return to_parquet(
        f"SELECT REGIONID, CAST(SETTLEMENTDATE AS TIMESTAMP) AS ts, "
        f"CAST(ANY_VALUE(RRP) AS REAL) AS price, CAST(ANY_VALUE(TOTALDEMAND) AS REAL) AS demand, "
        f"CAST(ANY_VALUE(NETINTERCHANGE) AS REAL) AS net_interchange "
        f"FROM catalog.landing.fct_price WHERE INTERVENTION = 0 AND {where} GROUP BY ALL", name)


# Intraday: price from the PRICE rows, demand and net interchange from the REGIONSUM rows of the
# same DispatchIS files. An interval fct_regionsum_today doesn't have yet keeps a NULL demand.
def copy_price_today(where, name):
    return to_parquet(
        f"WITH p AS (SELECT REGIONID, SETTLEMENTDATE, CAST(ANY_VALUE(RRP) AS REAL) AS price "
        f"FROM catalog.landing.fct_price_today WHERE INTERVENTION = 0 AND {where} GROUP BY ALL), "
        f"r AS (SELECT REGIONID, SETTLEMENTDATE, CAST(ANY_VALUE(TOTALDEMAND) AS REAL) AS demand, "
        f"CAST(ANY_VALUE(NETINTERCHANGE) AS REAL) AS net_interchange "
        f"FROM catalog.landing.fct_regionsum_today WHERE INTERVENTION = 0 AND {where} GROUP BY ALL) "
        f"SELECT p.REGIONID, CAST(p.SETTLEMENTDATE AS TIMESTAMP) AS ts, p.price, r.demand, "
        f"r.net_interchange FROM p LEFT JOIN r "
        f"ON r.REGIONID = p.REGIONID AND r.SETTLEMENTDATE = p.SETTLEMENTDATE", name)


# Interconnector flows (MW, positive from the first region in the ID to the second) and limits.
# The table only holds recent days; a day more than the dashboard keeps is exported, because
# CURRENT_DATE here is UTC and the cut in build() is on AEMO's dates.
def copy_interconnector(name):
    return to_parquet(
        f"SELECT INTERCONNECTORID AS interconnector, CAST(SETTLEMENTDATE AS TIMESTAMP) AS ts, "
        f"CAST(ANY_VALUE(MWFLOW) AS REAL) AS mw, CAST(ANY_VALUE(EXPORTLIMIT) AS REAL) AS export_limit, "
        f"CAST(ANY_VALUE(IMPORTLIMIT) AS REAL) AS import_limit "
        f"FROM catalog.landing.fct_interconnector_today WHERE INTERVENTION = 0 "
        f"AND DATE >= CURRENT_DATE - INTERVAL {RECENT_DAYS + 1} DAY GROUP BY ALL", name)


# The intraday (_today) tables only fill in what the next-day files haven't delivered yet:
# the intervals after the last one in the history just exported.
def after_history(prefix):
    last = duckdb.execute(
        f"SELECT CAST(max(ts) AS VARCHAR) FROM '{TMP}/{prefix}_*.parquet'").fetchone()[0]
    last = last or '1900-01-01 00:00:00'
    return (f"DATE >= CAST(TIMESTAMP '{last}' AS DATE) "
            f"AND CAST(SETTLEMENTDATE AS TIMESTAMP) > TIMESTAMP '{last}'")


def export():
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)
    catalog(*(to_parquet(f'SELECT * FROM catalog.mart.{t}', t) for t in ('dim_calendar', 'dim_duid')))
    for year in range(FIRST_YEAR, datetime.date.today().year + 1):
        catalog(copy_scada('fct_scada', f'INTERVENTION = 0 AND YEAR = {year}', f'scada_{year}'),
                copy_price(f'YEAR = {year}', f'price_{year}'))
        print(f'exported {year}')
    # fct_scada_today has no INTERVENTION column
    catalog(copy_scada('fct_scada_today', after_history('scada'), 'scada_today'),
            copy_price_today(after_history('price'), 'price_today'),
            copy_interconnector('interconnector_today'))
    print('exported today')


# AEMO's interval as the dashboard's columns: the date and the time of day as HHMM.
DATE_TIME = "CAST(ts AS DATE) AS date, CAST(strftime(ts, '%H%M') AS SMALLINT) AS time"


def build(ts):
    fname = f'data_{ts}.duckdb'
    con = duckdb.connect()
    for name in ('data', 'dim', 'today', 'agg'):
        con.execute(f"ATTACH '{DATA}/{name}_{ts}.duckdb' AS {name} ({STORAGE})")
    con.execute('USE data')

    # The 5-minute history, one file. Sorted by date, so a date range is a few blocks over HTTP.
    # Units are not joined to dim_duid here: the ones missing from it (retired) stay in, and the
    # dashboard groups them as "Unregistered".
    con.execute(f"CREATE TABLE scada AS SELECT DUID, {DATE_TIME}, mw "
                f"FROM '{TMP}/scada_*.parquet' ORDER BY date, DUID, time")
    con.execute(f"CREATE TABLE price AS SELECT REGIONID, {DATE_TIME}, price, demand, net_interchange "
                f"FROM '{TMP}/price_*.parquet' ORDER BY date, REGIONID, time")

    # The small files the dashboard downloads whole.
    for t, pk in (('dim_calendar', 'date'), ('dim_duid', 'DUID')):
        con.execute(f'CREATE TABLE dim.{t} AS SELECT DISTINCT ON ("{pk}") * '
                    f"FROM '{TMP}/{t}.parquet' WHERE \"{pk}\" IS NOT NULL ORDER BY \"{pk}\"")

    # The last RECENT_DAYS days at 5 minutes; the dashboard reads anything older from `scada`
    # and `price` above, so the three tables are cut on the same day.
    def recent(col):
        return f'{col} > (SELECT MAX(date) FROM scada) - {RECENT_DAYS}'
    con.execute(f"CREATE TABLE today.scada_today AS SELECT * FROM scada "
                f"WHERE {recent('date')} ORDER BY DUID, date, time")
    con.execute(f"CREATE TABLE today.price_today AS SELECT * FROM price "
                f"WHERE {recent('date')} ORDER BY REGIONID, date, time")
    con.execute(f"CREATE TABLE today.interconnector_today AS "
                f"SELECT interconnector, {DATE_TIME}, mw, export_limit, import_limit "
                f"FROM '{TMP}/interconnector_today.parquet' WHERE {recent('CAST(ts AS DATE)')} "
                f"ORDER BY interconnector, date, time")

    # Rollups for ranges over 30 days, the same as analytics-as-code's build_daily_agg:
    # - scada_daily / price_daily: one row per unit (region) and day.
    # - scada_hourly / price_hourly / month_days: hour of day x month, for the daily-profile and
    #   price-by-hour charts. scada_hourly keeps the positive output only (the profile leaves
    #   charging out); a range's average MW at hour h is SUM(mwh) over its months / SUM(days).
    con.execute("CREATE TABLE agg.scada_daily AS "
                "SELECT DUID, date, CAST(SUM(mw) / 12.0 AS REAL) AS mwh "
                "FROM scada GROUP BY ALL ORDER BY DUID, date")
    con.execute("CREATE TABLE agg.price_daily AS "
                "SELECT REGIONID, date, CAST(AVG(price) AS REAL) AS price, "
                "CAST(AVG(demand) AS REAL) AS demand, "
                "CAST(AVG(net_interchange) AS REAL) AS net_interchange "
                "FROM price GROUP BY ALL ORDER BY REGIONID, date")
    con.execute("CREATE TABLE agg.scada_hourly AS "
                "SELECT DUID, CAST(date_trunc('month', date) AS DATE) AS month, "
                "CAST(time // 100 AS TINYINT) AS hour, CAST(SUM(mw) / 12.0 AS REAL) AS mwh "
                "FROM scada WHERE mw > 0 GROUP BY ALL ORDER BY DUID, month, hour")
    con.execute("CREATE TABLE agg.price_hourly AS "
                "SELECT REGIONID, CAST(date_trunc('month', date) AS DATE) AS month, "
                "CAST(time // 100 AS TINYINT) AS hour, CAST(AVG(price) AS REAL) AS price, "
                "CAST(COUNT(*) AS INTEGER) AS n "
                "FROM price GROUP BY ALL ORDER BY REGIONID, month, hour")
    con.execute("CREATE TABLE agg.month_days AS "
                "SELECT CAST(date_trunc('month', date) AS DATE) AS month, "
                "CAST(COUNT(DISTINCT date) AS SMALLINT) AS days "
                "FROM scada GROUP BY ALL ORDER BY month")

    for t in ('scada', 'price', 'today.scada_today', 'today.price_today',
              'today.interconnector_today', 'agg.scada_daily', 'agg.price_daily'):
        print(t, con.execute(f'SELECT count(*), min(date), max(date) FROM {t}').fetchone())
    for t in ('dim.dim_calendar', 'dim.dim_duid', 'agg.scada_hourly', 'agg.price_hourly',
              'agg.month_days'):
        print(t, con.execute(f'SELECT count(*) FROM {t}').fetchone()[0])

    con.close()

    # Last, once every file it leads to is complete.
    with open(f'{DATA}/latest.txt', 'w') as f:
        f.write(fname)

    # Keep the new files + 1 previous version (dashboards opened before this import still read
    # the previous one); delete older ones. Names carry the timestamp, so sorted order is
    # chronological. hot_* is the previous layout's file: nothing reads it any more.
    for prefix in ('data', 'dim', 'today', 'agg'):
        for p in sorted(glob.glob(f'{DATA}/{prefix}_*.duckdb'))[:-2]:
            os.remove(p)
            print(f'removed {p}')
    for p in glob.glob(f'{DATA}/hot_*.duckdb'):
        os.remove(p)
        print(f'removed {p}')


version = source_version()
marker = f'{DATA}/source_version.txt'
previous = open(marker).read().strip() if os.path.exists(marker) else None

if version == previous:
    print(f'source unchanged ({version}), nothing to rebuild')
else:
    export()
    build(datetime.datetime.now().strftime('%Y%m%d_%H%M'))
    shutil.rmtree(TMP)
    with open(marker, 'w') as f:
        f.write(version)
    print(f'built ({version})')
