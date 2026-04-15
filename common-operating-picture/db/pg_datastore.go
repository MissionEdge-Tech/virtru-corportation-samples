package db

import (
	"context"

	"github.com/google/uuid"
)

// PgDataStore implements DataStore for a direct PostgreSQL connection via pgx.
// It wraps the sqlc-generated *Queries and adapts the pgx batch-insert API to
// the simpler single-row InsertTdfObject / InsertNoteObject signatures defined
// by DataStore.
type PgDataStore struct {
	q *Queries
}

// NewPgDataStore wraps a sqlc *Queries to satisfy the DataStore interface.
func NewPgDataStore(q *Queries) *PgDataStore {
	return &PgDataStore{q: q}
}

// ── TDF object reads ──────────────────────────────────────────────────────────

func (s *PgDataStore) GetTdfObject(ctx context.Context, id uuid.UUID) (GetTdfObjectRow, error) {
	return s.q.GetTdfObject(ctx, id)
}

func (s *PgDataStore) ListTdfObjects(ctx context.Context, arg ListTdfObjectsParams) ([]ListTdfObjectsRow, error) {
	return s.q.ListTdfObjects(ctx, arg)
}

func (s *PgDataStore) ListTdfObjectsWithGeo(ctx context.Context, arg ListTdfObjectsWithGeoParams) ([]ListTdfObjectsWithGeoRow, error) {
	return s.q.ListTdfObjectsWithGeo(ctx, arg)
}

func (s *PgDataStore) ListTdfObjectsWithSearch(ctx context.Context, arg ListTdfObjectsWithSearchParams) ([]ListTdfObjectsWithSearchRow, error) {
	return s.q.ListTdfObjectsWithSearch(ctx, arg)
}

func (s *PgDataStore) ListTdfObjectsWithSearchAndGeo(ctx context.Context, arg ListTdfObjectsWithSearchAndGeoParams) ([]ListTdfObjectsWithSearchAndGeoRow, error) {
	return s.q.ListTdfObjectsWithSearchAndGeo(ctx, arg)
}

// ── TDF object writes ─────────────────────────────────────────────────────────

// InsertTdfObject wraps the pgx batch CreateTdfObjects call into the single-row
// insert that DataStore requires.
func (s *PgDataStore) InsertTdfObject(ctx context.Context, arg CreateTdfObjectsParams) (uuid.UUID, error) {
	var id uuid.UUID
	var retErr error
	s.q.CreateTdfObjects(ctx, []CreateTdfObjectsParams{arg}).QueryRow(func(_ int, resultID uuid.UUID, err error) {
		id = resultID
		retErr = err
	})
	return id, retErr
}

func (s *PgDataStore) UpdateTdfObject(ctx context.Context, arg UpdateTdfObjectParams) (UpdateTdfObjectRow, error) {
	return s.q.UpdateTdfObject(ctx, arg)
}

func (s *PgDataStore) DeleteTdfObject(ctx context.Context, id uuid.UUID) (TdfObject, error) {
	return s.q.DeleteTdfObject(ctx, id)
}

// ── TDF note operations ───────────────────────────────────────────────────────

func (s *PgDataStore) GetNoteByID(ctx context.Context, id uuid.UUID) (GetNoteByIDRow, error) {
	return s.q.GetNoteByID(ctx, id)
}

func (s *PgDataStore) GetNotesFromPar(ctx context.Context, parentID uuid.UUID) ([]GetNotesFromParRow, error) {
	return s.q.GetNotesFromPar(ctx, parentID)
}

// InsertNoteObject wraps the pgx batch CreateNoteObject call into the single-row
// insert that DataStore requires.
func (s *PgDataStore) InsertNoteObject(ctx context.Context, arg CreateNoteObjectParams) (uuid.UUID, error) {
	var id uuid.UUID
	var retErr error
	s.q.CreateNoteObject(ctx, []CreateNoteObjectParams{arg}).QueryRow(func(_ int, resultID uuid.UUID, err error) {
		id = resultID
		retErr = err
	})
	return id, retErr
}

// ── Source type operations ────────────────────────────────────────────────────

func (s *PgDataStore) ListSrcTypes(ctx context.Context) ([]string, error) {
	return s.q.ListSrcTypes(ctx)
}

func (s *PgDataStore) GetSrcType(ctx context.Context, id string) (SrcType, error) {
	return s.q.GetSrcType(ctx, id)
}
