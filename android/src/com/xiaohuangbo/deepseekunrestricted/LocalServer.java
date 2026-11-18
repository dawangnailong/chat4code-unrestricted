package com.xiaohuangbo.deepseekunrestricted;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Serves the built web app from assets over http://127.0.0.1:18765.
 *
 * A real HTTP origin (rather than file://) gives localStorage, IndexedDB and
 * fetch a stable origin, and also matches the MCP backend's allowed origins.
 */
final class LocalServer implements Closeable {
    private final Context context;
    private final int port;
    private final ExecutorService pool = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "local-assets");
            thread.setDaemon(true);
            return thread;
        }
    });
    private volatile boolean running;
    private ServerSocket serverSocket;

    LocalServer(Context context, int port) {
        this.context = context.getApplicationContext();
        this.port = port;
    }

    void start() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        serverSocket = socket;
        running = true;
        Thread accept = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        final Socket client = socket.accept();
                        pool.execute(new Runnable() {
                            @Override
                            public void run() {
                                handle(client);
                            }
                        });
                    } catch (IOException error) {
                        if (running) {
                            // Socket closed while shutting down; otherwise ignore one bad client.
                        }
                    }
                }
            }
        }, "local-assets-accept");
        accept.setDaemon(true);
        accept.start();
    }

    private void handle(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(15000);
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1)
            );
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                // Drain request headers; GET/HEAD have no body in this server.
            }

            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.ROOT) : "GET";
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                sendText(client.getOutputStream(), 405, "Method Not Allowed", "Method Not Allowed");
                return;
            }

            String rawPath = parts.length > 1 ? parts[1] : "/";
            int query = rawPath.indexOf('?');
            if (query >= 0) {
                rawPath = rawPath.substring(0, query);
            }
            String path;
            try {
                path = URLDecoder.decode(rawPath, "UTF-8");
            } catch (Exception error) {
                sendText(client.getOutputStream(), 400, "Bad Request", "Bad Request");
                return;
            }
            path = path.replace('\\', '/');
            if (path.contains("..") || path.indexOf('\0') >= 0) {
                sendText(client.getOutputStream(), 403, "Forbidden", "Forbidden");
                return;
            }
            if (!path.startsWith("/")) {
                path = "/" + path;
            }
            if (path.equals("/") || path.endsWith("/")) {
                path += "index.html";
            }

            AssetManager assets = context.getAssets();
            byte[] body = readAsset(assets, "public" + path);
            if (body == null && !hasExtension(path)) {
                body = readAsset(assets, "public/index.html");
            }
            if (body == null) {
                sendText(client.getOutputStream(), 404, "Not Found", "Not Found");
                return;
            }

            String contentType = contentType(path);
            OutputStream output = client.getOutputStream();
            String header = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
            output.write(header.getBytes(StandardCharsets.ISO_8859_1));
            if (!"HEAD".equals(method)) {
                output.write(body);
            }
            output.flush();
        } catch (Exception ignored) {
            // A broken asset request must not take down the accept loop.
        }
    }

    private static byte[] readAsset(AssetManager assets, String name) {
        try (InputStream input = assets.open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } catch (FileNotFoundException error) {
            return null;
        } catch (IOException error) {
            return null;
        }
    }

    private static boolean hasExtension(String path) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        return name.indexOf('.') > 0;
    }

    private static String contentType(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        switch (ext) {
            case "html":
            case "htm":
                return "text/html; charset=utf-8";
            case "js":
            case "mjs":
                return "application/javascript; charset=utf-8";
            case "css":
                return "text/css; charset=utf-8";
            case "json":
            case "map":
                return "application/json; charset=utf-8";
            case "txt":
                return "text/plain; charset=utf-8";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "gif":
                return "image/gif";
            case "webp":
                return "image/webp";
            case "ico":
                return "image/x-icon";
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "ttf":
                return "font/ttf";
            case "wasm":
                return "application/wasm";
            default:
                return "application/octet-stream";
        }
    }

    private static void sendText(OutputStream output, int status, String reason, String text)
        throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.ISO_8859_1));
        output.write(body);
        output.flush();
    }

    @Override
    public void close() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
        pool.shutdownNow();
    }
}
