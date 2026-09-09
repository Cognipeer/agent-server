# Contributing

Thank you for your interest in contributing to `@cognipeer/agent-server`.

Agent Server docs live under `docs/` and are rendered with VitePress using the shared Cognipeer docs shell.

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

4. Run docs locally:

```bash
npm run docs:dev
```

## Project Areas

- `src/`: runtime source for the server, adapters, and providers
- `docs/`: VitePress documentation source
- `examples/`: integration examples and sample server setups

## Documentation

- Theme config: `docs/.vitepress/config.mts`
- Theme styling: `docs/.vitepress/theme/`
- Public docs assets: `docs/public/`

## Running Tests

```bash
npm test
```

## Building

```bash
npm run build
npm run docs:build
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
4. Run tests, linting, and docs build where relevant
5. Submit a pull request

## Reporting Issues

Please report bugs and feature requests on [GitHub Issues](https://github.com/Cognipeer/agent-server/issues).
