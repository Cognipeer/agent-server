# Contributing

Thank you for your interest in contributing to `@cognipeer/agent-server`!

## Development Setup

1. Clone the repository:

```bash
git clone https://github.com/Cognipeer/agent-server.git
cd agent-server
```

2. Install dependencies:

```bash
npm install
```

3. Start development mode:

```bash
npm run dev
```

## Running Tests

```bash
npm test
```

The storage tests (`test/storage/`, and the human-in-the-loop tests) run against **all four storage providers** with real
databases: memory, SQLite (`better-sqlite3`), MongoDB and PostgreSQL. Nothing needs to be set up by hand:

- MongoDB: `mongodb-memory-server` starts a `mongod` (`MONGOMS_VERSION`, default 7.0.14). Set `MONGODB_URL` to use a server you run instead.
- PostgreSQL: set `PG_URL` to use a server you run; otherwise the tests start one throwaway `postgres:16-alpine` docker container on a random
  port and remove it afterwards. `AGENT_SERVER_TEST_PG=off` skips it.
- A provider that cannot run on your machine is reported as a **skipped** suite with the reason. CI sets `REQUIRE_ALL_PROVIDERS=1`, which turns every skip into a failure.

`runStorageContract` (`test/storage/contract.ts`) is the provider contract; a new provider (or a change to an existing one) must pass it. See
[Custom Storage](/guide/custom-storage).

## Building

```bash
npm run build
```

## Code Style

We use ESLint for code linting:

```bash
npm run lint
```

## Pull Requests

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## Reporting Issues

Please report bugs and feature requests on [GitHub Issues](https://github.com/Cognipeer/agent-server/issues).
