package com.opendex.tools;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Where the file manager may go on the phone — enforced HERE, on the device, whatever the backend asked.
 *
 * adbd's shell user can read far more than a file manager should show (other apps' data on debuggable builds, /proc,
 * /system…). The backend already refuses paths outside its allow-list, but the device checks again, after resolving
 * symlinks: {@code /sdcard/x -> /data/data/…} (a link an app can plant on shared storage) resolves outside the roots and
 * is refused. Removing or renaming a volume's top folders ({@code /storage/emulated/0}, {@code …/Android}) is refused
 * too: no one wants that, and a mis-click must not be able to do it.
 *
 * Pure Java (java.nio.file), so every rule is exercised on a plain JVM with real temp directories.
 */
final class FsPolicy {

    private final List<String> lexicalRoots;
    private final List<String> canonicalRoots = new ArrayList<>();
    private final List<Pattern> protectedPaths;

    FsPolicy(List<String> browsableRoots, List<Pattern> protectedPaths) {
        this.lexicalRoots = new ArrayList<>(browsableRoots);
        this.protectedPaths = new ArrayList<>(protectedPaths);
        for (String root : browsableRoots) {
            canonicalRoots.add(root);
            try {
                canonicalRoots.add(Paths.get(root).toRealPath().toString());   // /sdcard -> /storage/emulated/0 …
            } catch (IOException ignored) {}
        }
    }

    /** What a phone is browsed under, and what may never be removed or renamed. */
    static FsPolicy android() {
        return new FsPolicy(
                Arrays.asList("/sdcard", "/storage", "/data/local/tmp"),
                Arrays.asList(
                        Pattern.compile("/"),
                        Pattern.compile("/storage"),
                        Pattern.compile("/storage/emulated"),
                        Pattern.compile("/storage/emulated/\\d+"),
                        Pattern.compile("/storage/[^/]+"),                       // an SD card / USB volume itself
                        Pattern.compile("/storage/[^/]+/Android"),
                        Pattern.compile("/storage/[^/]+/Android/(data|obb|media)"),
                        Pattern.compile("/storage/emulated/\\d+/Android"),
                        Pattern.compile("/storage/emulated/\\d+/Android/(data|obb|media)"),
                        Pattern.compile("/sdcard"),
                        Pattern.compile("/data/local/tmp")));
    }

    /** Normalised absolute path with `.`/`..` resolved, or a bad_request / outside_roots failure. Touches no file. */
    String lexical(String raw) throws FsOps.Failure {
        if (raw == null || raw.isEmpty() || raw.indexOf('\0') >= 0 || raw.indexOf('\n') >= 0 || raw.indexOf('\r') >= 0) {
            throw new FsOps.Failure("bad_request", "invalid path");
        }
        if (raw.getBytes(StandardCharsets.UTF_8).length > FsWire.MAX_PATH_BYTES || raw.charAt(0) != '/') {
            throw new FsOps.Failure("bad_request", "path must be absolute and at most " + FsWire.MAX_PATH_BYTES + " bytes");
        }
        String normal = Paths.get(raw).normalize().toString();
        if (!within(normal, lexicalRoots)) throw new FsOps.Failure("outside_roots", normal);
        return normal;
    }

    /** The real path of an existing entry, FOLLOWING links, which must still lie inside the roots. */
    Path existing(String raw) throws FsOps.Failure {
        String normal = lexical(raw);
        try {
            Path real = Paths.get(normal).toRealPath();
            if (!within(real.toString(), canonicalRoots)) throw new FsOps.Failure("outside_roots", real.toString());
            return real;
        } catch (NoSuchFileException e) {
            throw new FsOps.Failure("not_found", normal);
        } catch (IOException e) {
            throw FsOps.fail(e);
        }
    }

    /**
     * The entry itself, NOT following a link in the last component: for delete / rename, where the link is the
     * thing to remove. Only the parent is resolved (and must be inside the roots); the leaf name is kept.
     */
    Path entry(String raw) throws FsOps.Failure {
        String normal = lexical(raw);
        Path path = Paths.get(normal);
        Path parent = path.getParent();
        if (parent == null || path.getFileName() == null) throw new FsOps.Failure("permission", "root");
        Path realParent = existing(parent.toString());
        Path entry = realParent.resolve(path.getFileName().toString());
        if (!Files.exists(entry, LinkOption.NOFOLLOW_LINKS)) throw new FsOps.Failure("not_found", normal);
        return entry;
    }

    /** Where a NEW entry would go: its parent must exist inside the roots; the leaf must be a plain name. */
    Path forCreate(String raw) throws FsOps.Failure {
        String normal = lexical(raw);
        Path path = Paths.get(normal);
        Path parent = path.getParent();
        if (parent == null || path.getFileName() == null) throw new FsOps.Failure("permission", "root");
        String leaf = path.getFileName().toString();
        if (leaf.length() > 255 || leaf.getBytes(StandardCharsets.UTF_8).length > 255) {
            throw new FsOps.Failure("invalid_name", "name over 255 bytes");
        }
        return existing(parent.toString()).resolve(leaf);
    }

    /**
     * Where a new folder AND its missing parents would go ({@code mkdir -p}): the deepest ancestor that exists must lie
     * inside the roots (links resolved); the missing part is plain names appended to it.
     */
    Path forCreateWithParents(String raw) throws FsOps.Failure {
        Path path = Paths.get(lexical(raw));
        Path existing = path;
        while (existing != null && !Files.exists(existing)) existing = existing.getParent();
        if (existing == null) throw new FsOps.Failure("not_found", raw);
        Path result = existing(existing.toString());
        for (Path part : existing.relativize(path)) {
            String name = part.toString();
            if (name.isEmpty() || name.getBytes(StandardCharsets.UTF_8).length > 255) {
                throw new FsOps.Failure("invalid_name", "name over 255 bytes");
            }
            result = result.resolve(name);
        }
        return result;
    }

    boolean isProtected(Path path) {
        String text = path.toString();
        for (Pattern pattern : protectedPaths) {
            if (pattern.matcher(text).matches()) return true;
        }
        return false;
    }

    static boolean within(String path, List<String> roots) {
        for (String root : roots) {
            if (path.equals(root) || path.startsWith(root.endsWith("/") ? root : root + "/")) return true;
        }
        return false;
    }
}
