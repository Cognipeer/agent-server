# Standalone example

A complete `@cognipeer/agent-server` as its own process: an agent-sdk agent (tools that need approval, questions, the conversation's files, cancel), a
host-backed agent (`registerHostAgent`), Swagger UI, CORS for a browser UI, and storage on **SQLite** or **MongoDB**.
The end-to-end tests (`test/example.test.ts` in this repository) start exactly this.

```bash
cd examples/standalone
npm install                       # @cognipeer/agent-server comes from ../.. (run `npm run build` there first), or from a tarball:
                                  #   npm install ../../../.local-packages/cognipeer-agent-server-0.3.0.tgz

npm run start:sqlite              # a file database: ./data/example.db (SQLITE_FILE)
npm run start:mongodb             # MONGODB_URL, or an in-memory MongoDB when it is not set (mongodb-memory-server)
```

```
agent-server example: storage sqlite, agents assistant, host-echo
docs:  http://127.0.0.1:4310/api/agents/docs
api:   http://127.0.0.1:4310/api/agents
```

| Setting | Default | |
| --- | --- | --- |
| `PORT` | `4310` | `0` takes a free port; the banner prints the URL |
| `HOST` | `127.0.0.1` | |
| `STORAGE` | `sqlite` | `sqlite`, `mongodb` or `memory` |
| `SQLITE_FILE` | `./data/example.db` | `:memory:` for a throwaway database |
| `MONGODB_URL`, `MONGODB_DB` | in-memory server, `agent_server_example` | |
| `BASE_PATH` | `/api/agents` | |
| `CORS_ORIGINS` | `*` | comma-separated origins allowed to call the API from a browser |
| `BUDGET_USD` | none | a spend limit for every new conversation (the scripted model is priced, so it counts) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | none | an OpenAI-compatible API. Without `LLM_BASE_URL` the agents use a scripted model: no key, same answers every time |
| `MOCK_SLOW_MS` | `4000` | how long a "slow" message takes |

## Try it

The scripted model reacts to what you type:

| Say | It does |
| --- | --- |
| `hello` | answers `You said: "hello"` (streamed word by word) |
| `deploy web` | calls `deploy_service`, which pauses for **your approval**; answer with `POST .../actions/:id` |
| `ask me something` | asks a question (staging or production) |
| `what is in my files?` | lists and reads the files you uploaded to the conversation |
| `slow please` | takes four seconds - long enough to `POST .../cancel`, or to reload the page and follow the run |

The `host-echo` agent shows `registerHostAgent`: it streams with `emit`, and `deploy <service>` makes it return `pendingActions`.

```bash
API=http://127.0.0.1:4310/api/agents

ID=$(curl -s -X POST $API/conversations -H 'content-type: application/json' -d '{"agentId":"assistant"}' | jq -r .conversation.id)

# a streamed turn
curl -N -X POST $API/conversations/$ID/messages -H 'content-type: application/json' -d '{"message":"hello","stream":true}'

# an approval
curl -s -X POST $API/conversations/$ID/messages -H 'content-type: application/json' -d '{"message":"deploy web"}' | jq '.pendingActions[0].id'
curl -s -X POST $API/conversations/$ID/actions/<that id> -H 'content-type: application/json' \
  -d '{"resolution":{"type":"tool_approval","decision":"allow"}}' | jq .response.content

# a file
curl -s -X POST "$API/files?name=notes.txt&conversationId=$ID" -H 'content-type: text/plain' --data-binary 'the launch code is 4242'
curl -s -X POST $API/conversations/$ID/messages -H 'content-type: application/json' -d '{"message":"what is in my files?"}' | jq .response.content

# follow what a conversation does, from any client, and stop it
curl -N $API/conversations/$ID/events/stream
curl -s -X POST $API/conversations/$ID/cancel
```

## Who is asking

Listing conversations needs to know the user (see `allowAnonymousList`), so the example resolves one for every request: the `X-User-Id` header, else
`demo-user`. That is the place to put your own sign-in (`resolveContext` in `app.ts`). Conversations belong to the user who made them; another user gets 403 on them and
does not see them in the list.

## With the chat UI

The server allows any origin, `Last-Event-ID` and `X-User-Id`, so a `@cognipeer/chat-ui` page on another port can talk to it directly:
`<Chat baseUrl="http://127.0.0.1:4310/api/agents" agentId="assistant" />` (add `headers={{ "X-User-Id": "alice" }}` to be somebody else).

## Files

| | |
| --- | --- |
| `server.ts` | reads the environment, listens, stops cleanly on SIGINT / SIGTERM |
| `app.ts` | `createExampleServer(options)`: storage, `createAgentServer`, the agents, the Node handler |
| `agent.ts` | the agent-sdk agent, the host-backed agent, the model and the prices |
| `mock-model.ts` | the scripted model |
