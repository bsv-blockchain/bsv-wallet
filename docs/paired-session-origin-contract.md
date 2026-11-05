# Origin-authenticated paired sessions

Before pairing or reconnecting, the wallet reads `GET https://<approved-origin>/api/session/<topic>` and requests redirect rejection. The HTTPS origin is the authority for the session, not the relay or the key signing the QR.

The endpoint must respond directly at that exact canonical URL. Before reading the response body, the wallet requires the final response URL to equal the requested URL and rejects a reported redirect. Missing URL metadata, a different origin, a different path, or an added query fails closed. Native XHR-based fetch implementations may follow redirects despite the requested policy; the final-URL check prevents accepting another endpoint's proof, but does not establish that no intermediate redirect occurred when the runtime does not report the redirect chain.

The endpoint must return a bounded JSON object containing:

```json
{
  "relay": "wss://relay.example",
  "topic": "the-approved-topic",
  "backendIdentityKey": "the-approved-compressed-secp256k1-public-key",
  "protocolID": "[0,\"wallet pairing\"]"
}
```

`topic`, `backendIdentityKey` and the JSON-stringified `protocolID` must exactly match the approved QR or saved connection. The origin must obtain these fields from its own authenticated session record. It must not copy them from a query parameter, relay response or caller-controlled request. A key's self-signature alone does not establish its authority for an HTTPS site.

Deploy the origin endpoint change before releasing this wallet change. Relay-only responses, unknown or expired sessions, and mismatched tuples fail closed: no WebSocket opens. Existing saved sessions also require the matching tuple on reconnect. The server implementation is outside this repository; its deployment and service compatibility have not been verified here. No fallback to a relay-only response is supported.
