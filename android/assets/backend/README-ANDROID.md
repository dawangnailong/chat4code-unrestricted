# Bundled backend sources

The APK bundles the Python MCP backend and EasyJailbreak sources for reference.
They are **not executed inside Android**: the runtime depends on Python, torch,
transformers and other native packages that cannot be packaged into a normal
WebView APK.

To use the jailbreak lab from the Android app, run the backend on a PC:

```sh
cd mcp-server
./run.sh            # http://127.0.0.1:8765/mcp
```

Then open **实验台** in the app, replace the endpoint with
`http://<PC-LAN-IP>:8765/mcp`, and connect. The app's local origin is
`http://127.0.0.1:18765`, which is already in the backend's allowed origins.
