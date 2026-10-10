"""HTTP MCP transport — JSON-RPC 2.0 over HTTP POST.

Flow: initialize -> tools/list / tools/call. Supports the streamable-HTTP MCP
endpoints (single POST returning either application/json or an SSE
`text/event-stream` body, both of which we parse for the JSON-RPC reply).

`$ENV_VAR` references in headers (and URL) are expanded from the process
environment so secrets live in env, not the config file. 2-minute timeout;
response bodies are capped at MAX_BODY_BYTES (read as a stream, aborted past it).

Errors are raised as `MCPError(code, message)`; main.py renders the unified
{"error","code","server"} envelope.
"""

import json
import os
import re

try:
    import httpx
except ImportError:  # pragma: no cover - the sh wrapper installs httpx first
    httpx = None

TIMEOUT_SECONDS = 120  # 2 min
# A response body larger than this is refused while it streams in, so a 50 MB
# tool result can't balloon the guest (and then the agent context).
MAX_BODY_BYTES = 4 * 1024 * 1024

# $VAR and $$VAR both expand from the process env; the UI picker emits $$VAR to
# make a reference visually explicit. The optional second `$` is consumed in the
# same match (no double-expansion), so $$VAR / $${VAR} resolve identically to
# $VAR / ${VAR}.
_ENV_RE = re.compile(r"\$\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?")


class MCPError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def expand_env(value):
    """Replace $VAR / ${VAR} / $$VAR / $${VAR} with the environment value.

    A MISSING variable raises instead of silently substituting "" — the empty
    string used to flow into `?key=` and come back as a bare 401 the agent
    could do nothing with, while the native client's error names the variable
    and where to set it. Both paths now fail the same, actionable way."""
    if not isinstance(value, str):
        return value
    missing = []

    def _sub(m):
        name = m.group(1)
        got = os.environ.get(name)
        if got is None:
            missing.append(name)
            return ""
        return got

    out = _ENV_RE.sub(_sub, value)
    if missing:
        raise MCPError(
            "MISSING_ENV",
            "config references undefined environment variable(s): %s. "
            "Add them in the app under Settings > Environment Variables, or "
            "replace $$NAME with a literal value." % ", ".join(sorted(set(missing)))
        )
    return out


def _expand_headers(headers):
    out = {}
    for k, v in (headers or {}).items():
        out[k] = expand_env(v)
    return out


def _rpc_error_message(err):
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str) and msg:
            return msg
        return json.dumps(err, ensure_ascii=False)[:2000]
    return str(err)[:2000]


def _read_capped(resp, limit=MAX_BODY_BYTES):
    """Read a streamed httpx response, refusing bodies over `limit` bytes."""
    declared = resp.headers.get("content-length")
    try:
        if declared is not None and int(declared) > limit:
            raise MCPError("RESPONSE_TOO_LARGE",
                           "response of %s bytes exceeds the %d MB limit" % (declared, limit // (1024 * 1024)))
    except ValueError:
        pass
    chunks = []
    total = 0
    for chunk in resp.iter_bytes():
        total += len(chunk)
        if total > limit:
            raise MCPError("RESPONSE_TOO_LARGE",
                           "response exceeded the %d MB limit" % (limit // (1024 * 1024)))
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", errors="replace")


def _parse_response(ctype, text):
    """Extract the JSON-RPC object from either a JSON body or an SSE stream."""
    if "text/event-stream" in ctype:
        # SSE: pull the last `data:` payload that parses as JSON-RPC.
        result = None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                try:
                    result = json.loads(payload)
                except ValueError:
                    continue
        if result is None:
            raise MCPError("PARSE_ERROR", "no JSON-RPC payload in SSE stream")
        return result
    try:
        return json.loads(text)
    except ValueError as exc:
        raise MCPError("PARSE_ERROR", "invalid JSON response: %s" % exc)


# --- OAuth token bridge ------------------------------------------------------
#
# [T-mcp-static-oauth] Servers whose config carries an `oauth` object are
# authorized natively (the app runs the PKCE Authorization Code flow and owns
# the Keychain-backed credentials). The native side materializes a token
# bridge file the guest can read:
#
#     /var/minis/mcp-servers/oauth/<server>.json
#     { "access_token": "...", "expires_at": 1789999999,
#       "refresh_token": "...", "token_endpoint": "https://...",
#       "client_id": "...", "client_secret": "..." }        # secret optional
#
# The transport attaches `Authorization: Bearer <access_token>` and, on 401 or
# a token that is already past `expires_at`, performs a standard
# refresh_token grant against `token_endpoint` and rewrites the bridge file
# (so the native side and later calls see the fresh token). If refresh is
# impossible/fails, AUTH_REQUIRED tells the agent/user to re-authorize in
# Settings → MCP Integrations. The bridge file lives OUTSIDE servers.json on
# purpose: servers.json syncs across devices via iCloud, tokens must not.

OAUTH_DIR = "/var/minis/mcp-servers/oauth"


def _oauth_token_path(server_name):
    return os.path.join(OAUTH_DIR, "%s.json" % server_name)


def _authorize_deeplink(server_name):
    """[T-mcp-oauth-deeplink] Markdown link that jumps straight to the
    server's edit form in the app (where the Authorize button is). The agent
    relays error text verbatim, so chat renders this as a tappable link.
    Server names may contain URL-unsafe chars — percent-encode the path
    segment; the iOS/Android deep-link routers decode it back."""
    from urllib.parse import quote
    return "[Authorize](leophoneagent://settings/mcp-servers/%s)" % quote(server_name, safe="")


def _load_oauth_tokens(server_name):
    try:
        with open(_oauth_token_path(server_name), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _save_oauth_tokens(server_name, tokens):
    try:
        os.makedirs(OAUTH_DIR, exist_ok=True)
        tmp = _oauth_token_path(server_name) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(tokens, f)
        os.replace(tmp, _oauth_token_path(server_name))
        try:
            os.chmod(_oauth_token_path(server_name), 0o600)
        except OSError:
            pass
    except OSError:
        pass  # best-effort; next call refreshes again


class HTTPTransport:
    def __init__(self, server, server_name):
        self.url = expand_env(server.get("url", ""))
        self.headers = _expand_headers(server.get("headers"))
        self.server_name = server_name
        self.oauth_cfg = server.get("oauth") if isinstance(server.get("oauth"), dict) else None
        self._id = 0
        self._session_id = None

    def _next_id(self):
        self._id += 1
        return self._id

    # -- OAuth helpers -------------------------------------------------------

    def _oauth_access_token(self, force_refresh=False):
        """Current access token for an oauth server, refreshing if expired or
        forced. Raises AUTH_REQUIRED when no usable token can be produced."""
        tokens = _load_oauth_tokens(self.server_name)
        if not tokens or not tokens.get("access_token"):
            raise MCPError("AUTH_REQUIRED", (
                "server '%s' uses OAuth but has no stored token — tap %s to "
                "open its settings page and sign in"
                % (self.server_name, _authorize_deeplink(self.server_name))))
        import time as _time
        expired = False
        exp = tokens.get("expires_at")
        if isinstance(exp, (int, float)) and exp > 0:
            expired = _time.time() > (exp - 60)  # refresh 60s early
        if force_refresh or expired:
            refreshed = self._oauth_refresh(tokens)
            if refreshed:
                return refreshed["access_token"]
            if force_refresh or expired:
                raise MCPError("AUTH_REQUIRED", (
                    "server '%s' OAuth token expired and refresh failed — "
                    "tap %s to re-authorize"
                    % (self.server_name, _authorize_deeplink(self.server_name))))
        return tokens["access_token"]

    def _oauth_refresh(self, tokens):
        """refresh_token grant → rewrite the bridge file. Returns the new token
        dict or None."""
        refresh_token = tokens.get("refresh_token")
        token_endpoint = tokens.get("token_endpoint")
        client_id = tokens.get("client_id")
        if not (refresh_token and token_endpoint and client_id) or httpx is None:
            return None
        form = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        }
        if tokens.get("client_secret"):
            form["client_secret"] = tokens["client_secret"]
        # [T-mcp-oauth-resource] RFC 8707 Resource Indicator, required by the
        # MCP auth spec on every token request. The native side writes the
        # canonical server URI into the bridge file; reuse it verbatim.
        if tokens.get("resource"):
            form["resource"] = tokens["resource"]
        try:
            resp = httpx.post(token_endpoint, data=form, timeout=30)
        except httpx.HTTPError:
            return None
        if resp.status_code >= 400:
            return None
        try:
            payload = resp.json()
        except ValueError:
            return None
        access = payload.get("access_token")
        if not access:
            return None
        import time as _time
        new_tokens = dict(tokens)
        new_tokens["access_token"] = access
        # Some providers rotate the refresh token on every grant.
        if payload.get("refresh_token"):
            new_tokens["refresh_token"] = payload["refresh_token"]
        if payload.get("expires_in"):
            try:
                new_tokens["expires_at"] = int(_time.time()) + int(payload["expires_in"])
            except (TypeError, ValueError):
                pass
        _save_oauth_tokens(self.server_name, new_tokens)
        return new_tokens

    def _post(self, method, params=None, notify=False, _oauth_retried=False):
        if httpx is None:
            raise MCPError("CONNECTION_ERROR", "httpx unavailable")
        body = {"jsonrpc": "2.0", "method": method}
        if not notify:
            body["id"] = self._next_id()
        if params is not None:
            body["params"] = params
        # Force the MCP Streamable HTTP (2025-03-26) required Accept and
        # Content-Type regardless of how the user configured server.headers.
        # setdefault is case-sensitive, so a user-supplied "accept" /
        # "content-type" (any casing) or an incomplete Accept that omits
        # text/event-stream would slip through and some gateways reject it
        # (e.g. 401 "oauth token is not found"). Drop any case-variant of these
        # two keys, then set the canonical values; all other headers
        # (Authorization, etc.) keep their original casing and value.
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in ("accept", "content-type")
        }
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/json, text/event-stream"
        # [T-mcp-static-oauth] OAuth servers get their Authorization from the
        # native-materialized token bridge, overriding any static header.
        if self.oauth_cfg is not None:
            headers["Authorization"] = "Bearer %s" % self._oauth_access_token(
                force_refresh=_oauth_retried)
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        try:
            with httpx.stream(
                "POST", self.url, json=body, headers=headers, timeout=TIMEOUT_SECONDS
            ) as resp:
                status = resp.status_code
                ctype = resp.headers.get("content-type", "")
                # Capture a session id handed back by the server (streamable-HTTP).
                sid = resp.headers.get("mcp-session-id")
                if sid:
                    self._session_id = sid
                retry_auth = status == 401 and self.oauth_cfg is not None and not _oauth_retried
                text = "" if retry_auth else _read_capped(resp)
        except httpx.TimeoutException:
            raise MCPError("TIMEOUT", "request timed out after %ds" % TIMEOUT_SECONDS)
        except httpx.HTTPError as exc:
            raise MCPError("CONNECTION_ERROR", str(exc))
        # [T-mcp-static-oauth] 401 on an oauth server: refresh once and retry
        # the same request; a second 401 falls through to AUTH_REQUIRED via
        # _oauth_access_token(force_refresh=True) on the retry, or to the
        # generic error below if refresh succeeded but the server still 401s.
        if retry_auth:
            return self._post(method, params=params, notify=notify, _oauth_retried=True)
        if status >= 400:
            raise MCPError(
                "CONNECTION_ERROR", "HTTP %d: %s" % (status, text[:200])
            )
        if notify:
            return None
        rpc = _parse_response(ctype, text)
        if isinstance(rpc, dict) and rpc.get("error") is not None:
            raise MCPError("MCP_ERROR", _rpc_error_message(rpc["error"]))
        return rpc.get("result") if isinstance(rpc, dict) else rpc

    def initialize(self):
        result = self._post(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "leophoneagent-mcp-cli", "version": "1.0.0"},
            },
        )
        # MCP requires a notifications/initialized after a successful init.
        try:
            self._post("notifications/initialized", notify=True)
        except MCPError:
            pass
        return result

    def list_tools(self):
        self.initialize()
        result = self._post("tools/list")
        return (result or {}).get("tools", [])

    def call_tool(self, tool, arguments):
        self.initialize()
        return self._post("tools/call", {"name": tool, "arguments": arguments or {}})

    def ping(self):
        """Round-trip initialize as a reachability check."""
        self.initialize()
        return True
