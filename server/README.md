## Anthropic proxy (local)

### Run

In PowerShell:

```powershell
$env:ANTHROPIC_API_KEY="YOUR_KEY_HERE"
node .\server.js
```

Optional:

```powershell
$env:PORT="3001"
```

### Endpoints

- `GET /health` → `{ ok: true }`
- `POST /api/ask` body: `{ "subject": "...", "doubt": "..." }`

