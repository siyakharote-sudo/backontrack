# Back on Track (Vercel deploy)

This project is a static frontend (no build step) + a Vercel Serverless API used by the Doubt Solver.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **New Project** → import the repo.
3. Set **Environment Variables**:
   - `ANTHROPIC_API_KEY` (required)
4. Deploy.

No build command is needed.

## Endpoints (after deploy)

- `GET /api/health` → `{ ok: true }`
- `POST /api/ask` with JSON:

```json
{ "subject": "Math", "question": "What is 2+2?" }
```

Response:

```json
{ "text": "..." }
```

