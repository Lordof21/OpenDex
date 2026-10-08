package com.opendex.tools;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Test-only: the daemon's real {@code FsService} (the class that holds the Android types, so it needs android-all.jar on the
 * class path) on a temporary tree, over stdin/stdout: a line {@code #<id> fs_…} in, one JSON line out. Started by
 * backend/tests/test_fs_real_daemon.py when OPENDEX_ANDROID_JAR is set.
 *
 * <pre>
 *   java -cp <classes>:<android-all.jar> com.opendex.tools.FsHarness <root>
 *   <root>/storage/emulated/0   the "internal volume"      <root>/tmp   the adb scratch folder
 * </pre>
 */
public final class FsHarness {
    public static void main(String[] args) throws Exception {
        Path root = Paths.get(args[0]).toRealPath();
        Path storage = root.resolve("storage");
        Path tmp = root.resolve("tmp");
        String internal = Pattern.quote(storage + "/emulated/0");
        FsPolicy policy = new FsPolicy(
                Arrays.asList(storage.toString(), tmp.toString()),
                Arrays.asList(Pattern.compile(internal), Pattern.compile(internal + "/Android"), Pattern.compile(internal + "/Android/data"),
                        Pattern.compile(Pattern.quote(storage.toString())), Pattern.compile(Pattern.quote(tmp.toString()))));
        final FsService fs = new FsService(policy, storage, tmp, 3, 16);
        final PrintStream out = new PrintStream(System.out, true, "UTF-8");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            String id = null;
            if (line.startsWith("#")) {
                int space = line.indexOf(' ');
                id = line.substring(1, space);
                line = line.substring(space + 1);
            }
            final String requestId = id;
            fs.handle(line, new FsService.Reply() {
                @Override
                public void send(JSONObject response) {
                    if (requestId != null) Json.put(response, "req_id", requestId);
                    synchronized (out) {
                        out.println(response.toString());
                    }
                }
            });
        }
    }
}
