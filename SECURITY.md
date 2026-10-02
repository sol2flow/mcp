# Security

Report vulnerabilities privately to **info@sol2flow.com**. Do not open public issues. Please include the version
(`sol2flow-mcp --version` or the image tag), how you run it (stdio, HTTP, the hosted server) and the steps to reproduce.

What the server does to protect you:

- **Your key, your permissions.** Every call goes to the sol2flow REST API with your API key; the API applies the
  plan, the key's scope, the workspace's API switch and your roles. A read-only key can't change anything.
- **No secrets on the command line or in logs.** The key comes from `SOL2FLOW_API_KEY` (or a file), never a flag; logs
  carry only its public 8-character prefix, never the key, tool arguments or results.
- **Nothing stored.** No keys, no content. In HTTP mode only fingerprints of refused keys (5 minutes) and per-IP
  counters live in memory; resolved references are cached in memory for 10 minutes per key fingerprint.
- **HTTP mode:** stateless; the upstream URL is fixed by the operator (no SSRF); `Host` and `Origin` checks against DNS
  rebinding; body, time and concurrency limits; per-IP limits on rejected keys.
- **Writes are never retried,** so a timeout can't apply a change twice.
- **Error tracking** (image only, opt-in) sends no requests, headers, bodies, arguments, results or user data.

The REST API's own measures (hashed keys, expiry, revocation, rate limits): the app's
[SECURITY.md](https://github.com/sol2flow/sol2flow/blob/main/SECURITY.md).
