import '@testing-library/jest-dom/vitest';

// Persistence tests run against `fake-indexeddb`, so a draft's survival across a reload
// is actually exercised rather than mocked (§12).
import 'fake-indexeddb/auto';
