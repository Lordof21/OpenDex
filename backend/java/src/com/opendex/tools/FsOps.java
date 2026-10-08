package com.opendex.tools;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.AccessDeniedException;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The file operations of the daemon's {@code fs_*} commands, on plain values — no JSON, no Android types, so a plain
 * JVM checks them against real directories (symlinks, odd names, big folders, races). {@link FsPolicy} decides WHERE;
 * this class does the work and turns every failure into one of the backend's error codes ({@link Failure#code}).
 */
final class FsOps {

    static final int F_SYMLINK = 1;
    static final int F_HIDDEN = 2;

    private FsOps() {}

    /** A failed operation: {@code code} is one of the backend's FsError codes. */
    static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;
        final String detail;

        Failure(String code, String detail) {
            super(code + (detail == null ? "" : ": " + detail));
            this.code = code;
            this.detail = detail;
        }
    }

    static final class Item {
        final String name;
        final boolean dir;
        final long size;
        final long mtimeSec;
        final int flags;
        final String target;

        Item(String name, boolean dir, long size, long mtimeSec, int flags, String target) {
            this.name = name;
            this.dir = dir;
            this.size = size;
            this.mtimeSec = mtimeSec;
            this.flags = flags;
            this.target = target;
        }
    }

    static final class Page {
        final String path;
        final List<Item> items;
        /** Name of the last item when more follow (the cursor for the next call), else null. */
        final String next;

        Page(String path, List<Item> items, String next) {
            this.path = path;
            this.items = items;
            this.next = next;
        }
    }

    // ---------------------------------------------------------------------------------------------- failures

    /** Maps what java.nio throws to the backend's codes. The reason texts are strerror(3)'s, which Android's libcore keeps. */
    static Failure fail(IOException e) {
        String reason = e.getMessage() == null ? "" : e.getMessage();
        if (e instanceof NoSuchFileException) return new Failure("not_found", reason);
        if (e instanceof AccessDeniedException) return new Failure("permission", reason);
        if (e instanceof FileAlreadyExistsException) return new Failure("exists", reason);
        if (e instanceof DirectoryNotEmptyException) return new Failure("not_empty", reason);
        if (e instanceof NotDirectoryException) return new Failure("not_a_dir", reason);
        if (e instanceof AtomicMoveNotSupportedException) return new Failure("cross_device", reason);
        String lowered = reason.toLowerCase();
        if (lowered.contains("read-only file system")) return new Failure("read_only", reason);
        if (lowered.contains("no space left") || lowered.contains("quota")) return new Failure("no_space", reason);
        if (lowered.contains("cross-device") || lowered.contains("different file system")) return new Failure("cross_device", reason);
        if (lowered.contains("is a directory")) return new Failure("is_a_dir", reason);
        if (lowered.contains("not a directory")) return new Failure("not_a_dir", reason);
        if (lowered.contains("file name too long")) return new Failure("invalid_name", reason);
        if (lowered.contains("permission denied") || lowered.contains("operation not permitted")) return new Failure("permission", reason);
        if (lowered.contains("no such file")) return new Failure("not_found", reason);
        if (lowered.contains("file exists")) return new Failure("exists", reason);
        return new Failure("io", reason);
    }

    // ---------------------------------------------------------------------------------------------- reading

    /** One directory entry's facts; a link is described as a link, its target's kind tells whether it can be entered. */
    static Item stat(Path path) throws Failure {
        try {
            BasicFileAttributes own = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            return describe(path, own);
        } catch (IOException e) {
            throw fail(e);
        }
    }

    private static Item describe(Path path, BasicFileAttributes own) {
        Path leaf = path.getFileName();
        String name = leaf == null ? path.toString() : leaf.toString();
        int flags = name.startsWith(".") ? F_HIDDEN : 0;
        BasicFileAttributes shown = own;
        String target = null;
        if (own.isSymbolicLink()) {
            flags |= F_SYMLINK;
            try {
                target = Files.readSymbolicLink(path).toString();
            } catch (IOException ignored) {}
            try {
                shown = Files.readAttributes(path, BasicFileAttributes.class);          // the target's kind and size
            } catch (IOException dangling) {
                shown = own;
            }
        }
        boolean dir = shown.isDirectory();
        return new Item(name, dir, dir ? 0 : shown.size(), shown.lastModifiedTime().to(TimeUnit.SECONDS), flags, target);
    }

    // A listing is asked for page after page: the names of the folder are read and sorted once and reused for a moment.
    private static final long NAMES_TTL_MS = 3000;
    private static String cachedDir;
    private static long cachedStamp = -1;
    private static long cachedAt;
    private static List<String> cachedNames;

    private static synchronized List<String> sortedNames(Path dir) throws IOException {
        String key = dir.toString();
        long stamp = Files.getLastModifiedTime(dir).toMillis();
        long now = System.currentTimeMillis();
        if (key.equals(cachedDir) && stamp == cachedStamp && now - cachedAt < NAMES_TTL_MS && cachedNames != null) {
            return cachedNames;
        }
        List<String> names = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path child : stream) names.add(child.getFileName().toString());
        }
        Collections.sort(names);
        cachedDir = key;
        cachedStamp = stamp;
        cachedAt = now;
        cachedNames = names;
        return names;
    }

    /**
     * Up to {@code limit} entries of {@code dir}, in name order, starting after the entry named {@code after}
     * (null: from the top). The cursor is a NAME, not an offset: pages stay consistent while files appear or vanish.
     * An entry that disappears between the readdir and the stat is skipped, not an error.
     */
    static Page list(Path dir, String after, int limit) throws Failure {
        try {
            if (!Files.isDirectory(dir)) {
                throw new Failure(Files.exists(dir) ? "not_a_dir" : "not_found", dir.toString());
            }
            List<String> names = sortedNames(dir);
            int start = 0;
            if (after != null) {
                start = Collections.binarySearch(names, after);
                start = start >= 0 ? start + 1 : -start - 1;
            }
            List<Item> items = new ArrayList<>();
            int index = start;
            for (; index < names.size() && items.size() < limit; index++) {
                Path child = dir.resolve(names.get(index));
                try {
                    items.add(describe(child, Files.readAttributes(child, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)));
                } catch (NoSuchFileException vanished) {
                    // gone since the listing: skip it
                } catch (IOException unreadable) {
                    items.add(new Item(names.get(index), false, 0, 0, names.get(index).startsWith(".") ? F_HIDDEN : 0, null));
                }
            }
            String next = index < names.size() && !items.isEmpty() ? names.get(index - 1) : null;
            return new Page(dir.toString(), items, next);
        } catch (IOException e) {
            throw fail(e);
        }
    }

    // ---------------------------------------------------------------------------------------------- changing

    static void mkdir(Path path, boolean parents) throws Failure {
        try {
            if (parents) Files.createDirectories(path);
            else Files.createDirectory(path);
            forgetNames();
        } catch (IOException e) {
            throw fail(e);
        }
    }

    /**
     * An atomic rename inside one volume. Without {@code overwrite} an existing target is refused (checked first: rename(2)
     * itself would silently replace a file). Across volumes it FAILS with cross_device — never a silent copy of a big tree
     * inside the daemon; the backend then copies with progress and deletes.
     */
    static void rename(Path from, Path to, boolean overwrite) throws Failure {
        try {
            if (!overwrite && Files.exists(to, LinkOption.NOFOLLOW_LINKS)) {
                throw new Failure("exists", to.getFileName().toString());
            }
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
            forgetNames();
        } catch (IOException e) {
            throw fail(e);
        }
    }

    /** Removes a file, a link (never its target) or a whole tree; returns how many entries went. */
    static long delete(Path path) throws Failure {
        final long[] count = {0};
        try {
            Files.walkFileTree(path, new SimpleFileVisitor<Path>() {                       // no FOLLOW_LINKS: links are leaves
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.delete(file);
                    count[0]++;
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                    if (error != null) throw error;
                    Files.delete(dir);
                    count[0]++;
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw fail(e);
        } finally {
            forgetNames();
        }
        return count[0];
    }


    // ---------------------------------------------------------------------------------------------- volumes

    static final class Volume {
        final String path;
        final String kind;          // internal | removable | tmp
        final long total;
        final long free;

        Volume(String path, String kind, long total, long free) {
            this.path = path;
            this.kind = kind;
            this.total = total;
            this.free = free;
        }
    }

    /**
     * The storage the user can browse: the internal volume ({@code storage/emulated/0}), every other mounted volume
     * under {@code storage} (SD card, USB drive: {@code 1234-ABCD}) and the adb scratch folder. `self` and
     * `emulated` are views of the same data and never listed twice.
     */
    static List<Volume> volumes(Path storage, Path tmp) {
        List<Volume> out = new ArrayList<>();
        Path internal = storage.resolve("emulated").resolve("0");
        if (Files.isDirectory(internal)) out.add(volume(internal, "internal"));
        List<String> names = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(storage)) {
            for (Path child : stream) names.add(child.getFileName().toString());
        } catch (IOException ignored) {}
        Collections.sort(names);
        for (String name : names) {
            if (name.equals("emulated") || name.equals("self") || name.startsWith(".")) continue;
            Path mount = storage.resolve(name);
            if (Files.isDirectory(mount) && !Files.isSymbolicLink(mount)) out.add(volume(mount, "removable"));
        }
        if (Files.isDirectory(tmp)) out.add(volume(tmp, "tmp"));
        return out;
    }

    private static Volume volume(Path path, String kind) {
        java.io.File file = path.toFile();
        return new Volume(path.toString(), kind, file.getTotalSpace(), file.getUsableSpace());
    }

    /** Drops the cached folder names (tests, and after this process changed the folder itself). */
    static synchronized void forgetNames() {
        cachedDir = null;
        cachedNames = null;
    }
}
