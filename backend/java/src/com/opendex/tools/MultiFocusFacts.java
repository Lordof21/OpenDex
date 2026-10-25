package com.opendex.tools;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The pure text reader behind {@code audio_multi_focus} — no Android types, so it runs (and is tested) on a plain JVM.
 *
 * "Multi audio focus" (several apps playing at once) has a setter on the audio service but no getter: the only place
 * its live state is printed is the audio service's dump, as {@code Multi Audio Focus enabled :true}. Nothing is guessed:
 * a dump without that line is "unknown" (null), never a plausible-looking false.
 */
final class MultiFocusFacts {

    private static final Pattern FLAG = Pattern.compile("Multi Audio Focus enabled\\s*:\\s*(true|false)");

    private MultiFocusFacts() {}

    /** TRUE / FALSE when the dump says so; null when the line is missing (an OEM build that prints it differently). */
    static Boolean parseEnabled(String dump) {
        if (dump == null) return null;
        Matcher m = FLAG.matcher(dump);
        return m.find() ? Boolean.valueOf(m.group(1)) : null;
    }
}
