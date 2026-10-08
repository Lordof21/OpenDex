package com.opendex.tools;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Mutual challenge–response for the daemon's control socket.
 *
 * <p>The socket is reachable from the host through {@code adb forward tcp:<port> localabstract:…}: the connection is
 * made by adbd (uid shell), so the peer-uid check passes for ANY program on the PC — including a web page that sends
 * an HTTP request to {@code 127.0.0.1:<port>} whose body is a list of daemon commands (a cross-protocol attack on a
 * line-based service). A daemon that runs commands must therefore authenticate its client. The converse holds too: the
 * backend sends it commands that may carry a secret (a Wi-Fi passphrase), so a program that got to the port first must
 * not be taken for the daemon.
 *
 * <p>The daemon is started with a secret ({@code OPENDEX_DAEMON_TOKEN}) that only the backend knows. Neither side ever
 * sends it; each proves it holds it with an HMAC-SHA256 over a message that names the role and both fresh nonces:
 * <pre>
 *   daemon  → client   {"type":"auth_required","nonce":Ns}
 *   client  → daemon   auth HMAC(token, "client|"+Ns) Nc
 *   daemon  → client   {"type":"greeting", …, "auth_proof": HMAC(token, "server|"+Nc+"|"+Ns)}
 * </pre>
 * The role prefixes keep either answer from being replayed as the other, the client's fresh {@code Nc} keeps a recorded
 * proof worthless for the next connection, and nothing else is read from — or told to — a client before it passes.
 *
 * <p>Pure Java; checked against the Python side (backend/app/device/daemon_auth.py) by the cross-language test.
 */
final class DaemonAuth {

    /** The answer line is {@code "auth " + 64 hex + " " + up to 64 hex}; anything longer is not an answer. */
    static final int MAX_ANSWER_LINE = 256;
    static final int MIN_NONCE_CHARS = 16;
    static final int MAX_NONCE_CHARS = 64;

    private static final SecureRandom RANDOM = new SecureRandom();

    private DaemonAuth() {}

    static String newNonce() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return hex(bytes);
    }

    /** A nonce as both sides generate it: lower-case hex, 16–64 characters (so it can never carry a delimiter). */
    static boolean isNonce(String s) {
        if (s == null || s.length() < MIN_NONCE_CHARS || s.length() > MAX_NONCE_CHARS) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    /** What an honest client answers to the daemon's nonce {@code serverNonce}. */
    static String clientAnswer(String token, String serverNonce) {
        return hmacHex(token, "client|" + serverNonce);
    }

    /** What only a holder of the token can put in the greeting, for this client nonce and this server nonce. */
    static String serverProof(String token, String clientNonce, String serverNonce) {
        return hmacHex(token, "server|" + clientNonce + "|" + serverNonce);
    }

    /**
     * The client's nonce when {@code line} is {@code "auth <hex> <clientNonce>"} with the right answer for this token
     * and server nonce (compared in constant time); null for anything else — wrong answer, missing or malformed nonce,
     * an HTTP request line, null.
     */
    static String verifyClientAnswer(String token, String serverNonce, String line) {
        if (token == null || token.isEmpty() || line == null) return null;
        String[] parts = line.trim().split(" ", -1);
        if (parts.length != 3 || !"auth".equals(parts[0]) || !isNonce(parts[2])) return null;
        byte[] presented = parts[1].getBytes(StandardCharsets.UTF_8);
        byte[] expected = clientAnswer(token, serverNonce).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, presented) ? parts[2] : null;
    }

    /** Sets the read deadline of the connection (0 = none): a socket timeout on the daemon, a recorder in tests. */
    interface Deadline {
        void set(int millis) throws IOException;
    }

    /**
     * The two lines the daemon sends before it has greeted anyone. Supplied by the caller: the daemon builds them with
     * org.json like every other message (Json.obj), and this class stays free of JSON — and of Android — so a plain JVM
     * can run the whole handshake.
     */
    interface Frames {
        /** The {@code auth_required} line for this (hex) nonce. */
        String challenge(String serverNonce);

        /** The {@code auth_failed} line. */
        String failure();
    }

    /**
     * The daemon's half of the handshake, on one connection: sends the challenge, accepts exactly one bounded answer line
     * within {@code timeoutMs}, and nothing else is read from — or told to — the client before it passes. A wrong answer
     * is answered with {@code auth_failed}, held back {@code failureDelayMs} to make guessing pointless, and refused.
     *
     * @return the proof of this daemon's own key for the greeting (the client checks it before it sends anything that
     *         may be secret), or null when the client did not pass or did not answer (the caller drops the connection)
     */
    static String serve(String token, BufferedReader in, PrintWriter out, Deadline deadline, Frames frames,
                        int timeoutMs, long failureDelayMs) {
        try {
            String serverNonce = newNonce();
            out.println(frames.challenge(serverNonce));
            out.flush();
            deadline.set(timeoutMs);
            String answer = readBoundedLine(in, MAX_ANSWER_LINE);
            deadline.set(0);
            String clientNonce = verifyClientAnswer(token, serverNonce, answer);
            if (clientNonce != null) return serverProof(token, clientNonce, serverNonce);
            out.println(frames.failure());
            out.flush();
            Thread.sleep(failureDelayMs);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (IOException | RuntimeException noAnswer) {
            // timed out, an overlong line, a closed socket: nobody passed
        }
        return null;
    }

    /** hex(HMAC-SHA256(token, message)). */
    static String hmacHex(String token, String message) {
        if (token == null || token.isEmpty()) throw new IllegalArgumentException("empty token");
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    /**
     * One line of at most {@code max} characters, without the line break; null at end of stream. Bounded on purpose:
     * before authentication a client must not be able to make the daemon buffer an endless line.
     *
     * @throws IOException when the line is longer than {@code max}
     */
    static String readBoundedLine(Reader in, int max) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') return sb.toString().replace("\r", "");
            if (sb.length() >= max) throw new IOException("line longer than " + max);
            sb.append((char) c);
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = digits[(bytes[i] >> 4) & 0xF];
            out[i * 2 + 1] = digits[bytes[i] & 0xF];
        }
        return new String(out);
    }
}
