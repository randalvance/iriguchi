// Ensure deterministic env for tests
process.env.IRI_API_KEY ||= "test-api-key";
process.env.IRI_REGISTRATION_SECRET ||= "test-registration-secret";
process.env.IRI_PROVIDER_ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.IRI_PROVIDER_ANTHROPIC_BASE_URL ||= "https://api.anthropic.com";
process.env.IRI_DEFAULT_PROVIDER ||= "anthropic";
process.env.IRI_DEFAULT_MODEL ||= "claude-sonnet-4-6";
process.env.IRI_DB_PATH ||= ":memory:";
process.env.IRI_TMP_DIR ||= "/tmp/iri-test";
