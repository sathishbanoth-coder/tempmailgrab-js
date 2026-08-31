# Contributing

Issues and focused pull requests are welcome. Before opening a pull request:

1. Run `npm ci`.
2. Run `npm run typecheck && npm test && npm run build`.
3. Add tests for behavioral changes.
4. Do not commit API keys or real inbox contents.

The SDK intentionally has zero runtime dependencies. Proposals that add one
should explain why the platform Fetch and Web Crypto APIs are insufficient.
