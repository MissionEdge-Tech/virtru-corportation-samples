package db

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	_ "github.com/trinodb/trino-go-client/trino" // register "trino" sql driver
	trino "github.com/trinodb/trino-go-client/trino"
	geos "github.com/twpayne/go-geos"
	"github.com/virtru-corp/dsp-cop/pkg/config"
)

// TrinoDataStore implements DataStore using the TDF-Trino query engine.
//
// Reads are routed through Trino so the tdf_postgresql connector can
// transparently decrypt TDF-protected columns based on the caller's JWT
// entitlements.  The bearer token is forwarded as an AccessToken on a
// per-query sql.DB — the trino-go-client sets it as the HTTP Authorization
// header, which Trino's header-authenticator then validates.
//
// Writes (INSERT / UPDATE / DELETE) are also sent through Trino; the
// tdf_postgresql connector pushes them down to PostgreSQL.
type TrinoDataStore struct {
	db          *sql.DB
	serverURI   string // base URI, e.g. https://admin@host:8443
	catalog     string
	schema      string
	sslCertPath string // PEM CA cert path for HTTPS (empty = system pool)

	// fallbackToken is a service-account JWT used when no user token is in context.
	// The TDF connector requires a JWT on every table access, so server-initiated
	// queries (e.g. src_type lookups) use this token.
	fallbackMu    sync.RWMutex
	fallbackToken string

	// userDBs caches one sql.DB per access token so we don't open a new
	// Trino session (and Postgres connection) on every query.
	userDBsMu sync.Mutex
	userDBs   map[string]*sql.DB
}

// SetFallbackToken updates the service-account JWT used for queries that have
// no user bearer token in their context (e.g. src_type lookups on startup).
func (s *TrinoDataStore) SetFallbackToken(token string) {
	s.fallbackMu.Lock()
	s.fallbackToken = strings.TrimPrefix(token, "Bearer ")
	s.fallbackMu.Unlock()
}

func (s *TrinoDataStore) getFallbackToken() string {
	s.fallbackMu.RLock()
	defer s.fallbackMu.RUnlock()
	return s.fallbackToken
}

// NewTrinoDataStore opens a connection pool to Trino and pings it to verify
// connectivity.
func NewTrinoDataStore(cfg config.TrinoConfig) (*TrinoDataStore, error) {
	// The trino-go-client embeds the user inside the ServerURI.
	serverURI := cfg.URL
	if cfg.User != "" && !strings.Contains(serverURI, "@") {
		// Insert user into the URI: https://user@host:port
		serverURI = strings.Replace(serverURI, "://", "://"+cfg.User+"@", 1)
	}

	baseCfg := &trino.Config{
		ServerURI:   serverURI,
		Catalog:     cfg.Catalog,
		Schema:      cfg.Schema,
		SSLCertPath: cfg.SSLCertPath,
	}
	baseDSN, err := baseCfg.FormatDSN()
	if err != nil {
		return nil, fmt.Errorf("formatting trino DSN: %w", err)
	}

	db, err := sql.Open("trino", baseDSN)
	if err != nil {
		return nil, fmt.Errorf("opening trino connection: %w", err)
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("pinging trino at %s: %w", cfg.URL, err)
	}

	slog.Info("Trino connection established",
		slog.String("url", cfg.URL),
		slog.String("catalog", cfg.Catalog),
		slog.String("schema", cfg.Schema),
	)

	return &TrinoDataStore{
		db:          db,
		serverURI:   serverURI,
		catalog:     cfg.Catalog,
		schema:      cfg.Schema,
		sslCertPath: cfg.SSLCertPath,
		userDBs:     make(map[string]*sql.DB),
	}, nil
}

// Close releases the underlying Trino connection pool and all cached user DBs.
func (s *TrinoDataStore) Close() error {
	s.userDBsMu.Lock()
	for _, db := range s.userDBs {
		db.Close()
	}
	s.userDBs = make(map[string]*sql.DB)
	s.userDBsMu.Unlock()
	return s.db.Close()
}

// jwtPreferredUsername decodes the JWT payload (without signature verification —
// Trino verifies it) and returns the preferred_username claim.
// Falls back to "admin" on any parse error.
func jwtPreferredUsername(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return "admin"
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "admin"
	}
	var claims struct {
		PreferredUsername string `json:"preferred_username"`
		Sub               string `json:"sub"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "admin"
	}
	if claims.PreferredUsername != "" {
		return claims.PreferredUsername
	}
	return claims.Sub
}

// serverURIForUser returns the ServerURI with the given username embedded,
// replacing whatever user is currently in the URI.
func serverURIForUser(baseURI, user string) string {
	// Strip existing user (e.g. https://admin@host → https://host)
	if at := strings.Index(baseURI, "@"); at != -1 {
		scheme := baseURI[:strings.Index(baseURI, "//")+2]
		rest := baseURI[at+1:]
		baseURI = scheme + rest
	}
	return strings.Replace(baseURI, "://", "://"+user+"@", 1)
}

// dbForCtx returns a *sql.DB scoped to the bearer token in ctx.
// User-scoped DBs are cached by token so only one Trino session (and therefore
// one Postgres connection) is maintained per active user rather than creating a
// fresh sql.DB — and a fresh Postgres connection — on every query.
// When no user token is present the service-account fallback token is used.
// The returned cleanup func is a no-op; the DB lives in the cache.
func (s *TrinoDataStore) dbForCtx(ctx context.Context) (db *sql.DB, cleanup func(), err error) {
	token := strings.TrimPrefix(trinoAuthTokenFromContext(ctx), "Bearer ")
	if token == "" {
		token = s.getFallbackToken()
	}
	if token == "" {
		// No token at all — return base pool; query will fail at Trino with a
		// meaningful auth error rather than a nil-pointer panic.
		return s.db, func() {}, nil
	}

	s.userDBsMu.Lock()
	if cached, ok := s.userDBs[token]; ok {
		s.userDBsMu.Unlock()
		return cached, func() {}, nil
	}

	// Derive the Trino user from the JWT so X-Trino-User matches the
	// authenticated principal and Trino doesn't reject it as impersonation.
	user := jwtPreferredUsername(token)
	serverURI := serverURIForUser(s.serverURI, user)

	dsn, err := (&trino.Config{
		ServerURI:   serverURI,
		Catalog:     s.catalog,
		Schema:      s.schema,
		AccessToken: token,
		SSLCertPath: s.sslCertPath,
	}).FormatDSN()
	if err != nil {
		s.userDBsMu.Unlock()
		return nil, nil, fmt.Errorf("formatting trino DSN with token: %w", err)
	}

	authedDB, err := sql.Open("trino", dsn)
	if err != nil {
		s.userDBsMu.Unlock()
		return nil, nil, fmt.Errorf("opening token-scoped trino connection: %w", err)
	}
	authedDB.SetMaxOpenConns(3)
	authedDB.SetMaxIdleConns(1)
	authedDB.SetConnMaxLifetime(10 * time.Minute)

	s.userDBs[token] = authedDB
	s.userDBsMu.Unlock()
	return authedDB, func() {}, nil
}

// table returns the fully-qualified Trino table reference catalog.schema.table.
func (s *TrinoDataStore) table(name string) string {
	return fmt.Sprintf("%s.%s.%s", s.catalog, s.schema, name)
}

// parseGeoJSON converts a nullable GeoJSON string (from to_geojson_geometry) into a
// *geos.Geom.  Returns nil when the string is empty or NULL.
func parseGeoJSON(raw sql.NullString) (*geos.Geom, error) {
	if !raw.Valid || raw.String == "" {
		return nil, nil
	}
	g, err := geos.NewGeomFromGeoJSON(raw.String)
	if err != nil {
		return nil, fmt.Errorf("parsing GeoJSON from Trino: %w", err)
	}
	return g, nil
}

// ── TDF object reads ──────────────────────────────────────────────────────────

const trinoGetTdfObject = `
SELECT
    CAST(id AS VARCHAR)          AS id,
    ts,
    src_type,
    to_geojson_geometry(to_spherical_geography(geo)) AS geo,
    JSON_FORMAT(search)           AS search,
    JSON_FORMAT(metadata)         AS metadata,
    tdf_blob,
    CAST(tdf_uri  AS VARCHAR)    AS tdf_uri
FROM %s
WHERE id = ?
LIMIT 1
`

func (s *TrinoDataStore) GetTdfObject(ctx context.Context, id uuid.UUID) (GetTdfObjectRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return GetTdfObjectRow{}, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoGetTdfObject, s.table("tdf_objects"))
	row := db.QueryRowContext(ctx, q, id.String())

	var (
		idStr, srcType     string
		ts                 time.Time
		geoRaw, search     sql.NullString
		metadata, tdfURI   sql.NullString
		tdfBlob            []byte
	)
	if err := row.Scan(&idStr, &ts, &srcType, &geoRaw, &search, &metadata, &tdfBlob, &tdfURI); err != nil {
		return GetTdfObjectRow{}, err
	}
	parsedID, err := uuid.Parse(idStr)
	if err != nil {
		return GetTdfObjectRow{}, fmt.Errorf("parsing uuid %q: %w", idStr, err)
	}
	geom, err := parseGeoJSON(geoRaw)
	if err != nil {
		return GetTdfObjectRow{}, err
	}
	return GetTdfObjectRow{
		ID:       parsedID,
		Ts:       pgtype.Timestamp{Time: ts, Valid: true},
		SrcType:  srcType,
		Geo:      geom,
		Search:   []byte(search.String),
		Metadata: []byte(metadata.String),
		TdfBlob:  tdfBlob,
		TdfUri:   pgtype.Text{String: tdfURI.String, Valid: tdfURI.Valid},
	}, nil
}

const trinoListTdfObjects = `
SELECT
    CAST(id AS VARCHAR)          AS id,
    ts,
    src_type,
    to_geojson_geometry(to_spherical_geography(geo)) AS geo,
    JSON_FORMAT(search)           AS search,
    JSON_FORMAT(metadata)         AS metadata,
    tdf_blob,
    CAST(tdf_uri  AS VARCHAR)    AS tdf_uri
FROM %s
WHERE src_type = ? AND ts >= ? AND ts <= ?
ORDER BY ts DESC
`

func (s *TrinoDataStore) ListTdfObjects(ctx context.Context, arg ListTdfObjectsParams) ([]ListTdfObjectsRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoListTdfObjects, s.table("tdf_objects"))
	rows, err := db.QueryContext(ctx, q, arg.SourceType, arg.StartTime.Time, arg.EndTime.Time)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTdfObjectRows[ListTdfObjectsRow](rows, func(r tdfObjectScanResult) ListTdfObjectsRow {
		return ListTdfObjectsRow(r)
	})
}

const trinoListTdfObjectsWithGeo = `
SELECT
    CAST(id AS VARCHAR)          AS id,
    ts,
    src_type,
    to_geojson_geometry(to_spherical_geography(geo)) AS geo,
    JSON_FORMAT(search)           AS search,
    JSON_FORMAT(metadata)         AS metadata,
    tdf_blob,
    CAST(tdf_uri  AS VARCHAR)    AS tdf_uri
FROM %s
WHERE src_type = ? AND ts >= ? AND ts <= ?
  AND ST_Within(geo, to_geometry(from_geojson_geometry(?)))
ORDER BY ts DESC
`

func (s *TrinoDataStore) ListTdfObjectsWithGeo(ctx context.Context, arg ListTdfObjectsWithGeoParams) ([]ListTdfObjectsWithGeoRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoListTdfObjectsWithGeo, s.table("tdf_objects"))
	rows, err := db.QueryContext(ctx, q,
		arg.SourceType, arg.StartTime.Time, arg.EndTime.Time, arg.Geometry)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTdfObjectRows[ListTdfObjectsWithGeoRow](rows, func(r tdfObjectScanResult) ListTdfObjectsWithGeoRow {
		return ListTdfObjectsWithGeoRow(r)
	})
}

const trinoListTdfObjectsWithSearch = `
SELECT
    CAST(id AS VARCHAR)          AS id,
    ts,
    src_type,
    to_geojson_geometry(to_spherical_geography(geo)) AS geo,
    JSON_FORMAT(search)           AS search,
    JSON_FORMAT(metadata)         AS metadata,
    tdf_blob,
    CAST(tdf_uri  AS VARCHAR)    AS tdf_uri
FROM %s
WHERE src_type = ? AND ts >= ? AND ts <= ?
  AND JSON_FORMAT(search) LIKE ?
ORDER BY ts DESC
`

func (s *TrinoDataStore) ListTdfObjectsWithSearch(ctx context.Context, arg ListTdfObjectsWithSearchParams) ([]ListTdfObjectsWithSearchRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoListTdfObjectsWithSearch, s.table("tdf_objects"))
	rows, err := db.QueryContext(ctx, q,
		arg.SourceType, arg.StartTime.Time, arg.EndTime.Time, "%"+string(arg.Search)+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTdfObjectRows[ListTdfObjectsWithSearchRow](rows, func(r tdfObjectScanResult) ListTdfObjectsWithSearchRow {
		return ListTdfObjectsWithSearchRow(r)
	})
}

const trinoListTdfObjectsWithSearchAndGeo = `
SELECT
    CAST(id AS VARCHAR)          AS id,
    ts,
    src_type,
    to_geojson_geometry(to_spherical_geography(geo)) AS geo,
    JSON_FORMAT(search)           AS search,
    JSON_FORMAT(metadata)         AS metadata,
    tdf_blob,
    CAST(tdf_uri  AS VARCHAR)    AS tdf_uri
FROM %s
WHERE src_type = ? AND ts >= ? AND ts <= ?
  AND JSON_FORMAT(search) LIKE ?
  AND ST_Within(geo, to_geometry(from_geojson_geometry(?)))
ORDER BY ts DESC
`

func (s *TrinoDataStore) ListTdfObjectsWithSearchAndGeo(ctx context.Context, arg ListTdfObjectsWithSearchAndGeoParams) ([]ListTdfObjectsWithSearchAndGeoRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoListTdfObjectsWithSearchAndGeo, s.table("tdf_objects"))
	rows, err := db.QueryContext(ctx, q,
		arg.SourceType, arg.StartTime.Time, arg.EndTime.Time,
		"%"+string(arg.Search)+"%", arg.Geometry)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTdfObjectRows[ListTdfObjectsWithSearchAndGeoRow](rows, func(r tdfObjectScanResult) ListTdfObjectsWithSearchAndGeoRow {
		return ListTdfObjectsWithSearchAndGeoRow(r)
	})
}

// tdfObjectScanResult is the common row shape for all tdf_objects SELECT queries.
// It mirrors ListTdfObjectsRow / ListTdfObjectsWithGeoRow etc., which are
// identical structs — the generic helper converts between them.
type tdfObjectScanResult struct {
	ID       uuid.UUID
	Ts       pgtype.Timestamp
	SrcType  string
	Geo      interface{}
	Search   []byte
	Metadata []byte
	TdfBlob  []byte
	TdfUri   pgtype.Text
}

// scanTdfObjectRows scans the common tdf_objects column set and maps each row
// into the target type T using the provided converter.
func scanTdfObjectRows[T any](rows *sql.Rows, convert func(tdfObjectScanResult) T) ([]T, error) {
	var items []T
	for rows.Next() {
		var (
			idStr              string
			ts                 time.Time
			srcType            string
			geoRaw, search     sql.NullString
			metadata, tdfURI   sql.NullString
			tdfBlob            []byte
		)
		if err := rows.Scan(&idStr, &ts, &srcType, &geoRaw, &search, &metadata, &tdfBlob, &tdfURI); err != nil {
			return nil, err
		}
		parsedID, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("parsing uuid %q: %w", idStr, err)
		}
		geom, err := parseGeoJSON(geoRaw)
		if err != nil {
			return nil, err
		}
		items = append(items, convert(tdfObjectScanResult{
			ID:       parsedID,
			Ts:       pgtype.Timestamp{Time: ts, Valid: true},
			SrcType:  srcType,
			Geo:      geom,
			Search:   []byte(search.String),
			Metadata: []byte(metadata.String),
			TdfBlob:  tdfBlob,
			TdfUri:   pgtype.Text{String: tdfURI.String, Valid: tdfURI.Valid},
		}))
	}
	return items, rows.Err()
}

// ── TDF object writes ─────────────────────────────────────────────────────────

const trinoInsertTdfObject = `
INSERT INTO %s (id, ts, src_type, geo, search, metadata, tdf_blob, tdf_uri)
VALUES (
    CAST(? AS UUID),
    CAST(? AS TIMESTAMP),
    ?,
    to_geometry(from_geojson_geometry(?)),
    CAST(? AS JSON),
    CAST(? AS JSON),
    ?,
    ?
)
`

// InsertTdfObject inserts a row into tdf_objects via Trino.
// The UUID is generated client-side because Trino does not support RETURNING.
func (s *TrinoDataStore) InsertTdfObject(ctx context.Context, arg CreateTdfObjectsParams) (uuid.UUID, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer cleanup()

	id := uuid.New()
	geoJSON := ""
	if arg.Geo != nil {
		geoJSON = arg.Geo.ToGeoJSON(0)
	}
	tdfURI := ""
	if arg.TdfUri.Valid {
		tdfURI = arg.TdfUri.String
	}

	q := fmt.Sprintf(trinoInsertTdfObject, s.table("tdf_objects"))
	_, err = db.ExecContext(ctx, q,
		id.String(),
		arg.Ts.Time.UTC().Format(time.RFC3339Nano),
		arg.SrcType,
		geoJSON,
		string(arg.Search),
		string(arg.Metadata),
		arg.TdfBlob,
		tdfURI,
	)
	if err != nil {
		return uuid.Nil, fmt.Errorf("trino insert tdf_object: %w", err)
	}
	return id, nil
}

const trinoUpdateTdfObject = `
UPDATE %s
SET ts       = COALESCE(CAST(? AS TIMESTAMP), ts),
    src_type = COALESCE(?, src_type),
    tdf_blob = COALESCE(?, tdf_blob),
    tdf_uri  = COALESCE(?, tdf_uri)
WHERE id = CAST(? AS UUID)
`

func (s *TrinoDataStore) UpdateTdfObject(ctx context.Context, arg UpdateTdfObjectParams) (UpdateTdfObjectRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return UpdateTdfObjectRow{}, err
	}
	defer cleanup()

	var tsVal interface{}
	if arg.Ts.Valid {
		tsVal = arg.Ts.Time.UTC().Format(time.RFC3339Nano)
	}
	var srcType interface{}
	if arg.SrcType.Valid {
		srcType = arg.SrcType.String
	}
	var tdfURI interface{}
	if arg.TdfUri.Valid {
		tdfURI = arg.TdfUri.String
	}

	q := fmt.Sprintf(trinoUpdateTdfObject, s.table("tdf_objects"))
	_, err = db.ExecContext(ctx, q, tsVal, srcType, arg.TdfBlob, tdfURI, arg.ID.String())
	if err != nil {
		return UpdateTdfObjectRow{}, fmt.Errorf("trino update tdf_object: %w", err)
	}
	return UpdateTdfObjectRow{ID: arg.ID, SrcType: arg.SrcType.String, Ts: arg.Ts}, nil
}

const trinoDeleteTdfObject = `DELETE FROM %s WHERE id = CAST(? AS UUID)`

func (s *TrinoDataStore) DeleteTdfObject(ctx context.Context, id uuid.UUID) (TdfObject, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return TdfObject{}, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoDeleteTdfObject, s.table("tdf_objects"))
	if _, err = db.ExecContext(ctx, q, id.String()); err != nil {
		return TdfObject{}, fmt.Errorf("trino delete tdf_object: %w", err)
	}
	return TdfObject{ID: id}, nil
}

// ── TDF note operations ───────────────────────────────────────────────────────

const trinoGetNoteByID = `
SELECT
    CAST(id        AS VARCHAR) AS id,
    ts,
    CAST(parent_id AS VARCHAR) AS parent_id,
    tdf_blob,
    JSON_FORMAT(search)        AS search,
    CAST(tdf_uri   AS VARCHAR) AS tdf_uri
FROM %s
WHERE id = ?
LIMIT 1
`

func (s *TrinoDataStore) GetNoteByID(ctx context.Context, id uuid.UUID) (GetNoteByIDRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return GetNoteByIDRow{}, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoGetNoteByID, s.table("tdf_notes"))
	row := db.QueryRowContext(ctx, q, id.String())

	var (
		idStr, parentIDStr string
		ts                 time.Time
		tdfBlob            []byte
		search, tdfURI     sql.NullString
	)
	if err := row.Scan(&idStr, &ts, &parentIDStr, &tdfBlob, &search, &tdfURI); err != nil {
		return GetNoteByIDRow{}, err
	}
	parsedID, err := uuid.Parse(idStr)
	if err != nil {
		return GetNoteByIDRow{}, fmt.Errorf("parsing note uuid %q: %w", idStr, err)
	}
	parsedParentID, err := uuid.Parse(parentIDStr)
	if err != nil {
		return GetNoteByIDRow{}, fmt.Errorf("parsing parent uuid %q: %w", parentIDStr, err)
	}
	return GetNoteByIDRow{
		ID:       parsedID,
		Ts:       pgtype.Timestamp{Time: ts, Valid: true},
		ParentID: parsedParentID,
		TdfBlob:  tdfBlob,
		Search:   []byte(search.String),
		TdfUri:   pgtype.Text{String: tdfURI.String, Valid: tdfURI.Valid},
	}, nil
}

const trinoGetNotesFromPar = `
SELECT
    CAST(id        AS VARCHAR) AS id,
    ts,
    CAST(parent_id AS VARCHAR) AS parent_id,
    JSON_FORMAT(search)        AS search,
    tdf_blob,
    CAST(tdf_uri   AS VARCHAR) AS tdf_uri
FROM %s
WHERE parent_id = ?
`

func (s *TrinoDataStore) GetNotesFromPar(ctx context.Context, parentID uuid.UUID) ([]GetNotesFromParRow, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoGetNotesFromPar, s.table("tdf_notes"))
	rows, err := db.QueryContext(ctx, q, parentID.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []GetNotesFromParRow
	for rows.Next() {
		var (
			idStr, parentIDStr string
			ts                 time.Time
			search, tdfURI     sql.NullString
			tdfBlob            []byte
		)
		if err := rows.Scan(&idStr, &ts, &parentIDStr, &search, &tdfBlob, &tdfURI); err != nil {
			return nil, err
		}
		parsedID, err := uuid.Parse(idStr)
		if err != nil {
			return nil, fmt.Errorf("parsing note uuid %q: %w", idStr, err)
		}
		parsedParentID, err := uuid.Parse(parentIDStr)
		if err != nil {
			return nil, fmt.Errorf("parsing parent uuid %q: %w", parentIDStr, err)
		}
		items = append(items, GetNotesFromParRow{
			ID:       parsedID,
			Ts:       pgtype.Timestamp{Time: ts, Valid: true},
			ParentID: parsedParentID,
			Search:   []byte(search.String),
			TdfBlob:  tdfBlob,
			TdfUri:   pgtype.Text{String: tdfURI.String, Valid: tdfURI.Valid},
		})
	}
	return items, rows.Err()
}

const trinoInsertNoteObject = `
INSERT INTO %s (id, ts, parent_id, search, tdf_blob, tdf_uri)
VALUES (
    CAST(? AS UUID),
    CAST(? AS TIMESTAMP),
    CAST(? AS UUID),
    CAST(? AS JSON),
    ?,
    ?
)
`

// InsertNoteObject inserts a row into tdf_notes via Trino.
// UUID is generated client-side since Trino does not support RETURNING.
func (s *TrinoDataStore) InsertNoteObject(ctx context.Context, arg CreateNoteObjectParams) (uuid.UUID, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer cleanup()

	id := uuid.New()
	tdfURI := ""
	if arg.TdfUri.Valid {
		tdfURI = arg.TdfUri.String
	}

	q := fmt.Sprintf(trinoInsertNoteObject, s.table("tdf_notes"))
	_, err = db.ExecContext(ctx, q,
		id.String(),
		arg.Ts.Time.UTC().Format(time.RFC3339Nano),
		arg.ParentID.String(),
		string(arg.Search),
		arg.TdfBlob,
		tdfURI,
	)
	if err != nil {
		return uuid.Nil, fmt.Errorf("trino insert tdf_note: %w", err)
	}
	return id, nil
}

// ── Source type operations ────────────────────────────────────────────────────

const trinoListSrcTypes = `SELECT id FROM %s`

func (s *TrinoDataStore) ListSrcTypes(ctx context.Context) ([]string, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoListSrcTypes, s.table("src_types"))
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

const trinoGetSrcType = `
SELECT
    id,
    JSON_FORMAT(form_schema)     AS form_schema,
    JSON_FORMAT(ui_schema)       AS ui_schema,
    JSON_FORMAT(metadata)        AS metadata
FROM %s
WHERE id = ?
`

func (s *TrinoDataStore) GetSrcType(ctx context.Context, id string) (SrcType, error) {
	db, cleanup, err := s.dbForCtx(ctx)
	if err != nil {
		return SrcType{}, err
	}
	defer cleanup()

	q := fmt.Sprintf(trinoGetSrcType, s.table("src_types"))
	row := db.QueryRowContext(ctx, q, id)

	var (
		srcID                          string
		formSchema, uiSchema, metadata sql.NullString
	)
	if err := row.Scan(&srcID, &formSchema, &uiSchema, &metadata); err != nil {
		return SrcType{}, err
	}
	return SrcType{
		ID:         srcID,
		FormSchema: []byte(formSchema.String),
		UiSchema:   []byte(uiSchema.String),
		Metadata:   []byte(metadata.String),
	}, nil
}
