// Ensure deterministic env for tests
process.env.IRI_API_KEY ||= "test-api-key";
process.env.IRI_REGISTRATION_SECRET ||= "test-registration-secret";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.IRI_DEFAULT_MODEL ||= "claude-sonnet-4-6";
process.env.IRI_DB_PATH ||= ":memory:";
