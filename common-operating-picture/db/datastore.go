package db

import (
	"context"

	"github.com/google/uuid"
)

// trinoAuthKey is an unexported context key for the Trino bearer token.
type trinoAuthKey struct{}

// WithTrinoAuthToken stores a bearer token in ctx so TrinoDataStore can forward
// it as an Authorization header on every Trino query.
func WithTrinoAuthToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, trinoAuthKey{}, token)
}

// trinoAuthTokenFromContext retrieves the bearer token stored by WithTrinoAuthToken.
func trinoAuthTokenFromContext(ctx context.Context) string {
	v, _ := ctx.Value(trinoAuthKey{}).(string)
	return v
}

// DataStore is the unified interface for all database access used by the COP server.

type DataStore interface {
	// TDF object reads
	GetTdfObject(ctx context.Context, id uuid.UUID) (GetTdfObjectRow, error)
	ListTdfObjects(ctx context.Context, arg ListTdfObjectsParams) ([]ListTdfObjectsRow, error)
	ListTdfObjectsWithGeo(ctx context.Context, arg ListTdfObjectsWithGeoParams) ([]ListTdfObjectsWithGeoRow, error)
	ListTdfObjectsWithSearch(ctx context.Context, arg ListTdfObjectsWithSearchParams) ([]ListTdfObjectsWithSearchRow, error)
	ListTdfObjectsWithSearchAndGeo(ctx context.Context, arg ListTdfObjectsWithSearchAndGeoParams) ([]ListTdfObjectsWithSearchAndGeoRow, error)

	// TDF object writes
	InsertTdfObject(ctx context.Context, arg CreateTdfObjectsParams) (uuid.UUID, error)
	UpdateTdfObject(ctx context.Context, arg UpdateTdfObjectParams) (UpdateTdfObjectRow, error)
	DeleteTdfObject(ctx context.Context, id uuid.UUID) (TdfObject, error)

	// TDF note operations
	GetNoteByID(ctx context.Context, id uuid.UUID) (GetNoteByIDRow, error)
	GetNotesFromPar(ctx context.Context, parentID uuid.UUID) ([]GetNotesFromParRow, error)
	InsertNoteObject(ctx context.Context, arg CreateNoteObjectParams) (uuid.UUID, error)

	// Source type operations
	ListSrcTypes(ctx context.Context) ([]string, error)
	GetSrcType(ctx context.Context, id string) (SrcType, error)
}
