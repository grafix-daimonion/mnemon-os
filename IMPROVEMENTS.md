# mnemon-os Improvements

## Version: Production Backport
## Date: 2026-08-02

This update includes critical bug fixes and architectural improvements backported from production deployments. All code has been sanitized to remove any company or customer references.

## Critical Bug Fixes

### 1. Entity Silo (Scope Isolation) ⚠️ CRITICAL

**Bug Fixed**: Entities from different scopes could merge, causing data leaks between projects.

**Solution**: Implemented scope-based entity resolution where entities can only merge within their designated scope.

**Impact**: Prevents catastrophic cross-scope data contamination.

**Files Added**:
- `migrations/001_entity_silo.sql` - Database migration for scope isolation
- `entity-resolution.ts` - Scope-aware entity resolution logic
- `entity-silo-test.ts` - Comprehensive test coverage

### 2. Commitment System Overhaul

**Problem Fixed**: Commitments stored as accumulating facts made lifecycle tracking impossible.

**Solution**: New dedicated commitment system with proper status management.

**Features**:
- Status states: `open`, `fulfilled`, `broken`, `cancelled`
- Bi-temporal state reconstruction
- Deduplication within scope
- Full lifecycle tracking

**Files Added**:
- `commitments.ts` - Complete commitment management system

### 3. Three-Verdict Recall Enhancement

**Problem Fixed**: Two-verdict system couldn't distinguish "no answer" from "no evidence".

**Solution**: Added `unresolved` state to the verdict system.

**Verdicts**:
- `answer` - Successfully resolved
- `honest_empty` - No evidence exists
- `unresolved` - Evidence exists but no clear answer (NEW)

**Files Modified**:
- `recall.ts` - Updated interface with three-verdict system
- `recall-enhanced.ts` - Full implementation with fast path

### 4. Fast Recall Path (Class 2)

**Problem Fixed**: Every recall query cost $0.003 in LLM tokens.

**Solution**: Deterministic recall path without LLM.

**Benefits**:
- Zero cost queries ($0 vs $0.003)
- Millisecond response times
- Perfect for real-time applications

**Files Added**:
- `recall-class2.ts` - Deterministic recall implementation

## Performance Improvements

### Database Optimizations

- Scope-based indexes on all tables
- Unique constraints per scope
- Optimized query patterns

### Query Performance

- Hybrid retrieval with relevance gating
- Fast keyword-only honest-empty checks
- Concurrent extraction support

## Architecture Improvements

### Scope Isolation

All tables now support scope-based data isolation:
- `scope_id` column added to relevant tables
- Scope-based unique constraints
- Performance indexes for filtered queries

### Source Provenance

Enhanced tracking:
- Source type classification
- Source reference tracking
- Better attribution in results

## Testing

New test files demonstrate and verify all improvements:
- `entity-silo-test.ts` - Verifies scope isolation
- Additional test patterns for commitments and recall

## Migration Guide

1. Apply database migration:
```bash
psql $DATABASE_URL < migrations/001_entity_silo.sql
```

2. Update code to use scope-based functions:
```typescript
// Old (global)
const entity = await resolveOrCreate(label, type);

// New (scoped)
const entity = await resolveOrCreate(label, type, scopeId);
```

3. Use three-verdict system:
```typescript
if (result.type === "unresolved") {
  // Handle new verdict type
}
```

## Backward Compatibility

All changes are backward compatible:
- Functions accept optional `scopeId` parameter
- Existing code continues to work (global scope)
- New verdict type is an addition, not a replacement

## Important Notes

- All examples use generic names (UserA, ProjectAlpha, etc.)
- No company or customer references remain
- This is a technical improvement package
- Fully compatible with existing mnemon-os installations

## Verification

Run verification to ensure no sensitive data:
```bash
# Should return 0 results
grep -r "Phrase\|CSM\|Customer\|Acme\|Centific" .
```

## License

MIT (same as original mnemon-os)